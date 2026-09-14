// Transport de signaling : WebSocket privilégié, repli polling HTTP.
// Règle (spec §12) : après 3 échecs WS → bascule polling ; si le polling
// échoue aussi → P2P désactivé pour la session (le playback origin continue,
// le loader n'appelle plus le mesh). Les enveloppes ascendantes/descendantes
// sont celles des contrats @mbolo/contracts (le transport ne les interprète
// pas — il les déplace).
export interface SignalingTransport {
  send(raw: string): void;                       // montée (best-effort : WS vivant, sinon file poll)
  onMessage(handler: (raw: string) => void): void;
  onStatus(handler: (status: 'open' | 'closed' | 'polling' | 'dead') => void): void;
  close(): void;
  readonly transport: 'ws' | 'poll' | 'dead';
}

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event?: unknown) => void): void;
}
// OPEN = 1, CLOSED = 3 (constants WebSocket, recopiées pour rester testable
// sous Node sans global WebSocket).
const WS_OPEN = 1;

export interface SignalingOptions {
  meshUrl: string;          // wss://…/mesh/ws (le token y est ajouté)
  token: string;
  pollBase: string;         // https://…/mesh (dérivé de meshUrl)
  fetchImpl?: typeof fetch; // injectable pour tests
  wsFactory?: (url: string) => WsLike; // injectable pour tests
  now?: () => number;
  backoffMaxMs?: number;
  reconnect?: boolean;      // faux en test (pas de timers flottants)
}

export function derivePollBase(meshUrl: string): string {
  return meshUrl.replace(/\/ws\/?$/, '');
}

export class Signaling implements SignalingTransport {
  private ws: WsLike | null = null;
  private messageHandlers: Array<(raw: string) => void> = [];
  private statusHandlers: Array<(s: 'open' | 'closed' | 'polling' | 'dead') => void> = [];
  private pollQueue: string[] = [];
  private pending: string[] = []; // messages émis avant l'ouverture de la socket
  private cursor = 0;
  attempts = 0;
  state: 'ws' | 'poll' | 'dead' = 'ws';
  private closed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<Pick<SignalingOptions, 'fetchImpl' | 'wsFactory' | 'now' | 'backoffMaxMs'>> & SignalingOptions;

  constructor(options: SignalingOptions) {
    this.opts = {
      ...options,
      fetchImpl: options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
      wsFactory: options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike),
      now: options.now ?? ((): number => Date.now()),
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      reconnect: options.reconnect ?? true,
    };
  }

  connect(): void {
    if (this.closed) return;
    if (this.state === 'poll') { void this.startPolling(); return; }
    let socket: WsLike;
    try {
      // Le PlayResponse porte une URL https (workers.dev) : le protocole WS
      // correct est wss — normalisé ICI, le serveur n'a pas à le savoir.
      const base = this.opts.meshUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      const url = `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.opts.token)}`;
      socket = this.opts.wsFactory(url);
    } catch { this.onWsFailed(); return; }
    this.ws = socket;
    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.state = 'ws';
      // purge de la file pré-ouverture : le JOIN attendu depuis connect()
      const queued = this.pending.splice(0);
      for (const raw of queued) { try { socket.send(raw); } catch { break; } }
      this.emit('open');
    });
    socket.addEventListener('message', (event?: unknown) => {
      const data = (event as { data?: unknown })?.data;
      if (typeof data === 'string') for (const handler of this.messageHandlers) handler(data);
    });
    socket.addEventListener('close', () => this.onWsFailed());
    socket.addEventListener('error', () => this.onWsFailed());
  }

  // Un échec WS n'est PAS une mort : 3 tentatives en backoff, puis polling.
  private onWsFailed(): void {
    this.ws = null;
    this.attempts += 1;
    if (this.closed) return;
    if (this.attempts >= 3) {
      this.state = 'poll';
      this.emit('polling');
      void this.startPolling();
      return;
    }
    if (this.opts.reconnect) {
      const base = Math.min(500 * 2 ** (this.attempts - 1), this.opts.backoffMaxMs);
      const delay = Math.round(base * (0.7 + Math.random() * 0.6)); // jitter ±30 %
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    } else {
      this.emit('closed');
    }
  }

  private async startPolling(): Promise<void> {
    if (this.closed) return;
    // montée en attente + tour descendant
    const pending = this.pollQueue.splice(0);
    try {
      if (pending.length) {
        await this.opts.fetchImpl(`${this.opts.pollBase}/send?token=${encodeURIComponent(this.opts.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(JSON.parse(pending[0])) } as RequestInit);
        // une seule montée par tour en mode dégradé (pas de tempête de POST)
        if (pending.length > 1) this.pollQueue.unshift(...pending.slice(1));
      }
      const response = await this.opts.fetchImpl(`${this.opts.pollBase}/poll?token=${encodeURIComponent(this.opts.token)}&cursor=${this.cursor}`);
      if (!response.ok) { this.failPoll(); return; }
      const body = (await response.json()) as { cursor?: number; events?: string[] };
      if (typeof body.cursor === 'number') this.cursor = body.cursor;
      for (const raw of body.events ?? []) for (const handler of this.messageHandlers) handler(raw);
    } catch { this.failPoll(); return; }
    if (this.state === 'poll' && !this.closed) this.pollTimer = setTimeout(() => { void this.startPolling(); }, 4000);
  }

  // Le polling échoue à son tour → pas de mesh pour cette session (origin).
  private failPoll(): void {
    this.state = 'dead';
    this.emit('dead');
  }

  send(raw: string): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(raw);
    else if (this.ws && this.state === 'ws') this.pending.push(raw); // en attente d'ouverture
    else if (this.state === 'poll') this.pollQueue.push(raw);
    // état dead : on jette (le loader retombe sur origin).
  }

  onMessage(handler: (raw: string) => void): void { this.messageHandlers.push(handler); }
  onStatus(handler: (s: 'open' | 'closed' | 'polling' | 'dead') => void): void { this.statusHandlers.push(handler); }
  private emit(status: 'open' | 'closed' | 'polling' | 'dead'): void { for (const handler of this.statusHandlers) handler(status); }

  get transport(): 'ws' | 'poll' | 'dead' { return this.state; }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(1000, 'client-close'); } catch { /* déjà mort */ }
    this.ws = null;
    this.emit('closed');
  }
}
