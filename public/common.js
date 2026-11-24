export class Signaling {
  constructor(room, role, { onMessage, onStatus }) {
    this.room = room;
    this.role = role;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.closed = false;
    this.retries = 0;
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${location.host}`);

    this.socket.addEventListener('open', () => {
      this.retries = 0;
      this.send({ type: 'join', room: this.room, role: this.role });
      this.onStatus('connected');
    });

    this.socket.addEventListener('message', (event) => {
      try {
        this.onMessage(JSON.parse(event.data));
      } catch {
        this.onStatus('error');
      }
    });

    this.socket.addEventListener('close', () => {
      if (this.closed) return;
      this.onStatus('reconnecting');
      const delay = Math.min(1000 * 2 ** this.retries++, 8000);
      setTimeout(() => this.connect(), delay);
    });

    this.socket.addEventListener('error', () => this.socket.close());
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}

export const INPUT_CHANNEL = 'input';
export const INPUT_FAST_CHANNEL = 'input-fast';

export class PeerConnection {
  constructor(role, signaling, { onTrack, onState, onDataChannel, onAudioTrack }) {
    this.role = role;
    this.signaling = signaling;
    this.onTrack = onTrack;
    this.onState = onState;
    this.onDataChannel = onDataChannel;
    this.onAudioTrack = onAudioTrack;
    this.outgoingAudio = null;
    this.polite = role === 'viewer';
    this.transport = 'auto';
    this.pendingCandidates = [];
    this.generation = 0;
  }

  setTransport(transport) {
    if (['auto', 'udp', 'tcp', 'relay'].includes(transport)) this.transport = transport;
  }

  allowsCandidate(candidate) {
    if (!candidate || this.transport === 'auto' || this.transport === 'relay') return true;
    const protocol = (candidate.relayProtocol || candidate.protocol || candidate.candidate?.split(' ')[2] || '').toLowerCase();
    return protocol === this.transport;
  }

  create() {
    this.close();
    const generation = this.generation;
    this.pendingCandidates = [];
    this.ready = this.open(generation);
    return this.ready;
  }

  async open(generation) {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('No se pudo obtener la configuración de conexión.');
    const config = await response.json();
    if (generation !== this.generation) return;

    const peer = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: this.transport === 'relay' ? 'relay' : 'all',
    });
    this.peer = peer;
    this.makingOffer = false;
    this.ignoreOffer = false;

    peer.addEventListener('negotiationneeded', async () => {
      try {
        this.makingOffer = true;
        await peer.setLocalDescription();
        this.signaling.send({ type: 'description', description: peer.localDescription });
      } catch {
        this.onState('failed');
      } finally {
        this.makingOffer = false;
      }
    });

    peer.addEventListener('icecandidate', ({ candidate }) => {
      if (this.allowsCandidate(candidate)) {
        this.signaling.send({ type: 'candidate', candidate });
      }
    });

    // El host crea los canales de control remoto; el viewer los recibe.
    // "input" es confiable y ordenado (clics, teclas, permisos); "input-fast"
    // no reintenta y sirve para el movimiento del mouse, donde solo importa el último.
    if (this.role === 'host') {
      this.onDataChannel?.(peer.createDataChannel(INPUT_CHANNEL, { ordered: true }));
      this.onDataChannel?.(peer.createDataChannel(INPUT_FAST_CHANNEL, { ordered: false, maxRetransmits: 0 }));
    } else {
      peer.addEventListener('datachannel', ({ channel }) => this.onDataChannel?.(channel));
    }

    peer.addEventListener('track', (event) => {
      if (event.track.kind === 'video') this.onTrack(event.streams[0]);
      else if (event.track.kind === 'audio') this.onAudioTrack?.(event.track, event.streams[0]);
    });

    peer.addEventListener('connectionstatechange', () => {
      this.onState(peer.connectionState);
      if (peer.connectionState === 'failed' && this.role === 'host') peer.restartIce();
    });

    return peer;
  }

  addStream(stream, peer = this.peer) {
    for (const track of stream.getVideoTracks()) {
      track.contentHint = 'detail';
      peer.addTrack(track, stream);
    }
    // Un solo canal de audio en ambos sentidos: el host manda el sonido de la
    // computadora y recibe la voz del viewer. Va en el mismo stream que el video
    // para que se reproduzcan sincronizados. Siempre existe, así cambiar o
    // apagar el audio es un replaceTrack y no hace falta renegociar.
    const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv', streams: [stream] });
    if (this.outgoingAudio) transceiver.sender.replaceTrack(this.outgoingAudio);
  }

  audioTransceiver(peer = this.peer) {
    return peer?.getTransceivers().find((item) => item.receiver.track.kind === 'audio' && !item.stopped);
  }

  // Pista de audio a enviar (sonido del sistema en el host, micrófono en el
  // viewer), o null para dejar de enviar. Se recuerda y se vuelve a aplicar si
  // la conexión se recrea.
  async setOutgoingAudio(track) {
    this.outgoingAudio = track;
    const transceiver = this.audioTransceiver();
    if (transceiver) await transceiver.sender.replaceTrack(track);
  }

  async receive(message) {
    try {
      await this.ready;
      if (!this.peer) return;

      if (message.type === 'candidate') {
        if (message.candidate && this.allowsCandidate(message.candidate)) {
          if (this.peer.remoteDescription) {
            await this.peer.addIceCandidate(message.candidate);
          } else {
            this.pendingCandidates.push(message.candidate);
          }
        }
        return;
      }

      if (message.type !== 'description' || !message.description) return;
      const description = message.description;
      const collision = description.type === 'offer' && (this.makingOffer || this.peer.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;

      await this.peer.setRemoteDescription(description);
      for (const candidate of this.pendingCandidates.splice(0)) {
        if (this.allowsCandidate(candidate)) await this.peer.addIceCandidate(candidate);
      }

      if (description.type === 'offer') {
        // El viewer acepta enviar audio por el mismo canal (su micrófono).
        const audio = this.role === 'viewer' ? this.audioTransceiver() : null;
        if (audio) {
          if (audio.direction !== 'sendrecv') audio.direction = 'sendrecv';
          if (this.outgoingAudio && audio.sender.track !== this.outgoingAudio) {
            await audio.sender.replaceTrack(this.outgoingAudio);
          }
        }
        await this.peer.setLocalDescription();
        this.signaling.send({ type: 'description', description: this.peer.localDescription });
      }
    } catch {
      this.onState('failed');
    }
  }

  close() {
    this.generation++;
    this.peer?.close();
    this.peer = null;
  }
}

export class ConnectionMonitor {
  constructor(getPeer, role, onMetrics) {
    this.getPeer = getPeer;
    this.role = role;
    this.onMetrics = onMetrics;
    this.previous = null;
  }

  start() {
    this.stop();
    this.previous = null;
    this.update();
    this.timer = setInterval(() => this.update(), 2000);
  }

  stop() {
    clearInterval(this.timer);
    this.previous = null;
    this.onMetrics(null);
  }

  async update() {
    const peer = this.getPeer();
    if (!peer || peer.connectionState !== 'connected') return;

    try {
      const report = await peer.getStats();
      const stats = [...report.values()];
      const media = stats.find((item) => item.type === (this.role === 'host' ? 'outbound-rtp' : 'inbound-rtp')
        && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote);
      if (!media) return;

      const remoteMedia = this.role === 'host'
        ? stats.find((item) => item.type === 'remote-inbound-rtp' && item.localId === media.id)
        : null;
      const pairs = stats.filter((item) => item.type === 'candidate-pair' && item.state === 'succeeded');
      const pair = pairs.find((item) => item.nominated || item.selected) || pairs[0];
      const local = pair ? report.get(pair.localCandidateId) : null;
      const remote = pair ? report.get(pair.remoteCandidateId) : null;
      const bytes = media.bytesSent ?? media.bytesReceived ?? 0;
      const timestamp = report.timestamp || performance.now();
      let bitrate = 0;

      if (this.previous?.peer === peer && this.previous.mediaId === media.id && timestamp > this.previous.timestamp) {
        bitrate = Math.max(0, bytes - this.previous.bytes) * 8 / (timestamp - this.previous.timestamp);
      }
      this.previous = { peer, mediaId: media.id, bytes, timestamp };

      const received = media.packetsReceived ?? remoteMedia?.packetsReceived ?? 0;
      const lost = remoteMedia?.packetsLost ?? media.packetsLost ?? 0;
      const lossPercent = typeof remoteMedia?.fractionLost === 'number'
        ? remoteMedia.fractionLost * 100
        : received + lost > 0 ? lost / (received + lost) * 100 : null;

      this.onMetrics({
        state: peer.connectionState,
        route: local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN' : 'Directa',
        protocol: (local?.relayProtocol || local?.protocol || '–').toUpperCase(),
        resolution: media.frameWidth && media.frameHeight ? `${media.frameWidth}×${media.frameHeight}` : '–',
        fps: media.framesPerSecond,
        bitrate,
        latency: pair?.currentRoundTripTime ?? remoteMedia?.roundTripTime,
        jitter: media.jitter ?? remoteMedia?.jitter,
        lost,
        lossPercent,
        limitation: media.qualityLimitationReason,
      });
    } catch {
      this.onMetrics(null);
    }
  }
}
