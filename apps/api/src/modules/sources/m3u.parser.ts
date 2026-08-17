import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';

export interface ParsedChannel {
  title: string;
  tvgId?: string;
  tvgLogo?: string;
  groupTitle?: string;
  url: string;
}

const EXTINF_ATTRIBUTE_PATTERN = /([a-zA-Z_-]+)="([^"]*)"/g;

export function isFolderMarker(title: string): boolean {
  return /^#{2,}.+#{2,}$/.test(title.trim());
}

const VIDEO_EXTENSIONS = new Set(['m3u8', 'ts', 'mp4', 'mpd', 'mpeg', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'mp3', 'aac']);

// Une URL de sous-playlist conteneur se termine explicitement par .m3u (pas .m3u8).
function isContainerUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith('.m3u');
  } catch {
    return false;
  }
}

function hasVideoExtension(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = path.split('.').pop() ?? '';
    return ext !== '' && VIDEO_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function isSuspiciousTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    /(^|\s)(playlist|folder|dossier|groupe|group|collection|pack|list)(\s|$)/.test(lower) ||
    isFolderMarker(title)
  );
}

function isDirectoryEntry(
  pending: { attributes: Record<string, string>; displayName: string },
  url: string,
): boolean {
  // Marqueur de dossier explicite (ex. "##### SPORTS #####").
  if (isFolderMarker(pending.displayName)) return true;
  // URL pointant explicitement vers un conteneur de playlist.
  if (isContainerUrl(url)) return true;
  // Titre suspect combiné à une URL sans extension vidéo identifiable.
  if (isSuspiciousTitle(pending.attributes['tvg-name'] || pending.displayName) && !hasVideoExtension(url)) {
    return true;
  }
  return false;
}

function parseAttributes(extinfLine: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of extinfLine.matchAll(EXTINF_ATTRIBUTE_PATTERN)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

export function parseM3u(content: string): ParsedChannel[] {
  const channels: ParsedChannel[] = [];
  const parser = createParser(channels);
  for (const rawLine of content.split(/\r?\n/)) {
    parser.handleLine(rawLine);
  }
  return channels;
}

/**
 * Parse un flux M3U ligne par ligne (readline) sans jamais charger le fichier
 * en mémoire. Les playlists fournisseurs atteignent régulièrement 50-150 Mo :
 * un split/parse en une pièce ferait exploser le heap Node (string + copies).
 */
export async function parseM3uStream(
  input: Readable | ReadableStream<Uint8Array>,
  options: { maxBytes?: number } = {},
): Promise<ParsedChannel[]> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const source =
    input instanceof Readable ? input : Readable.fromWeb(input as import('node:stream/web').ReadableStream);

  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new Error('Contenu trop volumineux'));
        return;
      }
      callback(null, chunk);
    },
  });

  const channels: ParsedChannel[] = [];
  const parser = createParser(channels);
  const rl = createInterface({ input: source.pipe(counter), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    parser.handleLine(rawLine);
  }
  return channels;
}

function createParser(channels: ParsedChannel[]): { handleLine: (rawLine: string) => void } {
  let pending: { attributes: Record<string, string>; displayName: string } | null = null;
  let inGroup = '';

  return {
    handleLine(rawLine: string): void {
      const line = rawLine.trim();
      if (!line || line.startsWith('#EXTM3U')) return;

      if (line.startsWith('#EXTGRP:')) {
        inGroup = line.slice(8).trim();
        return;
      }

      if (line.startsWith('#EXTINF:')) {
        const displayPart = line.replace(/^#EXTINF:[^,]*,\s*/, '');
        pending = {
          attributes: parseAttributes(line),
          displayName: displayPart.trim(),
        };
        return;
      }

      if (line.startsWith('#')) return;

      if (pending && /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        const title =
          pending.attributes['tvg-name'] ||
          (pending.displayName || '').split(';')[0]?.trim() ||
          pending.attributes['tvg-id'] ||
          'Sans titre';

        // Les marqueurs de dossiers (ex. "##### SPORTS #####") et les entrées
        // qui pointent vers une playlist conteneur ne sont pas des chaînes.
        if (isDirectoryEntry(pending, line)) {
          pending = null;
          return;
        }

        channels.push({
          title,
          tvgId: pending.attributes['tvg-id'] || undefined,
          tvgLogo: pending.attributes['tvg-logo'] || undefined,
          groupTitle: pending.attributes['group-title'] || inGroup || undefined,
          url: line,
        });
      }
      pending = null;
    },
  };
}