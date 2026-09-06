// Adapter Vidzy : page /embed-{code}.html → setup video.js obfusqué → HLS direct.
// Protocole observé live (embed-p731ofuec673.html, 2026-09-06) :
//   GET {embed} → HTML ; sources: [{src: (function(s){…})("<B64>"), type: x-mpegURL}]
//   Décodage : atob → reverse → XOR par octet, clé kk = (0x3d + i*89 + H) & 255
//   avec H = somme des charcodes de location.hostname. Un décodage avec un
//   mauvais host retombe sur le leurre « …/troll/master.m3u8 » (fsvid.lol).
//   Certaines réponses mux encodent le chemin avec des virgules (fssMuxT de
//   la page) : …/,CODE,.urlset/master.m3u8?… → …/CODE/index-v1-a1.m3u8?…
//   L'URL CDN (u*.vidzy.cc) répond au Range probe avec UA navigateur ; le
//   video-proxy (UA "Mozilla/5.0") relaie playlist + segments (réécriture
//   signée des enfants, cf. voe). Jeton t= frais par chargement de page :
//   résolution AU CLIC, jamais de pré-chargement.
import { resolveRelay } from '../relay.js';
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';
import { fetchEmbedText, probeDirectUrl, withAttempts } from './http.js';

export const HOST = 'vidzy';

const CODE_PATTERN = /^[a-z0-9]{8,24}$/;
// Blob base64 du setup video.js (src: (function(s){…})("<B64>")).
const SRC_BLOB_PATTERN = /sources:\s*\[\{src:[\s\S]*?\)\("([A-Za-z0-9+/=]{40,})"\)/;

const MIRROR_DEFAULTS = ['https://vidzy.cc'];

export function mirrorsFromEnv(env) {
  const raw = String(env?.VIDZY_MIRRORS ?? '').trim();
  if (!raw) return [...MIRROR_DEFAULTS];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((entry) => String(entry).trim().replace(/\/+$/, '')).filter((entry) => /^https?:\/\//i.test(entry));
    }
  } catch { /* repli CSV */ }
  const list = raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\//i.test(entry));
  return list.length > 0 ? list : [...MIRROR_DEFAULTS];
}

/**
 * Accepte : URL embed complète (/embed-{code}.html ou tout href https),
 * chemin nu, ou code. Lève INVALID sinon.
 */
export function parse(input) {
  const value = String(input ?? '').trim();
  if (!value) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Vidzy manquant');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'URL Vidzy invalide');
  }
  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw extractorError(ExtractorErrorCode.INVALID, 'URL Vidzy invalide');
    }
    return { embedUrl: `${parsed.origin}${parsed.pathname}${parsed.search}` };
  }
  const fromPath = /embed-([a-z0-9]{8,24})\.html/i.exec(value);
  const code = fromPath?.[1] ?? value.toLowerCase();
  if (!CODE_PATTERN.test(code)) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Vidzy invalide');
  return { code };
}

/**
 * Décode le blob du setup video.js côté serveur, avec le hostname qui a
 * servi de clé (celui de l'embed chargée). atob → reverse → XOR kk.
 * Retourne null si le résultat n'est pas une URL (H host ≠ host d'émission
 * du blob → sortie illisible ; le leurre troll est filtré par le garde apex).
 */
export function decodeVidzyUrl(blob, hostname) {
  let h = 0;
  for (const ch of String(hostname)) h = (h + ch.charCodeAt(0)) & 255;
  let bytes;
  try {
    bytes = atob(String(blob));
  } catch {
    return null;
  }
  const reversed = [...bytes].reverse().join('');
  let out = '';
  for (let i = 0; i < reversed.length; i += 1) {
    out += String.fromCharCode(reversed.charCodeAt(i) ^ ((0x3d + i * 89 + h) & 255));
  }
  return /^https?:\/\//.test(out) ? out : null;
}

/**
 * Repli fssMuxT de la page : les réponses mux encodent le média playlist
 * derrière des virgules — …/,CODE,.urlset/master.m3u8?… devient
 * …/CODE/index-v1-a1.m3u8?… (le master pointe déjà le bon fichier sinon).
 */
