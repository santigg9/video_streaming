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
const releaseButton = document.querySelector('#release-button');
const swapButton = document.querySelector('#swap-button');
const SWAP_KEY = 'puente-swap-ctrl-cmd';
const soundButton = document.querySelector('#sound-button');
const soundLabel = soundButton.querySelector('span');
const micButton = document.querySelector('#mic-button');
const micLabel = micButton.querySelector('span');
let micTrack = null;
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
  soundButton.disabled = false;
  micButton.disabled = false;
  setStatus('Transmisión en vivo', 'connected');
});

const remoteInput = new RemoteInput({
  frame,
  video,
  onChannelOpen: () => remoteInput.send({ t: 'mic', on: Boolean(micTrack) }),
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
    releaseButton.hidden = state !== 'active';
    swapButton.hidden = state !== 'active';
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

// ---------- Audio ----------

function renderAudioButtons() {
  soundLabel.textContent = video.muted ? 'Activar sonido' : 'Silenciar';
  soundButton.classList.toggle('active', !video.muted);
  micLabel.textContent = micTrack ? 'Apagar micrófono' : 'Activar micrófono';
  micButton.classList.toggle('live', Boolean(micTrack));
}

// Los navegadores solo reproducen audio después de un clic: por eso el video
// arranca silenciado y este botón lo activa.
soundButton.addEventListener('click', () => {
  video.muted = !video.muted;
  video.play().catch(() => {});
  renderAudioButtons();
});

async function stopMicrophone() {
  micTrack?.stop();
  micTrack = null;
  await peer.setOutgoingAudio(null).catch(() => {});
  remoteInput.send({ t: 'mic', on: false });
  renderAudioButtons();
}

micButton.addEventListener('click', async () => {
  if (micTrack) {
    await stopMicrophone();
    return;
  }
  micButton.disabled = true;
  try {
    // Voz: con cancelación de eco, para que lo que suena en tus parlantes no
    // vuelva a la reunión. Con auriculares funciona todavía mejor.
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micTrack = media.getAudioTracks()[0];
    micTrack.addEventListener('ended', () => stopMicrophone());
    await peer.setOutgoingAudio(micTrack);
    remoteInput.send({ t: 'mic', on: true });
    note.textContent = 'Micrófono activo: la otra computadora puede escucharte si eligió dónde reproducir tu voz.';
  } catch {
    note.textContent = 'No se pudo usar el micrófono. Revisá el permiso del navegador.';
  } finally {
    micButton.disabled = false;
    renderAudioButtons();
  }
});
function renderSwap() {
  swapButton.setAttribute('aria-pressed', String(remoteInput.swapCtrlCmd));
  swapButton.classList.toggle('active', remoteInput.swapCtrlCmd);
  swapButton.querySelector('span').textContent = remoteInput.swapCtrlCmd ? 'Ctrl → Cmd: sí' : 'Ctrl → Cmd: no';
}

try {
  remoteInput.setSwapCtrlCmd(localStorage.getItem(SWAP_KEY) === '1');
} catch {
  // Sin almacenamiento: queda desactivado.
}
renderSwap();

swapButton.addEventListener('click', () => {
  remoteInput.setSwapCtrlCmd(!remoteInput.swapCtrlCmd);
  try {
    localStorage.setItem(SWAP_KEY, remoteInput.swapCtrlCmd ? '1' : '0');
  } catch {
    // Se mantiene solo mientras la página esté abierta.
  }
  renderSwap();
  note.textContent = remoteInput.swapCtrlCmd
    ? 'Ctrl de tu teclado ahora funciona como Cmd en el Mac (Ctrl+C copia, Ctrl+V pega).'
    : 'Ctrl vuelve a ser Control en el Mac.';
  frame.focus({ preventScroll: true });
});

releaseButton.addEventListener('click', () => {
  remoteInput.releaseAll();
  note.textContent = 'Se soltaron todas las teclas y botones en la otra computadora.';
});

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
