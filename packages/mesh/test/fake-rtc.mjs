// Mock d'un environnement WebRTC pour Node : deux RTCPeerConnection simulés
// auto-couplés par ordre de création, paires de DataChannel avec file
// d'émission, backpressure pilotable (pause/resume + bufferedamountlow) et
// hooks de sabotage (tamper = octets modifiés, drop = trame jetée).
// Pas de réseau réel : c'est la LOGIQUE de PeerLink/négociation qu'on prouve.
export class FakeRTCIceCandidate {
  constructor(init) { this.candidate = init.candidate; }
}

function toArrayBufferView(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'connecting';
    this.binaryType = 'arraybuffer';
    this.bufferedAmountLowThreshold = 0;
    this.bufferedAmount = 0;
    this.onopen = null; this.onclose = null; this.onmessage = null; this.onbufferedamountlow = null;
    this.peer = null;
    this._queue = [];
    this._paused = false;
    this._flushing = false;
    this._tamper = null; // (frameUint8) => Uint8Array modifié (pair malveillant)
    this._drop = null;   // (frameUint8) => true pour jeter cette trame (perte réseau)
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('channel not open');
    const size = typeof data === 'string' ? data.length : data.byteLength;
    this.bufferedAmount += size; // comptabilisation SYNCHRONE : c'est elle qui
    this._queue.push({ data, size });   // déclenche la pause du pump PeerLink
    this._flushSoon();
  }

  _flushSoon() {
    if (this._flushing || this._paused || this.readyState !== 'open') return;
    this._flushing = true;
    queueMicrotask(() => {
      this._flushing = false;
      while (!this._paused && this._queue.length) {
        const item = this._queue.shift();
        let payload = item.data;
        if (this._tamper && typeof payload !== 'string') payload = this._tamper(payload);
        if (!(this._drop && typeof payload !== 'string' && this._drop(payload)) && this.peer && this.peer.readyState === 'open') {
          this.peer.onmessage?.({ data: typeof payload === 'string' ? payload : toArrayBufferView(payload) });
        }
        this.bufferedAmount = Math.max(0, this.bufferedAmount - item.size);
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
      }
    });
  }

  pause() { this._paused = true; }
  resume() { this._paused = false; this._flushSoon(); }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    if (this.peer && this.peer.readyState === 'open') { this.peer.readyState = 'closed'; this.peer.onclose?.(); }
  }

  _open() { this.readyState = 'open'; queueMicrotask(() => this.onopen?.()); }
}

const registry = []; // couplages en attente : chaque makeRtcPair a sa file privée

class FakePeerConnection {
  constructor(config, pool) {
    this.configuration = config; // iceServers observés par les tests (STUN, jamais TURN)
    this._pool = pool;
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.iceConnectionState = 'new';
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.oniceconnectionstatechange = null;
    this.ondatachannel = null;
    this.peer = null;
    this._created = null;
    this._received = null;
    this._negotiationDue = false;
    this.candidates = [];
    const partner = pool.find((pc) => !pc.peer); // auto-couplage A↔B LOCAL à la fabrique
    if (partner) { partner.peer = this; this.peer = partner; }
    pool.push(this);
  }

  createDataChannel(label, options) {
    if (options && options.ordered === false) throw new Error('unordered non supporté par la POC');
    const dc = new FakeDataChannel(label);
    this._created = dc;
    if (this._negotiationDue) return dc;
    this._negotiationDue = true;
    queueMicrotask(() => this.onnegotiationneeded?.());
    return dc;
  }

  async setLocalDescription(init) {
    if (init && init.type === 'rollback') { this.signalingState = 'stable'; return; }
    if (this.signalingState === 'stable') {
      this.localDescription = { type: 'offer', sdp: 'fake-offer-v1' };
      this.signalingState = 'have-local-offer';
    } else if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: 'fake-answer-v1' };
      this.signalingState = 'stable';
      this._connectPair(); // réponse émise : ICE + canaux s'ouvrent des deux côtés
    }
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      const incoming = new FakeDataChannel(this.peer?._created?.label ?? 'mesh-v1');
      this._received = incoming;
      if (this.peer?._created) { this.peer._created.peer = incoming; incoming.peer = this.peer._created; }
      queueMicrotask(() => this.ondatachannel?.({ channel: incoming }));
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable';
    }
  }

  async addIceCandidate(candidate) { this.candidates.push(candidate); }

  _connectPair() {
    for (const pc of [this, this.peer]) {
      if (!pc || pc.iceConnectionState !== 'new') continue;
      pc.iceConnectionState = 'connected';
      queueMicrotask(() => pc.oniceconnectionstatechange?.());
    }
    for (const dc of [this._created ?? this._received, this.peer?._created ?? this.peer?._received]) dc?._open();
  }

  close() {
    for (const dc of [this._created, this._received]) dc?.close();
    this.iceConnectionState = 'closed';
  }
}

export function makeRtcPair() {
  const created = []; // même tableau = le pool de couplage de cette fabrique
  const env = {
    RTCPeerConnection: function (config) { const pc = new FakePeerConnection(config, created); return pc; },
    RTCIceCandidate: FakeRTCIceCandidate,
    iceServers: [{ urls: 'stun:stun.example.org:3478' }],
  };
  return { env, created };
}

/** Patiente jusqu'à condition (poll 5 ms, timeout explicite). */
export async function waitFor(predicate, ms = 500, label = 'condition') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`waitFor dépassé : ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
