// WebRTC natif + perfect negotiation (patron MDN, AUCUNE librairie) et
// protocole peer→peer sur DataChannel ordonné (spec §6, contrats mesh.ts).
//
// Rôles déterministes : `polite = pidA > pidB` lexicographique — les DEUX
// pairs calculent le même (spec §10.3). L'impoli qui voit une offer
// concurrente l'ignore ; le poli rollback. Le NOUVEAU ARRIVÉ initie
// (createDataChannel) ; l'auto-reprise après échec se limite à une
// reconstruction simple du lien (pas de re-négociation infinie).
//
// Sécurité du canal (pair NON fiable par construction) :
//   - HELLO premier message obligatoire, cross-check sid/rid/proto ;
//   - JSON borné 8 Ko + Zod strict ; trames bornées 64 Ko + version+bid ;
//   - SEGMENT_REQUEST servi UNIQUEMENT si présent dans MON cache (jamais un
//     fetch pour servir : pas de multi-hop ni de boucle — §21 du brief) ;
//   - window annoncée du pair : on ne demande jamais hors fenêtre ;
//   - sha256 émetteur vs receveur (spéc. §6.2 : prouve le TRANSIT, pas la
//     légitimité — l'origin et le décodeur MSE restent l'autorité).
// Backpressure (critique §23) : chunk envoyé seulement si bufferedAmount sous
// 1 Mo ; sinon pause, reprise sur `bufferedamountlow` (délai max 10 s →
// abandon propre de la requête servie, jamais du lien).

import {
  meshP2pMessageSchema,
  MESH_PROTOCOL_VERSION,
  MESH_MAX_MESSAGE_BYTES,
  MESH_MAX_SEGMENT_BYTES,
  type MeshP2pErrorCode,
  type MeshP2pMessage,
} from '@mbolo/contracts';
import { decodeFrame, splitFrames } from './transport';
import type { SegmentCache } from './memory-cache';
import { sha256Hex } from './memory-cache';
import type { MeshTrace } from './trace';

export const DATA_CHANNEL_LABEL = 'mesh-v1';
const BUFFER_HIGH = 1024 * 1024;
const DRAIN_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 8_000;

export interface RtcEnv {
  RTCPeerConnection: typeof RTCPeerConnection;
  RTCIceCandidate: typeof RTCIceCandidate;
  iceServers: RTCIceServer[];
}

export type MeshPeerLinkState = 'connecting' | 'ready' | 'failed' | 'closed';

export interface PeerEvents {
  state(state: MeshPeerLinkState): void;
  signal(type: 'SIGNAL_OFFER' | 'SIGNAL_ANSWER' | 'ICE_CANDIDATE', payload: { sdp?: string; c?: string[] }): void;
  served(bytes: number): void;
  downloaded(bytes: number): void;
  /** Instrumentation [mesh-test] (§8) — ABSENT par défaut : aucun coût. */
  trace?: MeshTrace;
}

export interface SegmentResult { ok: boolean; bytes?: Uint8Array; reason?: 'timeout' | 'refused' | 'hash' | 'dead' | 'overloaded' | 'unavailable' }
export interface AnnouncedWindow { cc: number; first: number; last: number }

let bidCounter = (Math.random() * 0xffff) | 0;
const nextBid = (): number => ((bidCounter = (bidCounter + 1) % 0xffff_ffff) || 1);

interface Serving { nonce: string; cc: number; sn: number; bid: number; frames: Uint8Array<ArrayBuffer>[]; at: number; paused: boolean; timer: ReturnType<typeof setTimeout> | null }
interface Downloading { nonce: string; cc: number; sn: number; len: number; chunks: number; bid: number; parts: Map<number, Uint8Array>; got: number; timer: ReturnType<typeof setTimeout> | null }

