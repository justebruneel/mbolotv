import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';

export interface ParsedChannel { title: string; tvgId?: string; tvgLogo?: string; groupTitle?: string; url: string; }
const EXTINF_ATTRIBUTE_PATTERN = /([a-zA-Z_-]+)="([^"]*)"/g;
const VIDEO_EXTENSIONS = new Set(['m3u8', 'ts', 'mp4', 'mpd', 'mpeg', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'mp3', 'aac']);

export function isFolderMarker(title: string): boolean { return /^#{2,}.+#{2,}$/.test(title.trim()); }
function isContainerUrl(url: string): boolean { try { return new URL(url).pathname.toLowerCase().endsWith('.m3u'); } catch { return false; } }
function hasVideoExtension(url: string): boolean { try { return VIDEO_EXTENSIONS.has(new URL(url).pathname.toLowerCase().split('.').pop() ?? ''); } catch { return false; } }
function isSuspiciousTitle(title: string): boolean { return /(^|\s)(playlist|folder|dossier)(\s|$)/i.test(title) || isFolderMarker(title); }
function isDirectoryEntry(pending: { attributes: Record<string, string>; displayName: string }, url: string): boolean { return isFolderMarker(pending.displayName) || isContainerUrl(url) || (isSuspiciousTitle(pending.attributes['tvg-name'] || pending.displayName) && !hasVideoExtension(url)); }
function parseAttributes(line: string): Record<string, string> { const attributes: Record<string, string> = {}; for (const match of line.matchAll(EXTINF_ATTRIBUTE_PATTERN)) attributes[match[1]] = match[2]; return attributes; }
function normalizeLogoUrl(logo: string | undefined): string | undefined { if (!logo) return undefined; if (logo.startsWith('//')) return `https:${logo}`; return logo; }

export function parseM3u(content: string): ParsedChannel[] { const channels: ParsedChannel[] = []; const parser = createParser(channels); for (const line of content.split(/\r?\n/)) parser.handleLine(line); return channels; }

export async function parseM3uStream(input: Readable | ReadableStream<Uint8Array>, options: { maxBytes?: number } = {}): Promise<ParsedChannel[]> {
  const channels: ParsedChannel[] = [];
  await parseM3uStreamBatched(input, { ...options, batchSize: Number.MAX_SAFE_INTEGER, onBatch: (batch) => { channels.push(...batch); } });
  return channels;
}

export async function parseM3uStreamBatched(input: Readable | ReadableStream<Uint8Array>, options: { maxBytes?: number; batchSize?: number; onBatch: (batch: ParsedChannel[]) => Promise<void> | void }): Promise<number> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const batchSize = Math.max(1, options.batchSize ?? 5000);
  const source = input instanceof Readable ? input : Readable.fromWeb(input as import('node:stream/web').ReadableStream);
  let received = 0;
  let total = 0;
  const counter = new Transform({ transform(chunk: Buffer | string, _encoding, callback) { received += chunk.length; callback(received > maxBytes ? new Error('Contenu trop volumineux') : null, chunk); } });
  const parser = createParser([], (entry) => { total += 1; return entry; }, batchSize);
  const rl = createInterface({ input: source.pipe(counter), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    parser.handleLine(rawLine);
    const ready = parser.takeBatch();
    if (ready) await options.onBatch(ready);
  }
  const remaining = parser.takeRemaining();
  if (remaining.length > 0) await options.onBatch(remaining);
  return total;
}

type Parser = { handleLine: (rawLine: string) => void; takeBatch: () => ParsedChannel[] | null; takeRemaining: () => ParsedChannel[] };
function createParser(channels: ParsedChannel[], onEntry?: (entry: ParsedChannel) => ParsedChannel, batchSize?: number): Parser {
  let pending: { attributes: Record<string, string>; displayName: string } | null = null;
  let inGroup = '';
  let batch: ParsedChannel[] = [];
  let readyBatch: ParsedChannel[] | null = null;
  const push = (entry: ParsedChannel) => {
    const value = onEntry ? onEntry(entry) : entry;
    if (batchSize) {
      batch.push(value);
      if (batch.length >= batchSize && !readyBatch) { readyBatch = batch; batch = []; }
    } else channels.push(value);
  };
  return {
    handleLine(rawLine: string): void {
      const line = rawLine.trim();
      if (!line || line.startsWith('#EXTM3U')) return;
      if (line.startsWith('#EXTGRP:')) { inGroup = line.slice(8).trim(); return; }
      if (line.startsWith('#EXTINF:')) { pending = { attributes: parseAttributes(line), displayName: line.replace(/^#EXTINF:[^,]*,\s*/, '').trim() }; return; }
      if (line.startsWith('#')) return;
      if (pending && /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        const title = pending.attributes['tvg-name'] || pending.displayName.split(';')[0]?.trim() || pending.attributes['tvg-id'] || 'Sans titre';
        if (!isDirectoryEntry(pending, line)) push({ title, tvgId: pending.attributes['tvg-id'] || undefined, tvgLogo: normalizeLogoUrl(pending.attributes['tvg-logo']) || undefined, groupTitle: pending.attributes['group-title'] || inGroup || undefined, url: line });
      }
      pending = null;
    },
    takeBatch(): ParsedChannel[] | null { const value = readyBatch; readyBatch = null; return value; },
    takeRemaining(): ParsedChannel[] { const value = batch; batch = []; return value; },
  };
}
