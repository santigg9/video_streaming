import { INPUT_CHANNEL, INPUT_FAST_CHANNEL } from './common.js';
import { modifierMaskOf, parseMessage } from './control-protocol.js';

const denyReasons = {
  agent: 'La otra computadora no tiene el agente de control conectado.',
  surface: 'Para controlar, la otra computadora tiene que compartir la pantalla completa, no una ventana.',
  denied: 'La otra computadora rechazó el pedido de control.',
};

const revokeReasons = {
  agent: 'Se perdió el agente de control de la otra computadora.',
};

// Captura el mouse y el teclado sobre el video y los manda al host.
export class RemoteInput {
  constructor({ frame, video, onChange, onChannelOpen }) {
    this.frame = frame;
    this.video = video;
    this.onChange = onChange;
    this.onChannelOpen = onChannelOpen;
    this.state = 'unavailable'; // unavailable | idle | requesting | active
    this.notice = '';
    this.channel = null;
    this.fastChannel = null;
    this.pendingMove = null;
    this.pendingWheel = { dx: 0, dy: 0 };
    this.frameRequest = 0;
    this.buttons = new Set();
    this.keys = new Set();
    this.bindEvents();
  }

  // ---------- Canales ----------

  attach(channel) {
    if (channel.label === INPUT_FAST_CHANNEL) {
      this.fastChannel = channel;
      return;
    }
    if (channel.label !== INPUT_CHANNEL) return;

    this.channel = channel;
    this.setState('unavailable');
    channel.addEventListener('open', () => {
      if (this.channel !== channel) return;
      this.setState('idle');
      this.onChannelOpen?.();
    });
    channel.addEventListener('close', () => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.clearLocalInput();
      this.setState('unavailable');
    });
    channel.addEventListener('message', (event) => this.handleMessage(parseMessage(event.data)));
    if (channel.readyState === 'open') {
      this.setState('idle');
      this.onChannelOpen?.();
    }
  }

  detach() {
    this.channel = null;
    this.fastChannel = null;
    this.clearLocalInput();
    this.setState('unavailable');
  }

  handleMessage(message) {
    if (!message) return;
    if (message.t === 'grant') {
      this.setState('active', '');
      this.frame.focus({ preventScroll: true });
    } else if (message.t === 'deny') {
      this.setState('idle', denyReasons[message.reason] || denyReasons.denied);
    } else if (message.t === 'revoke') {
      this.clearLocalInput();
      this.setState('idle', revokeReasons[message.reason] || 'La otra computadora quitó el control remoto.');
    }
  }

  // ---------- Acciones del usuario ----------

  toggle() {
    if (this.state === 'idle') {
      this.send({ t: 'req' });
      this.setState('requesting', '');
    } else if (this.state === 'active' || this.state === 'requesting') {
      this.releaseAll();
      this.send({ t: 'release' });
      this.setState('idle', '');
    }
  }

  setState(state, notice = this.notice) {
    this.state = state;
    this.notice = notice;
    this.frame.classList.toggle('controlling', state === 'active');
    this.onChange(state, notice);
  }

  get active() {
    return this.state === 'active';
  }

  // ---------- Envío ----------

  send(message, fast = false) {
    const channel = fast && this.fastChannel?.readyState === 'open' ? this.fastChannel : this.channel;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
  }

  scheduleFlush() {
    if (!this.frameRequest) this.frameRequest = requestAnimationFrame(() => this.flush());
  }

  flush() {
    this.frameRequest = 0;
    if (this.pendingMove) {
      this.send({ t: 'm', ...this.pendingMove }, true);
      this.pendingMove = null;
    }
    const { dx, dy } = this.pendingWheel;
    if (dx || dy) {
      this.send({ t: 'w', dx: Math.round(dx), dy: Math.round(dy) });
      this.pendingWheel = { dx: 0, dy: 0 };
    }
  }

  // Pide al agente que suelte todo, incluidos los modificadores que el sistema
  // pueda tener "trabados". Se manda siempre que haya control, aunque acá no
  // quede nada anotado: el problema puede estar del otro lado.
  releaseAll() {
    if (this.active || this.buttons.size || this.keys.size) this.send({ t: 'reset' });
    this.buttons.clear();
    this.keys.clear();
  }

  clearLocalInput() {
    this.buttons.clear();
    this.keys.clear();
    this.pendingMove = null;
    this.pendingWheel = { dx: 0, dy: 0 };
  }

  // ---------- Coordenadas ----------

  // El video usa object-fit: contain, así que puede tener franjas negras.
  // Calcula el rectángulo donde realmente se dibuja la imagen.
  contentRect() {
    const { videoWidth, videoHeight } = this.video;
    if (!videoWidth || !videoHeight) return null;
    const box = this.video.getBoundingClientRect();
    const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  }

  position(event) {
    const rect = this.contentRect();
    if (!rect) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const clamp = (value) => Math.min(1, Math.max(0, value));
    return {
      inside: x >= 0 && x <= 1 && y >= 0 && y <= 1,
      x: Number(clamp(x).toFixed(5)),
      y: Number(clamp(y).toFixed(5)),
    };
  }

  // ---------- Eventos del navegador ----------

  bindEvents() {
    const frame = this.frame;

    frame.addEventListener('pointerdown', (event) => {
      if (this.active && event.pointerType === 'mouse') frame.setPointerCapture(event.pointerId);
    });

    frame.addEventListener('mousemove', (event) => {
      if (!this.active) return;
      const point = this.position(event);
      if (!point || (!point.inside && !this.buttons.size)) return;
      this.pendingMove = { x: point.x, y: point.y };
      this.scheduleFlush();
    });

    frame.addEventListener('mousedown', (event) => {
      if (!this.active || event.button > 2) return;
      const point = this.position(event);
      if (!point?.inside) return;
      event.preventDefault();
      frame.focus({ preventScroll: true });
      this.flush();
      this.buttons.add(event.button);
      this.send({ t: 'd', b: event.button, x: point.x, y: point.y, n: event.detail || 1, k: modifierMaskOf(event) });
    });

    frame.addEventListener('mouseup', (event) => {
      if (!this.buttons.has(event.button)) return;
      event.preventDefault();
      const point = this.position(event);
      this.flush();
      this.buttons.delete(event.button);
      this.send({ t: 'u', b: event.button, x: point?.x ?? 0, y: point?.y ?? 0, k: modifierMaskOf(event) });
    });

    frame.addEventListener('contextmenu', (event) => {
      if (this.active) event.preventDefault();
    });

    frame.addEventListener('auxclick', (event) => {
      if (this.active) event.preventDefault();
    });

    frame.addEventListener('wheel', (event) => {
      if (!this.active) return;
      event.preventDefault();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
      this.pendingWheel.dx += event.deltaX * factor;
      this.pendingWheel.dy += event.deltaY * factor;
      this.scheduleFlush();
    }, { passive: false });

    frame.addEventListener('keydown', (event) => {
      if (!this.active || event.isComposing || !event.code) return;
      event.preventDefault();
      this.flush();
      this.keys.add(event.code);
      this.send({ t: 'kd', c: event.code, k: modifierMaskOf(event) });
    });

    // El "soltar" se escucha en toda la ventana: si el foco se movió mientras la
    // tecla estaba apretada (por ejemplo con un atajo del navegador), igual llega.
    window.addEventListener('keyup', (event) => {
      if (!this.keys.has(event.code)) return;
      if (this.active) event.preventDefault();
      this.flush();
      this.keys.delete(event.code);
      this.send({ t: 'ku', c: event.code, k: modifierMaskOf(event) });
    }, true);

    // Si el video pierde el foco, nada debe quedar apretado en la otra computadora.
    frame.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }
}