export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private helloSent = false;
  private helloOk = false;
  private seq = 0;
  private serving: Serving | null = null;
  private download: Downloading | null = null;
  private readonly waiters = new Map<string, (r: SegmentResult) => void>();
  private readonly active = new Map<string, ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private state: MeshPeerLinkState = 'connecting';
  rttMs: number | null = null;
  inFlight = 0;
  // Instrumentation canary (additive, jamais bloquante) : durées ICE,
  // compteurs DataChannel et corrélations de transfert (tid = nonce partagé).
  private iceStartAt = 0;
  private iceDone = false;
  private dcOpenAt = 0;
  private dcSentBytes = 0;
  private dcRecvBytes = 0;
  private dcSentMsgs = 0;
  private dcRecvMsgs = 0;
  private dcBackpressure = 0;
  private dcTimeouts = 0;
  private dcAborts = 0;
  private dcErrors = 0;
  private readonly pendingReq = new Map<string, { cc: number; sn: number; at: number }>();
  private servingAt = 0;
  /** capacity=off → on ne SERT RIEN, même sur requête directe (règle serveur
   *  doublée côté client — défense en profondeur, §18/§39 du brief). */
  canSeed = true;
  /** Fenêtre annoncée par CE pair (vue du coordinateur) — borne mes demandes. */
  knownWin: AnnouncedWindow | null = null;

  constructor(
    readonly pid: string,
    private readonly sid: string,
    private readonly rid: string | null,
    private readonly polite: boolean,
    private readonly cache: SegmentCache,
    private readonly env: RtcEnv,
    private readonly events: PeerEvents,
    private readonly chunkBytes: number,
  ) {}

  get linkState(): MeshPeerLinkState { return this.state; }
  get usable(): boolean { return this.state === 'ready' && this.helloOk; }
  private dead = false; // close() : le lien ne doit plus RIEN monter après sa mort

  // ------------------------------------------------------------- établissement

  /** Règle déterministe : le pair IMPOLI (selfPid < autrePid) ouvre le canal
   *  et offre ; le pair poli attend (le canal lui arrive par ondatachannel).
   *  Les roles étant complémentaires entre deux pairs, IL Y A TOUJOURS
   *  exactement un initiateur — même en découverte croisée simultanée. La
   *  perfect negotiation garde la main sur les renégociations concurrentes. */
  initiate(): void {
    this.startPc();
    if (!this.polite && this.pc && !this.dc) this.wire(this.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
  }

  /** Le poli attend ; l'impoli a déjà son offre en route via negotiationneeded. */
  ensurePc(): void { this.startPc(); }

  private startPc(): void {
    if (this.pc) return;
    if (!this.iceStartAt) this.iceStartAt = this.nowMs();
    const pc = new this.env.RTCPeerConnection({ iceServers: this.env.iceServers });
    this.pc = pc;
    pc.onnegotiationneeded = async (): Promise<void> => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription(); // {type:''} : offer moderne auto-dédiée (Chrome/FF/Safari récents)
        this.events.signal('SIGNAL_OFFER', { sdp: pc.localDescription?.sdp });
      } catch (err) { this.onLinkError(err); }
      finally { this.makingOffer = false; }
    };
    pc.onicecandidate = (event): void => {
      if (event.candidate) this.events.signal('ICE_CANDIDATE', { c: [event.candidate.candidate] });
    };
    pc.oniceconnectionstatechange = (): void => {
      const ice = pc.iceConnectionState;
      // Instrumentation ICE (§9) : transitions + instantané de l'état complet.
      this.traceIce(ice);
      if (ice === 'connected' || ice === 'completed') {
        this.setState('ready');
        this.traceIceResult(true, 'connected');
        void this.traceCandidatePair();
      }
      else if (ice === 'failed') { this.traceIceResult(false, 'ice-failed'); this.setState('failed'); }
      // disconnected : pas de panique — ICE le résout souvent seul ; le
      // timeout applicatif (requêtes) + le heartbeat de fenêtre trieront.
    };
    pc.onconnectionstatechange = (): void => { this.traceIce(pc.iceConnectionState); };
    pc.ondatachannel = (event): void => this.wire(event.channel);
  }

  /** Émet l'état ICE complet (iceConnectionState + gathering + connectionState)
   *  pour le [mesh-test] — absent, no-op. §9. */
  private traceIce(ice: string): void {
    if (!this.events.trace || !this.pc) return;
    try {
      this.events.trace({ t: 'ice', pid: this.pid, ms: this.nowMs(), state: {
        ice, gathering: this.pc.iceGatheringState ?? 'unknown', connection: this.pc.connectionState ?? 'unknown',
      } });
    } catch { /* instrumentation jamais bloquante */ }
  }

  /** Issue ICE (une seule fois par lien) : durée + succès/échec + raison. */
  private traceIceResult(ok: boolean, reason: string): void {
    if (this.iceDone || !this.events.trace) return;
    this.iceDone = true;
    try {
      const ms = Math.max(0, Math.round(this.nowMs() - (this.iceStartAt || this.nowMs())));
      this.events.trace({ t: 'iceResult', pid: this.pid, ok, ms, reason: String(reason).slice(0, 32) });
    } catch { /* instrumentation jamais bloquante */ }
  }
  /** Statistiques de vie du DataChannel (émises une fois, à la fermeture). */
  private traceDcStats(): void {
    if (!this.events.trace || !this.dcOpenAt) return;
    try {
      this.events.trace({
        t: 'dcStats', pid: this.pid,
        lifetimeMs: Math.max(0, Math.round(this.nowMs() - this.dcOpenAt)),
        sentBytes: this.dcSentBytes, recvBytes: this.dcRecvBytes,
        sentMsgs: this.dcSentMsgs, recvMsgs: this.dcRecvMsgs,
        backpressure: this.dcBackpressure, timeouts: this.dcTimeouts,
        aborts: this.dcAborts, errors: this.dcErrors,
      });
    } catch { /* instrumentation jamais bloquante */ }
  }

  /** Paire de candidats sélectionnée, résumée par TYPE (host/srflx/relay) —
   *  JAMAIS d'adresse (§8 confidentialité). Meilleur-effort : un getStats()
   *  indisponible ou sans paire sélectionnée n'émet rien, ne casse rien. */
  private async traceCandidatePair(): Promise<void> {
    const trace = this.events.trace; const pc = this.pc;
    if (!trace || !pc || typeof pc.getStats !== 'function') return;
    try {
      const report = await pc.getStats();
      const candidates = new Map<string, { candidateType: string }>();
      const pairs: { localId: string; remoteId: string; nominated: boolean; state?: string }[] = [];
      report.forEach((s) => {
        const rec = s as unknown as { type: string; id: string; nominated?: boolean; state?: string; localId?: string; remoteId?: string; candidateType?: string };
        if (rec.type === 'candidate-pair' && rec.localId && rec.remoteId) pairs.push({ localId: rec.localId, remoteId: rec.remoteId, nominated: Boolean(rec.nominated), state: rec.state });
        else if (rec.type === 'local-candidate' || rec.type === 'remote-candidate') candidates.set(rec.id, { candidateType: rec.candidateType ?? 'unknown' });
      });
      const pair = pairs.find((p) => p.nominated) ?? pairs.find((p) => p.state === 'succeeded');
      if (!pair) return;
      const local = candidates.get(pair.localId);
      const remote = candidates.get(pair.remoteId);
      if (local && remote) trace({ t: 'candidatePair', pid: this.pid, local: local.candidateType, remote: remote.candidateType });
    } catch { /* stats indisponibles : pas de donnée ICE, jamais une erreur */ }
  }

  private nowMs(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  receiveSignal(type: 'SIGNAL_OFFER' | 'SIGNAL_ANSWER' | 'ICE_CANDIDATE', payload: { sdp?: string; c?: string[] }): void {
    if (this.dead) return; // un lien fermé ne se ranime pas (offer arrivée après close/retiré)
    this.startPc();
    const pc = this.pc!;
    if (type === 'ICE_CANDIDATE') {
      for (const line of payload.c ?? []) {
        const candidate = { candidate: line } as RTCIceCandidateInit;
        if (pc.remoteDescription) pc.addIceCandidate(candidate).catch((err: unknown) => { if (!this.ignoreOffer) this.onLinkError(err); });
        else this.pendingIce.push(candidate); // ICE avant remoteDescription : mise en file
      }
      return;
    }
    void this.applyDescription(pc, type, payload.sdp ?? '');
  }

  private async applyDescription(pc: RTCPeerConnection, type: 'SIGNAL_OFFER' | 'SIGNAL_ANSWER', sdp: string): Promise<void> {
    if (!sdp) return;
    const offerCollision = type === 'SIGNAL_OFFER' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return; // l'impoli laisse gagner sa propre offer
    try {
      if (offerCollision) await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit);
      await pc.setRemoteDescription({ type: type === 'SIGNAL_OFFER' ? 'offer' : 'answer', sdp });
      if (type === 'SIGNAL_ANSWER') return;
      await pc.setLocalDescription();
      this.events.signal('SIGNAL_ANSWER', { sdp: pc.localDescription?.sdp });
      for (const candidate of this.pendingIce.splice(0)) pc.addIceCandidate(candidate).catch((err: unknown) => this.onLinkError(err));
    } catch (err) { this.onLinkError(err); }
  }

  private onLinkError(err: unknown): void {
    // Erreur de négociation : le lien tombe, le PeerManager le remplacera.
    void err;
    if (this.state !== 'failed' && this.state !== 'closed') this.setState('failed');
  }

  // ------------------------------------------------------------ DataChannel

  private wire(dc: RTCDataChannel): void {
    if (this.dead) { try { dc.close(); } catch { /* déjà mort */ } return; } // canal fantôme post-close : tué net (pas de ping fantôme)
    if (this.dc) { try { this.dc.close(); } catch { /* déjà mort */ } }
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = (): void => { this.dcOpenAt = this.nowMs(); this.events.trace?.({ t: 'dc', pid: this.pid, state: 'open' }); this.sendHello(); this.startPing(); this.setState('ready'); };
    dc.onclose = (): void => { this.events.trace?.({ t: 'dc', pid: this.pid, state: 'close' }); this.traceDcStats(); this.traceIceResult(false, 'dc-closed'); this.onChannelClosed(); this.setState('closed'); };
    try { (dc as unknown as { onerror: unknown }).onerror = (): void => { this.dcErrors += 1; try { this.events.trace?.({ t: 'dc', pid: this.pid, state: 'error' }); } catch { /* no-op */ } }; } catch { /* DataChannel sans onerror */ }
    dc.onbufferedamountlow = (): void => { if (this.serving?.paused) this.resumeServing(); };
    dc.onmessage = (event): void => {
      try {
        if (typeof event.data === 'string') { this.dcRecvMsgs += 1; this.dcRecvBytes += event.data.length; this.onControl(event.data); }
        else { const buf = event.data as ArrayBuffer; this.dcRecvMsgs += 1; this.dcRecvBytes += buf.byteLength; this.onFrame(buf); }
      } catch { this.dcErrors += 1; this.close('protocol-abuse'); } // abus répété : fermeture
    };
  }

  private startPing(): void {
    if (this.pingTimer) return;
    const beat = (): void => {
      this.pingTimer = null;
      if (!this.dc || this.dc.readyState !== 'open') return;
      this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'PING', seq: ++this.seq, d: { t0: Date.now() } });
      this.pingTimer = setTimeout(beat, 15_000);
    };
    this.pingTimer = setTimeout(beat, 5_000);
  }

  private sendJson(message: MeshP2pMessage | { v: number; t: string; seq: number; d: unknown }): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    const raw = JSON.stringify(message);
    if (raw.length > MESH_MAX_MESSAGE_BYTES) return; // nos messages sont nés petits ; garde anti-bug
    try { this.dc.send(raw); this.dcSentMsgs += 1; this.dcSentBytes += raw.length; }
    catch { this.dcErrors += 1; }
  }

  private sendHello(): void {
    if (this.helloSent) return;
    this.helloSent = true;
    this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'HELLO', seq: ++this.seq, d: { proto: MESH_PROTOCOL_VERSION, cap: 'normal', sid: this.sid, rid: this.rid ?? '00000000' } });
  }

  // ------------------------------------------------------ contrôle peer→peer

  private onControl(raw: string): void {
    if (raw.length > MESH_MAX_MESSAGE_BYTES) throw new Error('oversized-control');
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; } // ordure : ignorée silencieusement
    const parsed = meshP2pMessageSchema.safeParse(json);
    if (!parsed.success) return; // inconnu/futur : ignoré (extensibilité), JAMAIS exécuté
    const message = parsed.data;
    if (message.t !== 'HELLO') { if (!this.helloOk) return; } // HELLO obligatoire d'abord
    switch (message.t) {
      case 'HELLO':
        if (message.d.sid !== this.sid) { this.events.trace?.({ t: 'hello', pid: this.pid, ok: false }); throw new Error('cross-swarm'); }
        if (this.rid && message.d.rid !== '00000000' && message.d.rid !== this.rid) { this.events.trace?.({ t: 'hello', pid: this.pid, ok: false }); throw new Error('cross-rendition'); }
        this.helloOk = true;
        this.events.trace?.({ t: 'hello', pid: this.pid, ok: true });
        this.setState('ready');
        return;
      case 'PING': this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'PONG', seq: ++this.seq, d: { t0: message.d.t0 } }); return;
      case 'PONG': this.rttMs = Math.max(0, Date.now() - message.d.t0); return;
      case 'SEGMENT_REQUEST': this.onIncomingRequest(message.d); return;
      case 'SEGMENT_HEADER': this.onIncomingHeader(message.d); return;
      case 'SEGMENT_COMPLETE': void this.onIncomingComplete(message.d); return;
      case 'ERROR': {
        const nonce = message.d.n;
        if (nonce) this.failDownload(nonce, mapErrorCode(message.d.code));
        return;
      }
      default: return;
    }
  }

  // ------------------------------------------------- côté SERVEUR (own cache)

  private onIncomingRequest(d: { n: string; cc: number; sn: number }): void {
    if (!this.canSeed) { this.traceTransferSrv(d.n, d.cc, d.sn, false, 0, 0, 'unavailable'); this.replyError(d.n, 'SEGMENT_NOT_AVAILABLE'); return; } // seeding coupé (off/batterie/background)
    if (this.serving) { this.traceTransferSrv(d.n, d.cc, d.sn, false, 0, 0, 'overloaded'); this.replyError(d.n, 'OVERLOADED'); return; } // 1 transfert à la fois par lien (POC)
    const segment = this.cache.get(d.cc, d.sn);
    if (!segment) { this.traceTransferSrv(d.n, d.cc, d.sn, false, 0, 0, 'unavailable'); this.replyError(d.n, 'SEGMENT_NOT_AVAILABLE'); return; }
    const frames = splitFrames(segment.bytes, nextBid(), this.chunkBytes);
    const serving: Serving = { nonce: d.n, cc: d.cc, sn: d.sn, bid: frames[0] ? decodeBid(frames[0]) : 0, frames, at: 0, paused: false, timer: null };
    this.serving = serving;
    this.servingAt = this.nowMs();
    this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'SEGMENT_HEADER', seq: ++this.seq, d: { n: d.n, cc: d.cc, sn: d.sn, len: segment.bytes.length, chunks: frames.length, bid: serving.bid } });
    this.pumpFrames();
  }

  /** Transfert côté serveur corrélable (tid = nonce partagé avec le demandeur). */
  private traceTransferSrv(tid: string, cc: number, sn: number, ok: boolean, bytes: number, ms: number, reason?: string): void {
    try { this.events.trace?.({ t: 'transfer', tid, pid: this.pid, role: 'srv', cc, sn, ok, bytes, ms, reason }); } catch { /* no-op */ }
  }

  private pumpFrames(): void {
    const serving = this.serving;
    const dc = this.dc;
    if (!serving || !dc || dc.readyState !== 'open') { this.abortServing(); return; }
    while (serving.at < serving.frames.length) {
      if (dc.bufferedAmount > BUFFER_HIGH) {
        serving.paused = true;
        this.dcBackpressure += 1;
        try { this.events.trace?.({ t: 'backpressure', pid: this.pid }); } catch { /* no-op */ }
        serving.timer = setTimeout(() => this.abortServing(), DRAIN_TIMEOUT_MS);
        return; // reprise via bufferedamountlow
      }
      try { dc.send(serving.frames[serving.at]); this.dcSentMsgs += 1; this.dcSentBytes += serving.frames[serving.at].byteLength - 7; } catch { this.dcErrors += 1; this.abortServing(); return; }
      serving.at += 1;
    }
    const bytes = serving.frames.reduce((sum, frame) => sum + frame.byteLength - 7, 0);
    const ms = Math.max(0, Math.round(this.nowMs() - (this.servingAt || this.nowMs())));
    this.serving = null;
    const segment = this.cache.get(serving.cc, serving.sn);
    this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'SEGMENT_COMPLETE', seq: ++this.seq, d: { n: serving.nonce, sha256: segment?.sha256 ?? '' } });
    this.events.served(bytes);
    this.events.trace?.({ t: 'peerResult', pid: this.pid, ok: true, bytes, ms: 0 }); // ms=0 : côté émetteur, RTT non mesuré ici
    this.traceTransferSrv(serving.nonce, serving.cc, serving.sn, true, bytes, ms);
    void this.traceCandidatePair(); // le pair servi par ce lien : DIRECT / STUN / relay (§19)
  }

  private resumeServing(): void {
    const serving = this.serving;
    if (!serving?.paused) return;
    serving.paused = false;
    if (serving.timer) { clearTimeout(serving.timer); serving.timer = null; }
    this.pumpFrames();
  }

  private abortServing(): void {
    const serving = this.serving;
    if (!serving) return;
    if (serving.timer) clearTimeout(serving.timer);
    this.serving = null;
    this.dcAborts += 1;
    this.traceTransferSrv(serving.nonce, serving.cc, serving.sn, false, 0, Math.max(0, Math.round(this.nowMs() - (this.servingAt || this.nowMs()))), 'aborted');
    this.replyError(serving.nonce, 'OVERLOADED');
  }

  private replyError(nonce: string, code: 'OVERLOADED' | 'SEGMENT_NOT_AVAILABLE'): void {
    this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'ERROR', seq: ++this.seq, d: { n: nonce, code } });
  }

  // ------------------------------------------------------ côté DEMANDEUR

  private onIncomingHeader(d: { n: string; cc: number; sn: number; len: number; chunks: number; bid?: number }): void {
    if (!this.active.has(d.n) || this.download) return;
    if (d.len > MESH_MAX_SEGMENT_BYTES || d.len <= 0 || d.chunks > 8192) { this.failDownload(d.n, 'refused'); return; }
    this.download = {
      nonce: d.n, cc: d.cc, sn: d.sn, len: d.len, chunks: d.chunks, bid: d.bid ?? 0,
      parts: new Map(), got: 0,
      timer: setTimeout(() => this.failDownload(d.n, 'timeout'), DOWNLOAD_TIMEOUT_MS),
    };
  }

  private onFrame(raw: ArrayBuffer): void {
    const dl = this.download;
    if (!dl) return;
    const frame = decodeFrame(raw);
    if (!frame || frame.version !== MESH_PROTOCOL_VERSION || frame.bid !== dl.bid) return; // trame étrangère/annulée
    if (frame.idx >= dl.chunks || dl.parts.has(frame.idx)) return; // index fou ou doublon
    dl.parts.set(frame.idx, frame.payload);
    dl.got += 1;
  }

  private async onIncomingComplete(d: { n: string; sha256: string }): Promise<void> {
    const dl = this.download;
    if (!dl || dl.nonce !== d.n) return;
    this.download = null;
    if (dl.timer) clearTimeout(dl.timer);
    if (dl.got !== dl.chunks) { this.failDownload(dl.nonce, 'timeout'); return; }
    const assembled = new Uint8Array(dl.len);
    let at = 0;
    for (let idx = 0; idx < dl.chunks; idx += 1) {
      const part = dl.parts.get(idx);
      if (!part) { this.failDownload(dl.nonce, 'timeout'); return; }
      if (at + part.length > dl.len) { this.failDownload(dl.nonce, 'timeout'); return; } // longueur annoncée mentie
      assembled.set(part, at);
      at += part.length;
    }
    if (at !== dl.len) { this.failDownload(dl.nonce, 'timeout'); return; }
    if ((await sha256Hex(assembled)) !== d.sha256) {
      // Hash invalide : pair défaillant (le manager l'écartera), segment écarté.
      this.failDownload(dl.nonce, 'hash');
      return;
    }
    void this.cache.put(dl.cc, dl.sn, assembled, 'peer'); // seed local : je le tiens à mon tour (fenêtre annoncée)
    this.events.downloaded(assembled.length);
    this.settle(dl.nonce, { ok: true, bytes: assembled });
  }

  private failDownload(nonce: string, reason: 'timeout' | 'refused' | 'hash' | 'overloaded' | 'unavailable'): void {
    const dl = this.download;
    if (dl && dl.nonce === nonce) {
      if (dl.timer) clearTimeout(dl.timer);
      this.download = null;
    }
    if (reason === 'timeout') this.dcTimeouts += 1;
    if (reason === 'overloaded' || reason === 'unavailable') this.dcAborts += 1;
    const meta = this.pendingReq.get(nonce);
    if (meta) {
      try { this.events.trace?.({ t: 'transfer', tid: nonce, pid: this.pid, role: 'req', cc: meta.cc, sn: meta.sn, ok: false, bytes: 0, ms: Math.max(0, Math.round(this.nowMs() - meta.at)), reason }); } catch { /* no-op */ }
    }
    this.settle(nonce, { ok: false, reason });
  }

  private settle(nonce: string, result: SegmentResult): void {
    const timer = this.active.get(nonce);
    if (timer) clearTimeout(timer);
    this.active.delete(nonce);
    const meta = this.pendingReq.get(nonce);
    if (meta) {
      this.pendingReq.delete(nonce);
      if (result.ok && result.bytes) {
        try { this.events.trace?.({ t: 'transfer', tid: nonce, pid: this.pid, role: 'req', cc: meta.cc, sn: meta.sn, ok: true, bytes: result.bytes.length, ms: Math.max(0, Math.round(this.nowMs() - meta.at)) }); } catch { /* no-op */ }
      }
      // Les échecs sont déjà tracés par failDownload (chemin unique) ; les
      // résolutions directes 'dead'/'refused' sans failDownload sont tracées ici.
      else if (!result.reason || result.reason === 'dead' || result.reason === 'refused') {
        try { this.events.trace?.({ t: 'transfer', tid: nonce, pid: this.pid, role: 'req', cc: meta.cc, sn: meta.sn, ok: false, bytes: 0, ms: Math.max(0, Math.round(this.nowMs() - meta.at)), reason: result.reason ?? 'dead' }); } catch { /* no-op */ }
      }
    }
    const waiter = this.waiters.get(nonce);
    if (waiter) { this.waiters.delete(nonce); this.inFlight = Math.max(0, this.inFlight - 1); waiter(result); }
  }

  /** Demande un segment. Résout TOUJOURS (jamais de rejet) : le loader retombe
   *  sur origin en continuant, sans try/catch. */
  requestSegment(cc: number, sn: number, timeoutMs: number): Promise<SegmentResult> {
    return new Promise((resolve) => {
      if (!this.usable) { resolve({ ok: false, reason: 'dead' }); return; }
      const win = this.knownWin;
      if (win && (cc !== win.cc || sn < win.first || sn > win.last)) { resolve({ ok: false, reason: 'refused' }); return; }
      if (this.download || this.inFlight >= 1) { resolve({ ok: false, reason: 'dead' }); return; } // UN seul transfert en vol par lien (§21 anti-boucle/dup)
      const nonce = randomNonce();
      this.inFlight += 1;
      this.waiters.set(nonce, resolve);
      this.pendingReq.set(nonce, { cc, sn, at: this.nowMs() });
      const timer = setTimeout(() => this.failDownload(nonce, 'timeout'), timeoutMs);
      this.active.set(nonce, timer);
      this.sendJson({ v: MESH_PROTOCOL_VERSION, t: 'SEGMENT_REQUEST', seq: ++this.seq, d: { n: nonce, cc, sn } });
    });
  }

  close(reason = 'shutdown'): void {
    this.dead = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    if (this.serving?.timer) clearTimeout(this.serving.timer);
    this.serving = null;
    if (this.download?.timer) clearTimeout(this.download.timer);
    this.download = null;
    for (const timer of this.active.values()) clearTimeout(timer);
    this.active.clear();
    // Solde corrélé : chaque demande en vol reçoit son 'transfer' req/dead.
    for (const nonce of [...this.waiters.keys()]) this.settle(nonce, { ok: false, reason: 'dead' });
    this.waiters.clear();
    this.traceIceResult(false, String(reason).slice(0, 32));
    this.traceDcStats();
    try { this.dc?.close(); } catch { /* déjà mort */ }
    try { this.pc?.close(); } catch { /* déjà mort */ }
    this.dc = null; this.pc = null;
    this.setState('closed');
  }

  /** Canal mort en pleine partie : les promesses en attent NE PEUVENT plus
   *  être livrées — on les solde immédiatement ('dead', §50 « peer disparaît
   *  brutalement »). Un transfert de données est une dette du canal, pas du pair. */
  private onChannelClosed(): void {
    if (this.serving?.timer) clearTimeout(this.serving.timer);
    this.serving = null;
    if (this.download) {
      if (this.download.timer) clearTimeout(this.download.timer);
      const dl = this.download;
      this.download = null;
      this.settle(dl.nonce, { ok: false, reason: 'dead' });
    }
    for (const nonce of [...this.waiters.keys()]) this.settle(nonce, { ok: false, reason: 'dead' });
  }

  private setState(next: MeshPeerLinkState): void {
    if (this.state === next) return;
    this.state = next;
    this.events.state(next);
  }
}

/** Code d'erreur peer→peer → raison de SegmentResult. Un OVERLOADED ou un
 *  SEGMENT_NOT_AVAILABLE sont des échecs SOUPLES (§14 brief étape 5) : le pair
 *  est occupé ou n'a plus ce segment — c'est NORMAL en live, ça ne doit pas
 *  condamner le pair. BAD_REQUEST/CHECKSUM gardent leur gravité. */
function mapErrorCode(code: MeshP2pErrorCode): 'refused' | 'overloaded' | 'unavailable' {
  switch (code) {
    case 'OVERLOADED': return 'overloaded';
    case 'SEGMENT_NOT_AVAILABLE': return 'unavailable';
    default: return 'refused';
  }
}

function decodeBid(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}
