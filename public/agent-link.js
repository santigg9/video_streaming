import { AGENT_URL } from './control-protocol.js';

// Conexión entre la página del host y el agente local que corre en el Mac.
// Reintenta sola mientras haya un token cargado, por si el agente se reinicia.
export class AgentLink {
  constructor({ onStatus }) {
    this.onStatus = onStatus;
    this.token = '';
    this.socket = null;
    this.ready = false;
    this.info = null;
    this.retryTimer = null;
  }

  connect(token) {
    this.token = token.trim();
    this.stopRetry();
    this.closeSocket();
    if (!this.token) {
      this.setStatus('idle');
      return;
    }
    this.open();
  }

  open() {
    this.setStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(AGENT_URL);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token: this.token }));
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        this.ready = true;
        this.info = { screen: message.screen, accessibility: message.accessibility };
        this.setStatus('ready');
      }
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasReady = this.ready;
      this.ready = false;
      this.info = null;
      if (event.code === 4001) {
        this.setStatus('unauthorized');
        return;
      }
      if (event.code === 4000) {
        this.setStatus('replaced');
        return;
      }
      this.setStatus(wasReady ? 'lost' : 'unreachable');
      this.scheduleRetry();
    });
  }

  send(event) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  scheduleRetry() {
    this.stopRetry();
    if (this.token) this.retryTimer = setTimeout(() => this.open(), 3000);
  }

  stopRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.info = null;
    socket?.close();
  }

  disconnect() {
    this.token = '';
    this.stopRetry();
    this.closeSocket();
    this.setStatus('idle');
  }

  setStatus(status) {
    this.onStatus(status, this.info);
  }
}
