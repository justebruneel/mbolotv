// Adapter Filmoon (Byse) : wrapper kakaflix/kokoflix → SPA Byse → API 3 couches.
//
// Protocole reverse-engineered live (2026-09-06, codes dr9l7mdk03dk/gnxj7g0em09o) :
//  1. Wrapper 302/303 : kakaflix.lol/moon2/newPlayer.php?id=… et
//     kokoflix.lol/chamber_go.php?id=… → SPA Byse (bysebuho.com,
//     bysesayeveum.com) /e/<code>.
//  2. SPA shell : GET /api/videos/<code>/embed/details (header
//     x-embed-parent) → { embed_frame_url: "https://<player>/<seg>/<code>" }
//     où <seg> est ALÉATOIRE par requête — l'URL du player d'origine
//     (f7hyg4q.org aujourd'hui) doit être prise telle quelle, jamais
//     reconstruite.
//  3. Player origin (cross-origin) : appels signés par des en-têtes
//     x-embed-* :
//     a. POST /api/videos/access/challenge {} → { challenge_id, nonce }
//     b. POST /api/videos/access/attest { challenge_id, nonce, signature
//        ECDSA-P256(nonce, b64url, 64 octets), public_key JWK, client
//        {empreinte navigateur}, storage, attributes } → { token,
//        viewer_id, device_id, confidence } — confiance 0.55 acceptée, les
//        hachages d'empreinte ne sont pas vérifiés individuellement.
//     c. POST /api/videos/<code>/embed/captcha { fingerprint } →
//        { pow_nonce, pow_difficulty(=16), pow_token }
//     d. PoW local : hash maison « gr » (salsa20-like, table 512 mots) sur
//        "<nonce>:<s>" jusqu'à wr >= difficulty ; solution = String(s).
//        Difficulté 16 ≈ 60k hashes ≈ 1-4 s CPU Workers.
//     e. POST …/embed/captcha/verify { pow_token, solution, fingerprint }
//        → { status:"ok", token }
//     f. POST …/embed/playback { fingerprint } + header X-Captcha-Token →
//        { playback: { algorithm:"AES-256-GCM", key_parts[30], version,
//        iv, payload } }
//  4. Clé = concat(key_parts[version-1], key_parts[31-version-1]) (base64url,
//     32 octets) ; déchiffrage GCM du payload → { sources: [{url HLS,
//     quality,label,…}], tracks, poster_url }.
//  5. CDN (edge?-waw-sprintcdn.r66nv9ed.com) : le referer attendu est
//     <player-origin>/ ; master/variante/segments s'enchaînent en URLs
//     absolues. Le 404 du CDN signale un fichier retiré (verdict DEAD) —
//     observé sur le code gnxj7g0em09o avec jeton frais ET depuis le vrai
//     player navigateur.
import { resolveRelay } from '../relay.js';
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';
import { fetchEmbedText, probeDirectUrl, withAttempts } from './http.js';

export const HOST = 'filmoon';

const CODE_PATTERN = /^[a-z0-9]{8,32}$/;
const WRAPPER_PATTERN = /(?:kakaflix|kokoflix)\.lol$/i;
// Domaines SPA Byse (cible des 302/303 des wrappers) : code extrait de /e/<code>.
const SPA_PATTERN = /https?:\/\/([a-z0-9.-]+)\/e\/([a-z0-9]+)/i;

