import { Signaling, PeerConnection, ConnectionMonitor } from './common.js';
import { RemoteInput } from './remote-input.js';

const room = location.pathname.split('/').filter(Boolean).pop();
const video = document.querySelector('#remote-video');
const frame = document.querySelector('#video-frame');
const message = document.querySelector('#viewer-message');
const title = document.querySelector('#message-title');
const detail = document.querySelector('#message-detail');
const status = document.querySelector('#viewer-status');
const dot = document.querySelector('#viewer-dot');
const fullscreen = document.querySelector('#fullscreen-button');
const routeSummary = document.querySelector('#viewer-route-summary');
const controlButton = document.querySelector('#control-button');
const controlLabel = controlButton.querySelector('span');
const note = document.querySelector('#viewer-note');
const defaultNote = note.textContent;

let signaling;
let peer;
let monitor;
let hostPresent = false;

function setStatus(text, state = 'waiting') {
  status.textContent = text;
  dot.className = `status-dot ${state}`;
}

function renderMetrics(metrics) {
  const values = {
    state: '–', route: '–', protocol: '–', resolution: '–', fps: '–', bitrate: '–',
    latency: '–', loss: '–', jitter: '–',
  };

  if (metrics) {
    values.state = 'Conectado';
    values.route = metrics.route;
    values.protocol = metrics.protocol;
    values.resolution = metrics.resolution;
    values.fps = typeof metrics.fps === 'number' ? `${Math.round(metrics.fps)} FPS` : '–';
    values.bitrate = metrics.bitrate > 0 ? `${(metrics.bitrate / 1000).toFixed(2)} Mbps` : 'Midiendo…';
    values.latency = typeof metrics.latency === 'number' ? `${Math.round(metrics.latency * 1000)} ms` : '–';
    values.loss = typeof metrics.lossPercent === 'number'
      ? `${metrics.lossPercent.toFixed(2)}% · ${metrics.lost} paquetes`
      : `${metrics.lost} paquetes`;
    values.jitter = typeof metrics.jitter === 'number' ? `${(metrics.jitter * 1000).toFixed(1)} ms` : '–';
  }

  for (const element of document.querySelectorAll('[data-metric]')) {
    element.textContent = values[element.dataset.metric];
  }
  routeSummary.textContent = metrics ? `${metrics.route} · ${metrics.protocol}` : 'Sin datos';
}

function showMessage(heading, text) {
  title.textContent = heading;
  detail.textContent = text;
  message.hidden = false;
  fullscreen.disabled = true;
}

function handlePeerState(state) {
  if (state === 'connected') {
    setStatus('Conectado', 'connected');
    monitor.update();
  } else if (state === 'failed') {
    setStatus('Problemas de conexión', 'error');
    const text = peer.transport === 'relay'
      ? 'No hay una ruta TURN disponible. Revisá la configuración del servidor o elegí otro modo en la computadora que comparte.'
      : 'Estamos reintentando. También podés probar otro protocolo desde la computadora que comparte.';
    showMessage('No pudimos establecer la conexión', text);
  } else if (state === 'disconnected' && hostPresent) {
    setStatus('Reconectando', 'error');
  }
}

async function preparePeer() {
  try {
    await peer.create();
  } catch {
    setStatus('No se pudo preparar la conexión', 'error');
  }
}

video.addEventListener('playing', () => {
  message.hidden = true;
  fullscreen.disabled = false;
  setStatus('Transmisión en vivo', 'connected');
});

const remoteInput = new RemoteInput({
  frame,
  video,
  onChange(state, notice) {
    const labels = {
      unavailable: 'Pedir control',
      idle: 'Pedir control',
      requesting: 'Esperando permiso…',
      active: 'Soltar control',
    };
    controlLabel.textContent = labels[state];
    controlButton.disabled = state === 'unavailable';
    controlButton.classList.toggle('active', state === 'active');
    note.textContent = notice
      || (state === 'active' ? 'Estás controlando la otra computadora. Hacé clic fuera del video para dejar de enviar el teclado.' : defaultNote);
    note.classList.toggle('notice', Boolean(notice));
  },
});

peer = new PeerConnection('viewer', null, {
  onTrack(remoteStream) {
    video.srcObject = remoteStream;
  },
  onState: handlePeerState,
  onDataChannel: (channel) => remoteInput.attach(channel),
});
monitor = new ConnectionMonitor(() => peer?.peer, 'viewer', renderMetrics);
monitor.start();

signaling = new Signaling(room, 'viewer', {
  onStatus(connectionStatus) {
    if (connectionStatus === 'reconnecting') {
      setStatus('Reconectando', 'error');
      showMessage('Se interrumpió la conexión', 'Vamos a reconectarnos automáticamente. No hace falta cerrar esta página.');
    }
  },
  async onMessage(incoming) {
    if (incoming.type === 'joined') {
      hostPresent = incoming.peerPresent;
      await preparePeer();
      if (!hostPresent) {
        showMessage('La otra computadora todavía no está conectada', 'Dejá esta página abierta. La transmisión comenzará cuando quien comparte esté listo.');
      }
    } else if (incoming.type === 'connection-settings') {
      peer.setTransport(incoming.transport);
      renderMetrics(null);
      await preparePeer();
      setStatus('Conectando con la otra computadora');
    } else if (incoming.type === 'peer-joined' && incoming.role === 'host') {
      hostPresent = true;
      await preparePeer();
      setStatus('Conectando con la otra computadora');
    } else if (incoming.type === 'peer-left' && incoming.role === 'host') {
      if (!hostPresent) return;
      hostPresent = false;
      remoteInput.detach();
      peer.close();
      video.srcObject = null;
      renderMetrics(null);
      setStatus('Esperando a la otra computadora');
      showMessage('La transmisión se detuvo', 'Si la otra computadora vuelve a compartir el mismo enlace, la pantalla aparecerá acá.');
    } else if (incoming.type === 'stream-stopped') {
      hostPresent = false;
      remoteInput.detach();
      renderMetrics(null);
      peer.close();
      video.srcObject = null;
      setStatus('Transmisión finalizada');
      showMessage('Se dejó de compartir la pantalla', 'Ya no hay video en esta sala. Podés cerrar la página.');
    } else {
      await peer.receive(incoming);
    }
  },
});
peer.signaling = signaling;
signaling.connect();

controlButton.addEventListener('click', () => remoteInput.toggle());

// En pantalla completa, Keyboard Lock (Chrome/Edge) deja pasar a la otra computadora atajos
// que el navegador normalmente se queda, como Esc o Cmd+Tab.
document.addEventListener('fullscreenchange', async () => {
  try {
    if (document.fullscreenElement && remoteInput.active) await navigator.keyboard?.lock?.();
    else navigator.keyboard?.unlock?.();
  } catch {
    // Sin Keyboard Lock: algunos atajos los sigue manejando el navegador.
  }
});

fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await frame.requestFullscreen();
  } catch {
    setStatus('El navegador no permitió pantalla completa', 'error');
  }
});
