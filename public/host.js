import { Signaling, PeerConnection, ConnectionMonitor } from './common.js';

const qualities = {
  high: { width: 1920, height: 1080, fps: 30, bitrate: 4_000_000, label: '1080p, 30 FPS y 4 Mbps' },
  medium: { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, label: '720p, 30 FPS y 2,5 Mbps' },
  low: { width: 960, height: 540, fps: 24, bitrate: 1_200_000, label: '540p, 24 FPS y 1,2 Mbps' },
  minimum: { width: 640, height: 360, fps: 15, bitrate: 600_000, label: '360p, 15 FPS y 600 Kbps' },
};

const elements = {
  welcome: document.querySelector('#welcome'),
  sharing: document.querySelector('#sharing'),
  start: document.querySelector('#start-button'),
  stop: document.querySelector('#stop-button'),
  error: document.querySelector('#start-error'),
  video: document.querySelector('#local-video'),
  link: document.querySelector('#share-link'),
  copy: document.querySelector('#copy-button'),
  copyFeedback: document.querySelector('#copy-feedback'),
  status: document.querySelector('#connection-status'),
  dot: document.querySelector('#connection-dot'),
  quality: document.querySelector('#quality'),
  qualityFeedback: document.querySelector('#quality-feedback'),
  transport: document.querySelector('#transport'),
  retry: document.querySelector('#retry-button'),
  routeSummary: document.querySelector('#host-route-summary'),
};

let stream;
let signaling;
let peer;
let monitor;
let room;
let viewerPresent = false;
let qualityRevision = 0;

