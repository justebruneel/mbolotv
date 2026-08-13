export interface ParsedChannel {
  title: string;
  tvgId?: string;
  tvgLogo?: string;
  groupTitle?: string;
  url: string;
}

const EXTINF_ATTRIBUTE_PATTERN = /([a-zA-Z_-]+)="([^"]*)"/g;

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