// Réplique de m3u.parser.ts (createParser) : EXTINF + attributs, #EXTGRP,
// filtrage des entrées "dossier" et sous-playlists.
const EXTINF_ATTRIBUTE_PATTERN = /([a-zA-Z_-]+)="([^"]*)"/g;
const VIDEO_EXTENSIONS = new Set(['m3u8', 'ts', 'mp4', 'mpd', 'mpeg', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'mp3', 'aac']);

export function isFolderMarker(title) {
  return /^#{2,}.+#{2,}$/.test(title.trim());
}

function isContainerUrl(url) {
  try { return new URL(url).pathname.toLowerCase().endsWith('.m3u'); } catch { return false; }
}

function hasVideoExtension(url) {
  try { return VIDEO_EXTENSIONS.has(new URL(url).pathname.toLowerCase().split('.').pop() ?? ''); } catch { return false; }
}

function isSuspiciousTitle(title) {
  return /(^|\s)(playlist|folder|dossier)(\s|$)/i.test(title) || isFolderMarker(title);
}

function isDirectoryEntry(pending, url) {
  return isFolderMarker(pending.displayName)
    || isContainerUrl(url)
    || (isSuspiciousTitle(pending.attributes['tvg-name'] || pending.displayName) && !hasVideoExtension(url));
}

function parseAttributes(line) {
  const attributes = {};
  for (const match of line.matchAll(EXTINF_ATTRIBUTE_PATTERN)) attributes[match[1]] = match[2];
  return attributes;
}

function normalizeLogoUrl(logo) {
  if (!logo) return undefined;
  if (logo.startsWith('//')) return `https:${logo}`;
  return logo;
}

export function createM3uLineParser(push) {
  let pending = null;
  let inGroup = '';
  return {
    handleLine(rawLine) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#EXTM3U')) return;
      if (line.startsWith('#EXTGRP:')) { inGroup = line.slice(8).trim(); return; }
      if (line.startsWith('#EXTINF:')) { pending = { attributes: parseAttributes(line), displayName: line.replace(/^#EXTINF:[^,]*,\s*/, '').trim() }; return; }
      if (line.startsWith('#')) return;
      if (pending && /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        const title = pending.attributes['tvg-name'] || pending.displayName.split(';')[0]?.trim() || pending.attributes['tvg-id'] || 'Sans titre';
        if (!isDirectoryEntry(pending, line)) {
          push({
            title,
            tvgId: pending.attributes['tvg-id'] || undefined,
            tvgLogo: normalizeLogoUrl(pending.attributes['tvg-logo']) || undefined,
            groupTitle: pending.attributes['group-title'] || inGroup || undefined,
            url: line,
          });
        }
      }
      pending = null;
    },
  };
}

// Lecture streaming du ReadableStream avec plafond bytes (équivalent maxBytes).
export async function parseM3uStream(input, push, maxBytes = 512 * 1024 * 1024) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const parser = createM3uLineParser(push);
  let received = 0;
  let carry = '';
  const reader = input.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error('Contenu trop volumineux'); }
    const text = carry + decoder.decode(value, { stream: true });
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) parser.handleLine(line);
  }
  carry += decoder.decode();
  if (carry) parser.handleLine(carry);
}