const MIRROR_DEFAULTS = ['https://kakaflix.lol', 'https://kokoflix.lol'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Emprunte d'empreinte : hachages affichés par le vrai player (SwiftShader
// headless). Le serveur ne vérifie pas chaque hash (confidence 0.55 acceptée)
// mais attend la forme complète du payload attest.
const CLIENT_FP = {
  architecture: 'x86',
  bitness: '64',
  platform: 'Windows',
  platform_version: '10.0',
  model: '',
  ua_full_version: '131.0.0.0',
  brand_full_versions: [
    { brand: 'Chromium', version: '131.0.0.0' },
    { brand: 'Not=A?Brand', version: '99.0.0.0' },
  ],
  pixel_ratio: 1,
  screen_width: 1280,
  screen_height: 720,
  color_depth: 24,
  languages: ['fr-FR'],
  timezone: 'Europe/Paris',
  hardware_concurrency: 8,
  device_memory: 8,
  touch_points: 0,
  webgl_vendor: 'Google Inc. (Google)',
  webgl_renderer:
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  canvas_hash: 'Sn5dlnQzLCbX03NQI8yavdMhkIfnuN3_RH2JpE-0yx0',
  audio_hash: 'RyBmlOc4cA7XhqmvkyO40eo8sOa5q-CFlrTnf70qADY',
  webgl_params_hash: 'W5M0nWhl6d8DuBEhxYLkPbt5GpFbRb7pBxV78OZJpXQ',
  fonts_hash: 'meA59YYTEHlp-axhZQ3TnSe6QOo7xjbMP3ymlhHesuc',
  codecs_hash: 'qJye5DfMLC0co_nw835Vyx_VcUOEnA01Coov9OtwHZs',
  media_devices: 'ai1ao1vi1',
  pointer_type: 'fine,hover',
};

// SHA-256 (WebCrypto) du nonce pour la signature ECDSA — voir signNonce.
const encoder = new TextEncoder();

export function mirrorsFromEnv(env) {
  const raw = String(env?.FILMOON_MIRRORS ?? '').trim();
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
 * Accepte : URL wrapper (kakaflix/kokoflix), URL SPA /e/<code>, code nu.
 * Lève INVALID sinon.
 */
export function parse(input) {
  const value = String(input ?? '').trim();
  if (!value) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Filmoon manquant');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'URL Filmoon invalide');
  }
  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw extractorError(ExtractorErrorCode.INVALID, 'URL Filmoon invalide');
    }
    if (WRAPPER_PATTERN.test(parsed.hostname)) {
      return { wrapperUrl: `${parsed.origin}${parsed.pathname}${parsed.search}` };
    }
    const spa = SPA_PATTERN.exec(value);
    if (spa) return { spaOrigin: `https://${spa[1]}`, code: spa[2].toLowerCase() };
    throw extractorError(ExtractorErrorCode.INVALID, 'URL Filmoon non reconnue (attendu kakaflix/kokoflix ou /e/<code>)');
  }
  if (!CODE_PATTERN.test(value.toLowerCase())) {
    throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Filmoon invalide');
  }
  return { code: value.toLowerCase() };
}

/** Suivi du 302/303 du wrapper → { spaOrigin, code }. Le wrapper est
 * instable depuis les IP datacenter (ETIMEDOUT intermittents observés live) :
 * 3 essais séquentiels avant de conclure. */
export async function followWrapper(env, wrapperUrl, attemptsOut) {
  const startedAt = Date.now();
  const note = (status, error) => {
    if (Array.isArray(attemptsOut)) {
      attemptsOut.push({ target: 'wrapper', ms: Date.now() - startedAt, ...(status ? { status } : {}), ...(error ? { error: String(error).slice(0, 120) } : {}) });
    }
  };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(wrapperUrl, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'fr-FR,fr;q=0.9',
          referer: 'https://french-stream.one/',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch {}
      const match = location ? SPA_PATTERN.exec(location) : null;
      if (!match) {
        note(response.status || 200);
        throw extractorError(
          response.status >= 400 ? ExtractorErrorCode.RETRYABLE : ExtractorErrorCode.DEAD,
          response.status >= 400
            ? `Wrapper Filmoon ${response.status}`
            : 'Wrapper Filmoon sans redirection Byse',
        );
      }
      note(response.status);
      return { spaOrigin: `https://${match[1]}`, code: match[2].toLowerCase() };
    } catch (error) {
      if (error instanceof ExtractorError && error.code !== ExtractorErrorCode.RETRYABLE) throw error;
      lastError = error;
      note(null, error instanceof Error ? error.message : error);
    }
  }
  if (lastError instanceof ExtractorError) throw lastError;
  throw extractorError(ExtractorErrorCode.RETRYABLE, 'Wrapper Filmoon injoignable');
}

/** POST JSON signé x-embed-* vers le player d'origine. Quand un relais
 * résidentiel couvre l'URL, le POST sort par lui : le jeton Byse est ensuite
 * lié à l'IP du relais — la seule que le proxy vidéo réutilisera sur les
 * segments (sprintcdn refuse 404 les .ts porteurs d'un jeton datacenter). */
async function apiPost(env, url, body, headers = {}, timeoutMs = 15_000) {
  const relayed = resolveRelay(env, url);
  const response = await fetch(relayed.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept-language': 'fr-FR,fr;q=0.9',
      'user-agent': UA,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...headers,
      ...relayed.headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await response.json(); } catch { /* réponse non-JSON */ }
  return { status: response.status, json };
}

/* ---------------------------------------------------------------------------
 * PoW Byse — hash « gr » (salsa20-like, table de 512 mots) réimplémenté en
 * Uint32Array pur depuis le bundle pow du player. Signature observée :
 * mêmes sorties que le bundle sur les vecteurs TESTNONCE/difficulté 8.
 * ------------------------------------------------------------------------- */
