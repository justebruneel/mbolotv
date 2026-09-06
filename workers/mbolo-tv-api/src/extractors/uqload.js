// Adapter Uqload : page /embed-{id}.html → packer Dean Edwards → MP4 direct.
// Le setup jwplayer est packé en P,A,C,K classique (même famille que
// unpack.js) avec { file: [{ file: "https://strm….uqload.vc/…mp4?…" }] }.
// Les query tokens (?t=&s=&e=) sont probés au resolve ; le lecteur
// re-résout via refetch si expirés.
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';
import { fetchEmbedText, probeDirectUrl, withAttempts } from './http.js';
import { findPackedBlocks, unpackPacker } from './unpack.js';

export const HOST = 'uqload';

const CODE_PATTERN = /^[a-z0-9]{8,24}$/;

const MIRROR_DEFAULTS = ['https://uqload.vc'];

export function mirrorsFromEnv(env) {
  const raw = String(env?.UQLOAD_MIRRORS ?? '').trim();
  if (!raw) return [...MIRROR_DEFAULTS];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((entry) => String(entry).trim().replace(/\/+$/, '')).filter((entry) => /^https?:\/\//.test(entry));
    }
  } catch { /* repli CSV */ }
  const list = raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\//.test(entry));
  return list.length > 0 ? list : [...MIRROR_DEFAULTS];
}

/**
 * Accepte : URL embed complète (/embed-{id}.html), ou code nu.
 * Lève INVALID sinon.
 */
export function parse(input) {
  const value = String(input ?? '').trim();
  if (!value) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Uqload manquant');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'URL Uqload invalide');
  }
  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw extractorError(ExtractorErrorCode.INVALID, 'URL Uqload invalide');
    }
    return { embedUrl: `${parsed.origin}${parsed.pathname}${parsed.search}` };
  }
  const fromPath = /embed-([a-z0-9]{8,24})\.html/i.exec(value);
  const code = fromPath?.[1] ?? value.toLowerCase();
  if (!CODE_PATTERN.test(code)) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Uqload invalide');
  return { code };
}

/**
 * Extrait la première URL file: "https://…" du JS désobfusqué.
 * Prend le setup jwplayer (file:[{file:…}]), pas les pistes/thumbnails.
 */
export function extractFileUrl(unpackedJs) {
  const match = /file\s*:\s*\[\s*\{\s*file\s*:\s*"(https?:\/\/[^"]+)"/.exec(String(unpackedJs ?? ''))
    ?? /file\s*:\s*"(https?:\/\/[^"]+)"/.exec(String(unpackedJs ?? ''));
  return match?.[1] ?? null;
}

/**
 * Résout un embed en MP4 direct vérifié (probe Range).
 * Entrée : URL complète (cas fiches) ou code nu (miroirs UQLOAD_MIRRORS).
 */
export async function resolve(env, ref) {
  const parsed = typeof ref === 'string' ? parse(ref) : parse(ref?.embedUrl ?? ref?.url ?? ref?.code ?? ref?.id ?? '');
  const candidates = parsed.embedUrl
    ? [parsed.embedUrl]
    : mirrorsFromEnv(env).map((mirror) => `${mirror.replace(/\/+$/, '')}/embed-${parsed.code}.html`);
  let lastError = null;
  for (const embedUrl of candidates) {
    let origin = '';
    try {
      origin = `${new URL(embedUrl).origin}/`;
    } catch {
      lastError = extractorError(ExtractorErrorCode.INVALID, 'URL Uqload invalide');
      continue;
    }
    let page;
    try {
      page = await fetchEmbedText(env, embedUrl);
    } catch (error) {
      lastError = error;
      if (error instanceof ExtractorError && error.code !== ExtractorErrorCode.RETRYABLE && error.code !== ExtractorErrorCode.DEAD) throw error;
      continue;
    }
    const blocks = findPackedBlocks(page.text);
    let direct = null;
    for (const block of blocks) {
      try {
        direct = extractFileUrl(unpackPacker(block));
        if (direct) break;
      } catch { /* bloc non-setup : suivant */ }
    }
    // Repli : file: en clair (player non packé).
    if (!direct) direct = extractFileUrl(page.text);
    if (!direct) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'Player Uqload sans source (fichier retiré ou player changé)');
      continue;
    }
    // Garde anti-exfiltration : CDN du même hôte (strm*.uqload.*) attendu.
    try {
      const host = new URL(direct).hostname.toLowerCase();
      const embedHost = new URL(embedUrl).hostname.toLowerCase().replace(/^www\./, '');
      const root = embedHost.split('.').slice(-2).join('.');
      if (!host.endsWith(root)) {
        lastError = extractorError(ExtractorErrorCode.DEAD, 'URL CDN Uqload inattendue');
        continue;
      }
    } catch {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'URL CDN Uqload inattendue');
      continue;
    }
    const probeAttempts = [];
    const ok = await probeDirectUrl(env, direct, origin, probeAttempts);
    if (!ok) {
      lastError = withAttempts(extractorError(ExtractorErrorCode.RETRYABLE, 'CDN Uqload injoignable (vérification)'), probeAttempts);
      continue;
    }
    return { urls: [direct], referer: origin, title: null };
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Uqload injoignable');
}

export const _internal = { MIRROR_DEFAULTS, CODE_PATTERN };
