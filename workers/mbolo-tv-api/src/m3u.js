const EXTINF_ATTRIBUTE_PATTERN = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
const VIDEO_EXTENSIONS = new Set(['m3u8', 'ts', 'mp4', 'mpd', 'mpeg', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'mp3', 'aac']);
// Extensions réservées aux fichiers VOD (jamais des flux live) : un fichier
// .mp4/.mkv/.avi pointé par une playlist est un film, pas une chaîne.
export const VOD_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'm4v', 'webm']);
export function isVodUrl(url) { try { return VOD_EXTENSIONS.has(new URL(url).pathname.toLowerCase().split('.').pop() ?? ''); } catch { return false; } }
export function isFolderMarker(title) { return /^#{2,}.+#{2,}$/.test(title.trim()); }
function isContainerUrl(url) { try { return new URL(url).pathname.toLowerCase().endsWith('.m3u'); } catch { return false; } }
function hasVideoExtension(url) { try { return VIDEO_EXTENSIONS.has(new URL(url).pathname.toLowerCase().split('.').pop() ?? ''); } catch { return false; } }
function isSuspiciousTitle(title) { return /(^|\s)(playlist|folder|dossier)(\s|$)/i.test(title) || isFolderMarker(title); }
function isDirectoryEntry(pending, url) { return isFolderMarker(pending.displayName) || isContainerUrl(url) || (isSuspiciousTitle(pending.attributes['tvg-name'] || pending.displayName) && !hasVideoExtension(url)); }
function parseAttributes(line) { const attributes = {}; for (const match of line.matchAll(EXTINF_ATTRIBUTE_PATTERN)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''; return attributes; }
function normalizeLogoUrl(logo) { if (!logo) return undefined; return logo.startsWith('//') ? `https:${logo}` : logo; }

export function createM3uLineParser(push, pushVod) {
  let pending = null;
  let inGroup = '';
  let emitted = 0;
  return {
    // Async : le consommateur peut ingérer chaque lot au fil du parse
    // (await sur une valeur non-promise ne coûte qu'une microtâche).
    async handleLine(rawLine) {
      const line = rawLine.replace(/^\uFEFF/, '').trim();
      if (!line || line.startsWith('#EXTM3U')) return;
      if (line.startsWith('#EXTGRP:')) { inGroup = line.slice(8).trim(); return; }
      if (line.startsWith('#EXTINF:')) { pending = { attributes: parseAttributes(line), displayName: line.replace(/^#EXTINF:[^,]*,\s*/, '').trim() }; return; }
      if (line.startsWith('#')) return;
      if (pending && /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        const title = pending.attributes['tvg-name'] || pending.displayName.split(';')[0]?.trim() || pending.attributes['tvg-id'] || 'Sans titre';
        if (!isDirectoryEntry(pending, line)) {
          // Fichier VOD (extension réservée) : routé vers VodItem au lieu de
          // polluer le catalogue live. group-title devient la catégorie.
          if (pushVod && isVodUrl(line)) {
            await pushVod({ kind: 'MOVIE', externalId: line, title, posterUrl: normalizeLogoUrl(pending.attributes['tvg-logo']) ?? null, categoryTitle: pending.attributes['group-title'] || inGroup || null, url: line });
          } else {
            await push({ title, tvgId: pending.attributes['tvg-id'] || undefined, tvgLogo: normalizeLogoUrl(pending.attributes['tvg-logo']), groupTitle: pending.attributes['group-title'] || inGroup || undefined, url: line });
          }
          emitted += 1;
        }
      }
      pending = null;
    },
    count: () => emitted,
  };
}

// onProgress(lignesTraitees) optionnel : l'importeur y branche son heartbeat
// (persistMetrics throttlé) pour signaler un long téléchargement/parse au cron.
export async function parseM3uStream(input, push, maxBytes = 512 * 1024 * 1024, pushVod, onProgress) {
  if (!input) throw new Error('Playlist M3U sans contenu');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const parser = createM3uLineParser(push, pushVod);
  let received = 0;
  let carry = '';
  let handled = 0;
  const reader = input.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error(`Playlist trop volumineuse (${received} octets, limite ${maxBytes})`); }
    const text = carry + decoder.decode(value, { stream: true });
    const split = text.split(/\r?\n/);
    carry = split.pop() ?? '';
    for (const line of split) { await parser.handleLine(line); handled += 1; }
    if (onProgress) await onProgress(handled);
  }
  carry += decoder.decode();
  if (carry) { await parser.handleLine(carry); handled += 1; }
  if (onProgress) await onProgress(handled);
  if (parser.count() === 0) throw new Error('La playlist M3U ne contient aucune chaîne exploitable, catalogue existant conservé');
  return parser.count();
}