const GR_TABLE = 512;
const GR_MASK = GR_TABLE - 1;
const GR_ROUNDS = 2;
const GR_L = 2654435761;
const GR_H = 2246822519;

const rotl32 = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const mixQuarter = (s) => {
  s[0] = (s[0] + s[1]) >>> 0;
  s[3] = rotl32(s[3] ^ s[0], 16);
  s[2] = (s[2] + s[3]) >>> 0;
  s[1] = rotl32(s[1] ^ s[2], 12);
  s[0] = (s[0] + s[1]) >>> 0;
  s[3] = rotl32(s[3] ^ s[0], 8);
  s[2] = (s[2] + s[3]) >>> 0;
  s[1] = rotl32(s[1] ^ s[2], 7);
};

/** Hash maison Byse : entrée octets, sortie 8 mots Uint32. */
export function grHash(bytes) {
  const s = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < bytes.length; i += 1) {
    s[0] = (s[0] + bytes[i]) >>> 0;
    s[0] = rotl32(s[0], 7);
    mixQuarter(s);
  }
  for (let i = 0; i < 8; i += 1) mixQuarter(s);
  const table = new Uint32Array(GR_TABLE);
  for (let i = 0; i < GR_TABLE; i += 1) {
    mixQuarter(s);
    table[i] = (s[0] ^ s[2]) >>> 0;
  }
  for (let r = 0; r < GR_ROUNDS; r += 1) {
    for (let i = 0; i < GR_TABLE; i += 1) {
      const j = table[i] & GR_MASK;
      let c = (table[i] + table[j]) >>> 0;
      c = rotl32(c, 13);
      c = (c ^ Math.imul(table[(i + 1) & GR_MASK], GR_L)) >>> 0;
      table[i] = c;
      s[0] = (s[0] ^ c) >>> 0;
      mixQuarter(s);
    }
  }
  const out = new Uint32Array(8);
  const span = GR_TABLE / 8;
  for (let i = 0; i < 8; i += 1) {
    mixQuarter(s);
    let acc = s[0];
    for (let k = 0; k < span; k += 1) {
      const d = table[i * span + k];
      acc = (acc + d) >>> 0;
      acc = rotl32(acc, 5);
      acc = (acc ^ Math.imul(d, GR_H)) >>> 0;
    }
    out[i] = (acc ^ s[2]) >>> 0;
  }
  return out;
}

/** Bits de tête à zéro sur les 8 mots (big-endian, mot 0 d'abord). */
export function leadingZeroBits(words) {
  let bits = 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === 0) { bits += 32; continue; }
    return bits + Math.clz32(w);
  }
  return bits;
}

/**
 * Résout le PoW : "<nonce>:<s>" hashé jusqu'à wr >= difficulty ;
 * retourne String(s), ou null si le budget CPU est dépassé.
 * (Le vrai bundle itère s = 0,1,2… identiquement.)
 */
export function solvePow(nonce, difficulty, budgetMs = 25_000) {
  if (!nonce || !(difficulty > 0)) return '0';
  const prefix = `${nonce}:`;
  const preBytes = [];
  for (let i = 0; i < prefix.length; i += 1) preBytes.push(prefix.charCodeAt(i) & 255);
  const start = Date.now();
  let s = 0;
  const bytes = new Uint8Array(64);
  for (;;) {
    for (let b = 0; b < 256; b += 1) {
      const digits = String(s);
      const len = preBytes.length + digits.length;
      if (bytes.length < len) throw extractorError(ExtractorErrorCode.RETRYABLE, 'Buffer PoW trop petit');
      for (let i = 0; i < preBytes.length; i += 1) bytes[i] = preBytes[i];
      for (let i = 0; i < digits.length; i += 1) bytes[preBytes.length + i] = digits.charCodeAt(i) & 255;
      if (leadingZeroBits(grHash(bytes.subarray(0, len))) >= difficulty) return String(s);
      s += 1;
    }
    if (Date.now() - start > budgetMs) return null;
  }
}

/* ------------------------------------------------------------------------ */

