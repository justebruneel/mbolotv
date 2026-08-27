import { EpgProvider } from './epg-provider.interface';
import { SafeFetcher } from '../../sources/safe-fetcher';

function buildXtreamXmltvUrl(connection: Record<string, string>, epgUrl?: string | null): string | null {
  if (epgUrl?.trim()) return epgUrl.trim();
  const host = connection.host ?? connection.url ?? connection.server;
  const username = connection.username;
  const password = connection.password;
  if (!host || !username || !password) return null;
  const base = host.startsWith('http') ? host : `http://${host}`;
  const clean = base.replace(/\/+$/, '');
  return `${clean}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
}

export class XtreamEpgProvider implements EpgProvider {
  readonly name = 'xtream';
  private readonly url: string | null;
  private readonly fetcher: SafeFetcher;

  constructor(connection: Record<string, string>, epgUrl: string | null | undefined, fetcher = new SafeFetcher()) {
    this.url = buildXtreamXmltvUrl(connection, epgUrl ?? null);
    this.fetcher = fetcher;
  }

  getSourceUrl(): string | null {
    return this.url;
  }

  async fetchXmltv(): Promise<ReadableStream<Uint8Array>> {
    if (!this.url) throw new Error('Aucune URL EPG Xtream disponible');
    const result = await this.fetcher.fetchStream(this.url, {
      maxBytes: 512 * 1024 * 1024,
      streamTimeoutMs: 15 * 60_000,
    });
    if (!result.ok || !result.stream) throw new Error(result.error ?? `Echec fetch Xtream EPG`);
    let stream = result.stream as unknown as ReadableStream<Uint8Array>;
    if (this.url.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
      try {
        stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      } catch {}
    }
    return stream;
  }
}