export function reconstructVidzyUrl(raw) {
  const value = String(raw ?? '');
  if (!value.includes(',.urlset/master.m3u8')) return value;
  const qi = value.indexOf('?');
  const query = qi >= 0 ? value.slice(qi) : '';
  const path = qi >= 0 ? value.slice(0, qi) : value;
  const ci = path.indexOf('/,');
  if (ci < 0) return value;
  const pre = path.slice(0, ci);
  const after = path.slice(ci + 2);
  const cm = after.indexOf(',');
  const code = cm >= 0 ? after.slice(0, cm) : after;
  return `${pre}/${code}/index-v1-a1.m3u8${query}`;
}

function extractVidzyTitle(html) {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(String(html ?? ''));
  if (!match) return null;
  return match[1].replace(/\s*[-|–]\s*(Vidzy|French Stream).*$/i, '').trim() || null;
}

/**
 * Résout un embed en HLS direct vérifié (probe Range).
 * Entrée : URL complète (cas fiches) ou code nu (miroirs VIDZY_MIRRORS).
 * Le jeton HLS du CDN est lié à l'IP qui a chargé la page embed (vérifié
 * live : émis côté Cloudflare → 403 côté relais résidentiel ET direct).
 * D'où deux stratégies cohérentes, tentées en séquence :
 *   'auto'  : page et probe en direct d'abord (1 fetch cas courant) ;
 *   'relay' : page ET probe forcées par le relais résidentiel — jeton émis
 *             et consommé par la même IP.
 */
async function resolveVia(env, embedUrl, via, origin) {
  const page = await fetchEmbedText(env, embedUrl, { via });
  const blob = SRC_BLOB_PATTERN.exec(page.text)?.[1];
  if (!blob) throw extractorError(ExtractorErrorCode.DEAD, 'Player Vidzy sans source (fichier retiré ou player changé)');
  // La clé XOR est le hostname VU PAR LE NAVIGATEUR. Via relais, response.url
  // est l'URL du relais — le hostname réel est celui de l'embed demandée.
  let pageHost = '';
  try {
    pageHost = (via === 'relay' ? new URL(embedUrl) : new URL(page.finalUrl ?? embedUrl)).hostname.toLowerCase();
  } catch {
    throw extractorError(ExtractorErrorCode.RETRYABLE, 'URL finale Vidzy invalide');
  }
  const decoded = decodeVidzyUrl(blob, pageHost);
  if (!decoded) throw extractorError(ExtractorErrorCode.DEAD, 'Source Vidzy illisible (player changé ?)');
  const direct = reconstructVidzyUrl(decoded);
  // Garde anti-exfiltration : le CDN doit être sous l'apex du miroir —
  // écarte aussi le leurre s1.fsvid.lol/troll en cas de host trompeur.
  try {
    const host = new URL(direct).hostname.toLowerCase();
    const root = pageHost.replace(/^www\./, '').split('.').slice(-2).join('.');
    if (!host.endsWith(root)) throw extractorError(ExtractorErrorCode.DEAD, 'URL CDN Vidzy inattendue');
  } catch (error) {
    if (error instanceof ExtractorError) throw error;
    throw extractorError(ExtractorErrorCode.DEAD, 'URL CDN Vidzy inattendue');
  }
  const probeAttempts = [];
  const ok = await probeDirectUrl(env, direct, origin, probeAttempts, { via: via === 'relay' ? 'relay' : 'auto' });
  if (!ok) throw withAttempts(extractorError(ExtractorErrorCode.RETRYABLE, 'CDN Vidzy injoignable (vérification)'), probeAttempts);
  return { urls: [direct], referer: origin, title: extractVidzyTitle(page.text) };
}

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
      lastError = extractorError(ExtractorErrorCode.INVALID, 'URL Vidzy invalide');
      continue;
    }
    const strategies = resolveRelay(env, embedUrl).url !== embedUrl ? ['auto', 'relay'] : ['auto'];
    for (const via of strategies) {
      try {
        return await resolveVia(env, embedUrl, via, origin);
      } catch (error) {
        lastError = error;
        // INVALID/DEAD = verdict sur la page elle-même : changer de chemin
        // n'y rien (le relais sert la même page). 'auto' qui tombe sur le
        // relais en interne a déjà consommé l'option 'relay'.
        if (error instanceof ExtractorError && (error.code === ExtractorErrorCode.DEAD || error.code === ExtractorErrorCode.INVALID)) break;
        if (!(error instanceof ExtractorError)) break;
      }
    }
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Vidzy injoignable');
}

export const _internal = { MIRROR_DEFAULTS, CODE_PATTERN, SRC_BLOB_PATTERN };