function setStatus(text, state = 'waiting') {
  elements.status.textContent = text;
  elements.dot.className = `status-dot ${state}`;
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function renderMetrics(metrics) {
  const values = {
    state: '–', route: '–', protocol: '–', resolution: '–', fps: '–', bitrate: '–',
    latency: '–', loss: '–', jitter: '–', limitation: '–',
  };

  if (metrics) {
    const limitations = { none: 'Sin límites', bandwidth: 'Ancho de banda', cpu: 'Procesador', other: 'Otro' };
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
    values.limitation = limitations[metrics.limitation] || 'No informado';
  }

  for (const element of elements.sharing.querySelectorAll('[data-metric]')) {
    element.textContent = values[element.dataset.metric];
  }
  elements.routeSummary.textContent = metrics ? `${metrics.route} · ${metrics.protocol}` : 'Sin datos';
}

async function applyQuality(connection = peer?.peer) {
  const quality = qualities[elements.quality.value];
  const revision = ++qualityRevision;
  const track = stream?.getVideoTracks()[0];
  if (!track) return;

  try {
    await track.applyConstraints({
      width: { ideal: quality.width, max: quality.width },
      height: { ideal: quality.height, max: quality.height },
      frameRate: { ideal: quality.fps, max: quality.fps },
    });

    if (revision !== qualityRevision) return;
    if (connection && connection === peer?.peer && connection.connectionState === 'connected') {
      const sender = connection.getSenders().find((item) => item.track === track);
      if (sender) {
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings.length ? parameters.encodings : [{}];
        parameters.encodings[0].maxBitrate = quality.bitrate;
        parameters.encodings[0].maxFramerate = quality.fps;
        await sender.setParameters(parameters);
      }
    }
    if (revision !== qualityRevision) return;
    elements.qualityFeedback.textContent = `Límite aplicado: ${quality.label}.`;
  } catch {
    if (revision === qualityRevision) {
      elements.qualityFeedback.textContent = 'El navegador no pudo aplicar ese límite. Probá con otra calidad.';
    }
  }
}

async function startPeer() {
  if (!stream || !viewerPresent) return;
  try {
    peer.setTransport(elements.transport.value);
    signaling.send({ type: 'connection-settings', transport: elements.transport.value });
    const connection = await peer.create();
    if (!connection || !viewerPresent) return;
    peer.addStream(stream, connection);
    await applyQuality(connection);
    setStatus('Conectando con el otro equipo');
  } catch {
    setStatus('No pudimos iniciar esa conexión', 'error');
  }
}

function handlePeerState(state) {
  if (state === 'connected') {
    setStatus('Están viendo tu pantalla', 'connected');
    applyQuality(peer.peer);
    monitor.update();
  } else if (state === 'failed') {
    const text = elements.transport.value === 'relay'
      ? 'Falló TURN; revisá su configuración'
      : 'La conexión falló; reintentando';
    setStatus(text, 'error');
  } else if (state === 'disconnected' && viewerPresent) {
    setStatus('La conexión se interrumpió; reintentando', 'error');
  }
}

async function startSharing() {
  elements.start.disabled = true;
  elements.error.hidden = true;

  try {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Este navegador no permite compartir pantalla. Abrí Puente en Chrome o Edge.');
    }

    const quality = qualities[elements.quality.value];
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: quality.width, max: quality.width },
        height: { ideal: quality.height, max: quality.height },
        frameRate: { ideal: quality.fps, max: quality.fps },
      },
      audio: false,
    });

    for (const track of stream.getAudioTracks()) {
      track.stop();
      stream.removeTrack(track);
    }

    room = crypto.randomUUID();
    viewerPresent = false;
    elements.video.srcObject = stream;
    elements.link.value = `${location.origin}/watch/${room}`;
    elements.welcome.hidden = true;
    elements.sharing.hidden = false;
    setStatus('Preparando la conexión');
    await applyQuality(null);

    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);
    peer = new PeerConnection('host', null, { onTrack: () => {}, onState: handlePeerState });
    monitor = new ConnectionMonitor(() => peer?.peer, 'host', renderMetrics);
    monitor.start();
    signaling = new Signaling(room, 'host', {
      onStatus(status) {
        if (status === 'reconnecting') setStatus('Reconectando el enlace', 'error');
      },
      async onMessage(message) {
        if (message.type === 'joined') {
          viewerPresent = message.peerPresent;
          if (viewerPresent) await startPeer();
          else setStatus('Esperando que abran el enlace');
        } else if (message.type === 'peer-joined' && message.role === 'viewer') {
          viewerPresent = true;
          await startPeer();
        } else if (message.type === 'peer-left' && message.role === 'viewer') {
          viewerPresent = false;
          peer.close();
          renderMetrics(null);
          setStatus('Esperando que abran el enlace');
        } else {
          await peer.receive(message);
        }
      },
    });
    peer.signaling = signaling;
    signaling.connect();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    elements.start.disabled = false;
    if (error.name === 'NotAllowedError') {
      showError('No se eligió ninguna pantalla. Cuando estés listo, volvé a intentarlo.');
    } else {
      showError(error.message || 'No pudimos iniciar la transmisión. Volvé a intentarlo.');
    }
  }
}

function stopSharing() {
  signaling?.send({ type: 'stream-stopped' });
  signaling?.close();
  monitor?.stop();
  peer?.close();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  viewerPresent = false;
  elements.video.srcObject = null;
  elements.sharing.hidden = true;
  elements.welcome.hidden = false;
  elements.start.disabled = false;
  elements.copyFeedback.textContent = '';
}

async function reconnect() {
  if (!viewerPresent) {
    setStatus('Abrí el enlace en el otro equipo para probar');
    return;
  }
  elements.retry.disabled = true;
  try {
    await startPeer();
  } finally {
    elements.retry.disabled = false;
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(elements.link.value);
    elements.copy.textContent = 'Copiado';
    elements.copyFeedback.textContent = 'El enlace está listo para enviar.';
    setTimeout(() => { elements.copy.textContent = 'Copiar'; }, 2000);
  } catch {
    elements.link.focus();
    elements.link.select();
    elements.copyFeedback.textContent = 'El enlace está seleccionado. Copialo con Ctrl+C o ⌘+C.';
  }
}

elements.start.addEventListener('click', startSharing);
elements.stop.addEventListener('click', stopSharing);
elements.copy.addEventListener('click', copyLink);
elements.link.addEventListener('click', () => elements.link.select());
elements.quality.addEventListener('change', () => applyQuality());
elements.transport.addEventListener('change', reconnect);
elements.retry.addEventListener('click', reconnect);
