// Agente local de Puente para macOS.
//
// Escucha SOLO en 127.0.0.1. La página del host (Chrome en este mismo Mac) se
// conecta acá, se autentica con un token y reenvía los eventos de mouse y
// teclado que llegan del equipo remoto por WebRTC. El agente los aplica con
// nut-js, que necesita el permiso de Accesibilidad de macOS.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { keyFor, modifierFlags } from './keymap.js';

const port = Number(process.env.PUENTE_AGENT_PORT || 47800);
const allowedOrigins = new Set(
  (process.env.PUENTE_ORIGINS || 'https://video.agilequest.dev,http://localhost:4173,http://127.0.0.1:4173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
);
const scrollScale = Number(process.env.PUENTE_SCROLL_SCALE || 1);
const dryRun = process.env.PUENTE_DRY_RUN === '1';
const tokenFile = path.join(os.homedir(), '.puente-agent', 'token');

// ---------- Token ----------

async function loadToken() {
  if (process.env.PUENTE_AGENT_TOKEN) return process.env.PUENTE_AGENT_TOKEN.trim();
  try {
    const saved = (await readFile(tokenFile, 'utf8')).trim();
    if (saved.length >= 32) return saved;
  } catch {
    // Primera ejecución: se genera abajo.
  }
  const token = randomBytes(24).toString('base64url');
  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

function sameToken(expected, received) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Permiso de Accesibilidad ----------

const require = createRequire(import.meta.url);
let macPermissions = null;
if (process.platform === 'darwin') {
  try {
    macPermissions = require('@nut-tree-fork/node-mac-permissions');
  } catch {
    macPermissions = null;
  }
}

function accessibilityStatus() {
  if (dryRun || process.platform !== 'darwin') return 'not-required';
  if (!macPermissions) return 'unknown';
  try {
    return macPermissions.getAuthStatus('accessibility') === 'authorized' ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

// ---------- Backend de entrada ----------

async function createBackend() {
  if (dryRun) {
    const log = (...args) => console.log('[simulado]', ...args);
    return {
      Key: new Proxy({}, { get: (_, name) => (typeof name === 'string' ? name : undefined) }),
      async screenSize() { return { width: 1440, height: 900 }; },
      async move(x, y) { log('mover', x, y); },
      async press(button) { log('presionar botón', button); },
      async release(button) { log('soltar botón', button); },
      async doubleClick(button) { log('doble clic', button); },
      async scroll(dx, dy) { log('scroll', dx, dy); },
      async keyDown(keys) { log('tecla abajo', keys.join('+')); },
      async keyUp(keys) { log('tecla arriba', keys.join('+')); },
    };
  }

  const { mouse, keyboard, screen, Button, Key, Point } = await import('@nut-tree-fork/nut-js');
  mouse.config.autoDelayMs = 0;
  mouse.config.mouseSpeed = 100000;
  keyboard.config.autoDelayMs = 0;
  const buttons = [Button.LEFT, Button.MIDDLE, Button.RIGHT];

  return {
    Key,
    async screenSize() {
      return { width: await screen.width(), height: await screen.height() };
    },
    async move(x, y) { await mouse.setPosition(new Point(x, y)); },
    async press(button) { await mouse.pressButton(buttons[button]); },
    async release(button) { await mouse.releaseButton(buttons[button]); },
    async doubleClick(button) { await mouse.doubleClick(buttons[button]); },
    async scroll(dx, dy) {
      if (dy > 0) await mouse.scrollDown(dy);
      else if (dy < 0) await mouse.scrollUp(-dy);
      if (dx > 0) await mouse.scrollRight(dx);
      else if (dx < 0) await mouse.scrollLeft(-dx);
    },
    async keyDown(keys) { await keyboard.pressKey(...keys); },
    async keyUp(keys) { await keyboard.releaseKey(...keys); },
  };
}

// ---------- Estado de la sesión ----------

class InputSession {
  constructor(backend) {
    this.backend = backend;
    this.chain = Promise.resolve();
    this.pendingMove = null;
    this.pressedKeys = new Map();
    this.pressedButtons = new Set();
    this.skipRelease = new Set();
    this.screen = { width: 0, height: 0 };
  }

  async refreshScreen() {
    this.screen = await this.backend.screenSize();
    return this.screen;
  }

  // Todas las acciones se ejecutan en orden. Los movimientos consecutivos se
  // fusionan: si todavía no se aplicó uno, se reemplaza por el más nuevo.
  enqueue(task) {
    this.pendingMove = null;
    this.chain = this.chain.then(task).catch((error) => console.error('Error al aplicar un evento:', error.message));
  }

  queueMove(x, y) {
    if (this.pendingMove) {
      this.pendingMove.x = x;
      this.pendingMove.y = y;
      return;
    }
    const slot = { x, y };
    this.pendingMove = slot;
    this.chain = this.chain
      .then(() => {
        if (this.pendingMove === slot) this.pendingMove = null;
        return this.backend.move(...this.toScreen(slot.x, slot.y));
      })
      .catch((error) => console.error('Error al mover el mouse:', error.message));
  }

  toScreen(x, y) {
    const { width, height } = this.screen;
    return [Math.round(x * Math.max(width - 1, 0)), Math.round(y * Math.max(height - 1, 0))];
  }

  heldModifiers(exceptCode) {
    const keys = new Set();
    for (const code of this.pressedKeys.keys()) {
      if (code !== exceptCode && modifierFlags[code]) keys.add(this.backend.Key[modifierFlags[code]]);
    }
    return [...keys];
  }

  handle(event) {
    switch (event.t) {
      case 'm':
        this.queueMove(event.x, event.y);
        break;
      case 'd':
        this.enqueue(async () => {
          await this.backend.move(...this.toScreen(event.x, event.y));
          if (event.n >= 2 && event.b === 0) {
            // macOS reconoce el doble clic solo si el evento lo marca como tal.
            await this.backend.doubleClick(event.b);
            this.skipRelease.add(event.b);
            return;
          }
          this.pressedButtons.add(event.b);
          await this.backend.press(event.b);
        });
        break;
      case 'u':
        this.enqueue(async () => {
          await this.backend.move(...this.toScreen(event.x, event.y));
          if (this.skipRelease.delete(event.b)) return;
          if (!this.pressedButtons.delete(event.b)) return;
          await this.backend.release(event.b);
        });
        break;
      case 'w':
        this.enqueue(() => this.backend.scroll(Math.round(event.dx * scrollScale), Math.round(event.dy * scrollScale)));
        break;
      case 'kd': {
        const key = keyFor(this.backend.Key, event.c);
        if (key === undefined) return;
        this.enqueue(async () => {
          const modifiers = this.heldModifiers(event.c);
          this.pressedKeys.set(event.c, key);
          await this.backend.keyDown([...modifiers, key]);
        });
        break;
      }
      case 'ku':
        this.enqueue(async () => {
          const key = this.pressedKeys.get(event.c);
          if (key === undefined) return;
          this.pressedKeys.delete(event.c);
          await this.backend.keyUp([...this.heldModifiers(event.c), key]);
        });
        break;
      case 'reset':
        this.releaseAll();
        break;
      default:
        break;
    }
  }

  // Suelta todo lo que haya quedado apretado: al perder la conexión, al quitar
  // el control o cuando el navegador remoto pierde el foco.
  releaseAll() {
    this.enqueue(async () => {
      for (const [code, key] of [...this.pressedKeys].reverse()) {
        this.pressedKeys.delete(code);
        await this.backend.keyUp([key]);
      }
      for (const button of this.pressedButtons) await this.backend.release(button);
      this.pressedButtons.clear();
      this.skipRelease.clear();
    });
  }
}

const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const button = (value) => value === 0 || value === 1 || value === 2;
const delta = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000;
const code = (value) => typeof value === 'string' && /^[A-Za-z0-9]{1,24}$/.test(value);

function isValid(event) {
  if (!event || typeof event !== 'object') return false;
  switch (event.t) {
    case 'm': return unit(event.x) && unit(event.y);
    case 'd': case 'u': return button(event.b) && unit(event.x) && unit(event.y);
    case 'w': return delta(event.dx) && delta(event.dy);
    case 'kd': case 'ku': return code(event.c);
    case 'reset': return true;
    default: return false;
  }
}

// ---------- Servidor ----------

const token = await loadToken();
const backend = await createBackend();
const session = new InputSession(backend);
let activeSocket = null;

if (accessibilityStatus() === 'denied') {
  macPermissions?.askForAccessibilityAccess?.();
}

const server = new WebSocketServer({
  host: '127.0.0.1',
  port,
  maxPayload: 4096,
  verifyClient: ({ origin }) => {
    const allowed = allowedOrigins.has(origin);
    if (!allowed) console.warn(`Conexión rechazada desde un origen no permitido: ${origin || '(sin origen)'}`);
    return allowed;
  },
});

server.on('connection', (socket, request) => {
  let authenticated = false;
  const authTimer = setTimeout(() => socket.close(4001, 'Falta autenticación'), 5000);

  socket.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!authenticated) {
      if (message?.type !== 'auth' || !sameToken(token, message.token)) {
        socket.close(4001, 'Token inválido');
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);

      if (activeSocket && activeSocket !== socket) {
        session.releaseAll();
        activeSocket.close(4000, 'Otra pestaña tomó el control del agente');
      }
      activeSocket = socket;

      const screen = await session.refreshScreen().catch(() => session.screen);
      const accessibility = accessibilityStatus();
      socket.send(JSON.stringify({ type: 'ready', screen, accessibility }));
      console.log(`Página conectada desde ${request.headers.origin} · pantalla ${screen.width}×${screen.height} · accesibilidad: ${accessibility}`);
      return;
    }

    if (socket !== activeSocket || !isValid(message)) return;
    session.handle(message);
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (socket === activeSocket) {
      activeSocket = null;
      session.releaseAll();
      console.log('Página desconectada. Se soltaron todas las teclas y botones.');
    }
  });
});

server.on('listening', () => {
  console.log('');
  console.log(`Agente de Puente escuchando en ws://127.0.0.1:${port}${dryRun ? ' (modo simulado)' : ''}`);
  console.log(`Orígenes permitidos: ${[...allowedOrigins].join(', ')}`);
  console.log('');
  console.log('Token para pegar en la página del host:');
  console.log(`  ${token}`);
  if (!process.env.PUENTE_AGENT_TOKEN) console.log(`(guardado en ${tokenFile})`);
  console.log('');
  if (accessibilityStatus() === 'denied') {
    console.log('⚠  Falta el permiso de Accesibilidad. Activá esta terminal en');
    console.log('   Ajustes del Sistema → Privacidad y seguridad → Accesibilidad y volvé a iniciar el agente.');
    console.log('');
  }
  console.log('Ctrl+C para detenerlo.');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`El puerto ${port} ya está en uso. ¿Hay otro agente abierto? Podés cambiarlo con PUENTE_AGENT_PORT.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

function shutdown() {
  session.releaseAll();
  session.chain.finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
