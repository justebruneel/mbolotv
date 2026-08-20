import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function isPrivateIp(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) return isPrivateIp(mappedIpv4[1]);
  const ip = isIP(normalized);
  if (ip === 4) {
    const parts = normalized.split('.').map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return true;
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (ip === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
    return false;
  }
  return true;
}

export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { throw new BadRequestException('URL fournisseur invalide'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequestException('Protocole fournisseur non autorisé');
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!hostname || /[\[\]]/.test(hostname)) throw new BadRequestException('Nom d’hôte fournisseur invalide');
  if (isIP(hostname) !== 0 && isPrivateIp(hostname)) throw new BadRequestException('Adresse IP privée ou locale interdite');
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) throw new BadRequestException('Adresse IP privée ou locale interdite');
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Hôte fournisseur introuvable ou DNS indisponible');
  }
  return url;
}

export interface FetchResult { ok: boolean; status: number; latencyMs: number; body?: string; contentType?: string; error?: string; finalUrl?: string; }
export interface StreamFetchResult { ok: boolean; status: number; latencyMs: number; stream?: ReadableStream<Uint8Array>; contentType?: string; error?: string; finalUrl?: string; }
export interface FetchOptions { maxBytes?: number; headers?: Record<string, string>; timeoutMs?: number; userAgent?: string; signal?: AbortSignal; }

function safeError(error: unknown): string { return error instanceof BadRequestException ? error.message : 'Connexion fournisseur impossible'; }

export class SafeFetcher {
  async fetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const startedAt = Date.now();
    let url: URL;
    try { url = await assertSafeUrl(rawUrl); } catch (error) { return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: safeError(error) }; }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: 'Import annulé' };
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT, accept: '*/*', ...options.headers } });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: 'Redirection sans destination' };
          url = await assertSafeUrl(new URL(location, url).toString()); continue;
        }
        if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: `Réponse HTTP ${response.status}` }; }
        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (contentLength > maxBytes) { await response.body?.cancel(); return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: 'Contenu trop volumineux' }; }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: 'Contenu trop volumineux' };
        return { ok: true, status: response.status, latencyMs: Date.now() - startedAt, body: Buffer.from(bytes).toString('utf8'), contentType: response.headers.get('content-type') ?? undefined, finalUrl: url.toString() };
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'UNKNOWN';
        return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: options.signal?.aborted ? 'Import annulé' : reason === 'AbortError' ? 'Délai dépassé chez le fournisseur' : safeError(error) };
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    }
    return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: 'Trop de redirections fournisseur' };
  }

  async fetchStream(rawUrl: string, options: FetchOptions & { streamTimeoutMs?: number } = {}): Promise<StreamFetchResult> {
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    const timeoutMs = options.streamTimeoutMs ?? 15 * 60_000;
    const startedAt = Date.now();
    let url: URL;
    try { url = await assertSafeUrl(rawUrl); } catch (error) { return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: safeError(error) }; }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: 'Import annulé' };
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let keepAbortListener = false;
      try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT, accept: '*/*', ...options.headers } });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: 'Redirection sans destination' };
          url = await assertSafeUrl(new URL(location, url).toString()); continue;
        }
        if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: `Réponse HTTP ${response.status}` }; }
        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (contentLength > maxBytes) { await response.body?.cancel(); return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, error: 'Contenu trop volumineux' }; }
        keepAbortListener = true;
        return { ok: true, status: response.status, latencyMs: Date.now() - startedAt, stream: response.body ?? undefined, contentType: response.headers.get('content-type') ?? undefined, finalUrl: url.toString() };
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'UNKNOWN';
        return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: options.signal?.aborted ? 'Import annulé' : reason === 'AbortError' ? 'Délai dépassé chez le fournisseur' : safeError(error) };
      } finally { clearTimeout(timer); if (!keepAbortListener) options.signal?.removeEventListener('abort', abort); }
    }
    return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: 'Trop de redirections fournisseur' };
  }
}
