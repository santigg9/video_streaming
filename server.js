import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuth, safeNext } from './auth.js';

const port = Number(process.env.PORT || 4173);
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const rooms = new Map();

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function iceServers() {
  const servers = [];
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.cloudflare.com:3478')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (stunUrls.length) servers.push({ urls: stunUrls });

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  return servers;
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function roomFor(id) {
  if (!rooms.has(id)) rooms.set(id, { host: null, viewer: null });
  return rooms.get(id);
}

function leaveRoom(socket) {
  const { roomId, role } = socket;
  const room = rooms.get(roomId);
  if (!room || room[role] !== socket) return;

  room[role] = null;
  const peerRole = role === 'host' ? 'viewer' : 'host';
  send(room[peerRole], { type: 'peer-left', role });
  if (!room.host && !room.viewer) rooms.delete(roomId);
}

const auth = createAuth();
const publicFiles = new Set(['/styles.css', '/favicon.svg']);
const privateFiles = new Set([
  '/index.html', '/watch.html',
  '/common.js', '/host.js', '/viewer.js', '/control-protocol.js', '/agent-link.js', '/remote-input.js',
]);
const baseHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), display-capture=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function redirect(response, location, extraHeaders = {}) {
  response.writeHead(303, { ...baseHeaders, ...extraHeaders, Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

function readBody(request, limit = 2048) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Cuerpo demasiado grande'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function renderLogin(response, { next, error, status = 200 }) {
  const messages = {
    invalid: 'Usuario o contraseña incorrectos.',
    limited: 'Demasiados intentos. Esperá unos minutos y volvé a probar.',
  };
  const template = await readFile(path.join(publicDirectory, 'login.html'), 'utf8');
  const html = template
    .replace('{{next}}', escapeHtml(next))
    .replace('{{error}}', error ? `<p class="error-message" role="alert">${escapeHtml(messages[error])}</p>` : '');
  response.writeHead(status, {
    ...baseHeaders,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

async function handleLogin(request, response, url) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const next = safeNext(url.searchParams.get('next'));
    if (auth.isAuthenticated(request)) {
      redirect(response, next);
      return;
    }
    await renderLogin(response, { next, error: url.searchParams.get('error') });
    return;
  }

  if (request.method !== 'POST') {
    response.writeHead(405, { ...baseHeaders, Allow: 'GET, POST' });
    response.end();
    return;
  }

  let form;
  try {
    form = new URLSearchParams(await readBody(request));
  } catch {
    response.writeHead(413, baseHeaders);
    response.end();
    return;
  }

  const next = safeNext(form.get('next'));
  const back = `/login?next=${encodeURIComponent(next)}`;
  if (auth.isRateLimited(request)) {
    redirect(response, `${back}&error=limited`);
    return;
  }
  if (!auth.checkCredentials(form.get('username') || '', form.get('password') || '')) {
    auth.recordFailure(request);
    // Una pequeña espera hace más lento probar contraseñas por fuerza bruta.
    await new Promise((resolve) => setTimeout(resolve, 600));
    redirect(response, `${back}&error=invalid`);
    return;
  }

  auth.recordSuccess(request);
  redirect(response, next, { 'Set-Cookie': auth.sessionCookie(request) });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/healthz') {
      response.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (auth.misconfigured) {
      response.writeHead(503, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Servicio no configurado: faltan AUTH_USERNAME y AUTH_PASSWORD en el servidor.');
      return;
    }

    if (url.pathname === '/login') {
      await handleLogin(request, response, url);
      return;
    }

    if (url.pathname === '/logout') {
      redirect(response, '/login', { 'Set-Cookie': auth.clearCookie(request) });
      return;
    }

    const isViewer = /^\/watch\/[A-Za-z0-9_-]{8,64}\/?$/.test(url.pathname);
    const pathname = isViewer ? '/watch.html' : url.pathname === '/' ? '/index.html' : url.pathname;
    const isPublic = publicFiles.has(pathname);

    if (!isPublic && !auth.isAuthenticated(request)) {
      if (url.pathname.startsWith('/api/')) {
        response.writeHead(401, { ...baseHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'No autenticado' }));
      } else {
        redirect(response, `/login?next=${encodeURIComponent(url.pathname)}`);
      }
      return;
    }

    if (url.pathname === '/api/config') {
      response.writeHead(200, {
        ...baseHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({ iceServers: iceServers() }));
      return;
    }

    if ((!isPublic && !privateFiles.has(pathname)) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, baseHeaders);
      response.end('No encontrado');
      return;
    }

    const file = await readFile(path.join(publicDirectory, pathname));
    response.writeHead(200, {
      ...baseHeaders,
      'Content-Type': contentTypes[path.extname(pathname)],
      'Cache-Control': isPublic ? 'no-cache' : 'no-cache, private',
    });
    response.end(request.method === 'HEAD' ? undefined : file);
  } catch {
    if (!response.headersSent) {
      response.writeHead(404, baseHeaders);
      response.end('No encontrado');
    }
  }
});

// La señalización también exige sesión, y solo desde este mismo sitio.
function sameOrigin(request) {
  const { origin, host } = request.headers;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const webSockets = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  verifyClient: ({ req }) => !auth.misconfigured && sameOrigin(req) && auth.isAuthenticated(req),
});

webSockets.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      send(socket, { type: 'error', message: 'Mensaje inválido.' });
      return;
    }

    if (message.type === 'join') {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(message.room) || !['host', 'viewer'].includes(message.role)) {
        send(socket, { type: 'error', message: 'Sala inválida.' });
        return;
      }

      leaveRoom(socket);
      const room = roomFor(message.room);
      const previous = room[message.role];
      if (previous && previous !== socket) previous.close(1000, 'Sesión reemplazada');
      room[message.role] = socket;
      socket.roomId = message.room;
      socket.role = message.role;

      const peerRole = message.role === 'host' ? 'viewer' : 'host';
      send(socket, { type: 'joined', role: message.role, peerPresent: Boolean(room[peerRole]) });
      send(room[peerRole], { type: 'peer-joined', role: message.role });
      return;
    }

    const room = rooms.get(socket.roomId);
    if (!room || room[socket.role] !== socket) {
      send(socket, { type: 'error', message: 'Primero debés unirte a una sala.' });
      return;
    }

    if (!['description', 'candidate', 'connection-settings', 'stream-stopped'].includes(message.type)) return;
    const peerRole = socket.role === 'host' ? 'viewer' : 'host';
    send(room[peerRole], message);
  });

  socket.on('close', () => leaveRoom(socket));
  socket.on('error', () => leaveRoom(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of webSockets.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

webSockets.on('close', () => clearInterval(heartbeat));
server.listen(port, '0.0.0.0', () => {
  console.log(`Puente disponible en http://localhost:${port}`);
});
