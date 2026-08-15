import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

export function isPrivateIp(address: string): boolean {
  const ip = isIP(address);
  if (ip === 4) {
    const parts = address.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  if (ip === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return true;
}

export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('URL invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Protocole non autorisé (http/https uniquement)');
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new BadRequestException('Adresse IP privée ou locale interdite');
  }
  return url;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  body?: string;
  error?: string;
  finalUrl?: string;
}

export interface StreamFetchResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  stream?: ReadableStream<Uint8Array>;
  error?: string;
  finalUrl?: string;
}

export interface FetchOptions {
  maxBytes?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  userAgent?: string;
}

export class SafeFetcher {
  async fetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const startedAt = Date.now();
    let url = await assertSafeUrl(rawUrl);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': options.userAgent ?? 'MboloTV/0.1', accept: '*/*', ...options.headers },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return {
              ok: false,
              status: response.status,
              latencyMs: Date.now() - startedAt,
              error: 'Redirection sans destination',
            };
          }
          url = await assertSafeUrl(new URL(location, url).toString());
          continue;
        }

        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: `Réponse HTTP ${response.status}`,
          };
        }

        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (contentLength > maxBytes) {
          return {
            ok: false,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: 'Contenu trop volumineux',
          };
        }

        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) {
          return {
            ok: false,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: 'Contenu trop volumineux',
          };
        }

        return {
          ok: true,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          body: Buffer.from(bytes).toString('utf8'),
          finalUrl: url.toString(),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'UNKNOWN';
        return {
          ok: false,
          status: 0,
          latencyMs: Date.now() - startedAt,
          error: reason === 'AbortError' ? 'Délai dépassé' : 'Connexion impossible',
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: 'Trop de redirections',
    };
  }

  async fetchStream(
    rawUrl: string,
    options: FetchOptions & { streamTimeoutMs?: number } = {},
  ): Promise<StreamFetchResult> {
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    const timeoutMs = options.streamTimeoutMs ?? 15 * 60_000;
    const startedAt = Date.now();
    let url = await assertSafeUrl(rawUrl);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': options.userAgent ?? 'MboloTV/0.1', accept: '*/*', ...options.headers },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return {
              ok: false,
              status: response.status,
              latencyMs: Date.now() - startedAt,
              error: 'Redirection sans destination',
            };
          }
          url = await assertSafeUrl(new URL(location, url).toString());
          continue;
        }

        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: `Réponse HTTP ${response.status}`,
          };
        }

        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (contentLength > maxBytes) {
          return {
            ok: false,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: 'Contenu trop volumineux',
          };
        }

        return {
          ok: true,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          stream: response.body ?? undefined,
          finalUrl: url.toString(),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'UNKNOWN';
        return {
          ok: false,
          status: 0,
          latencyMs: Date.now() - startedAt,
          error: reason === 'AbortError' ? 'Délai dépassé' : 'Connexion impossible',
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: 'Trop de redirections',
    };
  }
}