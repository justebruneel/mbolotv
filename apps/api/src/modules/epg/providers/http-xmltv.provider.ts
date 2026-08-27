import { EpgProvider } from './epg-provider.interface';
import { SafeFetcher } from '../../sources/safe-fetcher';

export class HttpXmltvProvider implements EpgProvider {
  readonly name: string;
  private readonly url: string;
  private readonly fetcher: SafeFetcher;

  constructor(name: string, url: string, fetcher = new SafeFetcher()) {
    this.name = name;
    this.url = url;
    this.fetcher = fetcher;
  }

  getSourceUrl(): string | null {
    return this.url;
  }

  async fetchXmltv(): Promise<ReadableStream<Uint8Array>> {
    const result = await this.fetcher.fetchStream(this.url, {
      maxBytes: 512 * 1024 * 1024,
      streamTimeoutMs: 15 * 60_000,
      headers: { 'accept-encoding': 'gzip, deflate' },
    });
    if (!result.ok || !result.stream) {
      throw new Error(result.error ?? `Echec fetch EPG ${this.name}: ${this.url}`);
    }
    let stream = result.stream as unknown as ReadableStream<Uint8Array>;
    // .gz : décompression Web (fetch décompresse déjà content-encoding, mais fichier .gz sur disque a besoin de DecompressionStream)
    if (this.url.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
      try {
        stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      } catch {
        // fallback : laisse brut, le parser échouera et sera loggé
      }
    }
    return stream;
  }
}
