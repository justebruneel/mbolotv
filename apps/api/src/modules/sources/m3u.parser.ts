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
  const lines = content.split(/\r?\n/);

  let pending: { attributes: Record<string, string>; displayName: string } | null = null;
  let inGroup = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTGRP:')) {
      inGroup = line.slice(8).trim();
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const displayPart = line.replace(/^#EXTINF:[^,]*,\s*/, '');
      pending = {
        attributes: parseAttributes(line),
        displayName: displayPart.trim(),
      };
      continue;
    }

    if (line.startsWith('#')) continue;

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
        continue;
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
  }

  return channels;
}