function fromB64Url(value) {
  return Uint8Array.from(atob(String(value).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Déchiffre le payload playback : parties 1-based [version] + [31-version]. */
export async function decryptPlayback(playback, subtle) {
  const { key_parts: keyParts, version, iv, payload } = playback ?? {};
  if (!Array.isArray(keyParts) || version == null || !iv || !payload) {
    throw extractorError(ExtractorErrorCode.DEAD, 'Payload playback Byse incomplet');
  }
  const i1 = version - 1;
  const i2 = 31 - version - 1;
  if (i1 < 0 || i1 >= keyParts.length || i2 < 0 || i2 >= keyParts.length) {
    throw extractorError(ExtractorErrorCode.DEAD, 'Index de clé Byse hors bornes');
  }
  let keyBytes;
  try {
    keyBytes = concatBytes(fromB64Url(keyParts[i1]), fromB64Url(keyParts[i2]));
  } catch {
    throw extractorError(ExtractorErrorCode.DEAD, 'Clé Byse illisible');
  }
  if (keyBytes.length !== 32) {
    throw extractorError(ExtractorErrorCode.DEAD, 'Clé Byse de taille inattendue');
  }
  const crypto = subtle ?? globalThis.crypto?.subtle;
  if (!crypto) throw extractorError(ExtractorErrorCode.RETRYABLE, 'WebCrypto indisponible');
  const key = await crypto.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  try {
    const plain = await crypto.decrypt({ name: 'AES-GCM', iv: fromB64Url(iv) }, key, fromB64Url(payload));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw extractorError(ExtractorErrorCode.DEAD, 'Déchiffrage Byse impossible (protocole changé ?)');
  }
}

/** Paire ECDSA P-256 jetable + signature b64url du nonce (64 octets IEEE P1363). */
async function signNonce(nonce) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    encoder.encode(nonce),
  );
  return {
    signature: btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
    public_key: { crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x: jwk.x, y: jwk.y },
  };
}

function extractTitle(details) {
  return details?.title ? String(details.title).trim() || null : null;
}

function safeJson(text) {
  try { return JSON.parse(String(text ?? '')); } catch { return null; }
}

/** Garde anti-exfiltration : le CDN doit être un edge sprintcdn Byse (r66nv9ed). */
function assertCdnAllowed(directUrl) {
  try {
    const host = new URL(directUrl).hostname.toLowerCase();
    if (!/^[a-z0-9-]*sprintcdn\.r66nv9ed\.com$/.test(host)) {
      throw extractorError(ExtractorErrorCode.DEAD, 'URL CDN Byse inattendue');
    }
  } catch (error) {
    if (error instanceof ExtractorError) throw error;
    throw extractorError(ExtractorErrorCode.DEAD, 'URL CDN Byse invalide');
  }
}

/**
 * Résout un embed Byse en HLS direct vérifié. La chaîne complète
 * (challenge → attest → captcha PoW → verify → playback → déchiffrage)
 * s'exécute en 5-8 sWorkers pour difficulté 16.
 */
async function resolveVia(env, spaOrigin, code, via, parentUrl) {
  // 1. details depuis la SPA shell → embed_frame_url (segment aléatoire).
  const det = await fetchEmbedText(env, `${spaOrigin}/api/videos/${code}/embed/details`, { via });
  const detJson = safeJson(det.text);
  const playerUrl = detJson?.embed_frame_url;
  if (!playerUrl || !/^https?:\/\//.test(String(playerUrl))) {
    throw extractorError(ExtractorErrorCode.DEAD, 'Embed Byse sans player (fichier retiré ?)');
  }
  let playerOrigin = '';
  try { playerOrigin = new URL(playerUrl).origin; } catch { /* invalide */ }
  if (!playerOrigin) throw extractorError(ExtractorErrorCode.DEAD, 'Player Byse invalide');
  const playerHeaders = {
    origin: playerOrigin,
    referer: playerUrl,
    'x-embed-parent': parentUrl || `${spaOrigin}/e/${code}`,
  };

  // 2. challenge → attest (empreinte figée, clé ECDSA jetable).
  const challenge = await apiPost(env, `${playerOrigin}/api/videos/access/challenge`, {}, playerHeaders);
  if (challenge.status !== 200 || !challenge.json?.nonce || !challenge.json?.challenge_id) {
    throw extractorError(ExtractorErrorCode.RETRYABLE, `Challenge Byse ${challenge.status}`);
  }
  let signed;
  try {
    signed = await signNonce(challenge.json.nonce);
  } catch {
    throw extractorError(ExtractorErrorCode.RETRYABLE, 'Signature ECDSA impossible');
  }
  const attest = await apiPost(env, `${playerOrigin}/api/videos/access/attest`, {
    viewer_id: '',
    device_id: '',
    challenge_id: challenge.json.challenge_id,
    nonce: challenge.json.nonce,
    signature: signed.signature,
    public_key: signed.public_key,
    client: { user_agent: UA, ua_full_version: '131.0.0.0', ...CLIENT_FP, extra: { vendor: 'Google Inc.', appVersion: UA.slice(21) } },
    storage: {},
    attributes: { entropy: 'high' },
  }, playerHeaders);
  if (attest.status !== 200 || !attest.json?.token) {
    throw extractorError(ExtractorErrorCode.RETRYABLE, `Attest Byse ${attest.status}`);
  }
  const fingerprint = {
    token: attest.json.token,
    viewer_id: attest.json.viewer_id,
    device_id: attest.json.device_id,
    confidence: attest.json.confidence,
  };

  // 3. captcha PoW + verify.
  const captcha = await apiPost(env, `${playerOrigin}/api/videos/${code}/embed/captcha`, { fingerprint }, playerHeaders);
  if (captcha.status !== 200 || !captcha.json?.pow_nonce) {
    throw extractorError(ExtractorErrorCode.RETRYABLE, `Captcha Byse ${captcha.status}`);
  }
  const solution = solvePow(captcha.json.pow_nonce, captcha.json.pow_difficulty ?? 16);
  if (!solution) {
    throw extractorError(ExtractorErrorCode.RETRYABLE, 'PoW Byse hors budget (difficulté trop haute)');
  }
  const verify = await apiPost(env, `${playerOrigin}/api/videos/${code}/embed/captcha/verify`, {
    pow_token: captcha.json.pow_token,
    solution,
    fingerprint,
  }, playerHeaders);
  if (verify.json?.status !== 'ok' || !verify.json?.token) {
    throw extractorError(ExtractorErrorCode.RETRYABLE, 'Vérification PoW Byse refusée');
  }

  // 4. playback (token captcha en header).
  const playback = await apiPost(env, `${playerOrigin}/api/videos/${code}/embed/playback`, { fingerprint }, {
    ...playerHeaders,
    'x-captcha-token': verify.json.token,
  });
  if (playback.status !== 200 || !playback.json?.playback) {
    throw extractorError(ExtractorErrorCode.DEAD, `Playback Byse ${playback.status}`);
  }
  const media = await decryptPlayback(playback.json.playback);
  const sources = Array.isArray(media?.sources) ? media.sources : [];
  const best = sources.find((s) => /^https?:\/\//.test(String(s?.url)));
  if (!best) {
    throw extractorError(ExtractorErrorCode.DEAD, 'Sources Byse vides (fichier retiré ?)');
  }
  assertCdnAllowed(best.url);

  // 5. probe du CDN (Range). Le referer attendu est <player-origin>/.
  const probeAttempts = [];
  const ok = await probeDirectUrl(env, best.url, `${playerOrigin}/`, probeAttempts, { via: via === 'relay' ? 'relay' : 'auto' });
  if (!ok) throw withAttempts(extractorError(ExtractorErrorCode.RETRYABLE, 'CDN Byse injoignable (vérification)'), probeAttempts);
  return { urls: [best.url], referer: `${playerOrigin}/`, title: extractTitle(detJson) };
}

export async function resolve(env, ref) {
  const parsed = typeof ref === 'string' ? parse(ref) : parse(ref?.embedUrl ?? ref?.url ?? ref?.code ?? ref?.id ?? '');
  const attempts = [];
  const spa = parsed.wrapperUrl
    ? await followWrapper(env, parsed.wrapperUrl, attempts)
    : { spaOrigin: parsed.spaOrigin, code: parsed.code };
  const parentUrl = `${spa.spaOrigin}/e/${spa.code}`;
  // Stratégies : le relais D'ABORD quand il est configuré. Le CDN sprintcdn
  // lie les jetons de segments (.ts) à l'IP qui a fait le handshake — un jeton
  // émis depuis une IP Cloudflare est refusé 404 sur les .ts. Le proxy vidéo
  // sert ensuite les segments r66nv9ed.com par le relais (host mappé dans
  // RELAY_DOMAIN_MAP) : même IP = jeton accepté. Même design que vidzy.
  const strategies = resolveRelay(env, parentUrl).url !== parentUrl ? ['relay', 'auto'] : ['auto'];
  let lastError = null;
  for (const via of strategies) {
    try {
      return await resolveVia(env, spa.spaOrigin, spa.code, via, parentUrl);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ExtractorError)) break;
      // DEAD = verdict sur la source (fichier retiré) : le relais ne
      // changera rien, inutile de consommer la 2e stratégie.
      if (error.code === ExtractorErrorCode.DEAD || error.code === ExtractorErrorCode.INVALID) break;
    }
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Filmoon injoignable');
}

export const _internal = {
  MIRROR_DEFAULTS,
  CODE_PATTERN,
  WRAPPER_PATTERN,
  SPA_PATTERN,
  CLIENT_FP,
  followWrapper,
};
