// Enrichissement metadata VOD via TVmaze (gratuit, sans clé) — miroir du
// provider Nest (apps/api/src/modules/metadata/tvmaze.provider.ts).
//
// LIMITES (mêmes que côté Nest) :
// - Couverture séries TV uniquement : les films ne trouveront PAS de
//   correspondance → null silencieux (l'UI reste utilisable sans synopsis).
// - Rate limit 20 req/s : délai de 120 ms entre appels non cachés.
// - summary est du HTML brut → stripTags.
//
// Cache MetadataCache (clé "vod::titre normalisé", TTL 30 jours) : les 31k
// titres d'un catalogue ne coûtent que les requêtes de première visite.
// Résultats négatifs (pas de match) mis en cache aussi (payload {null})
// pour ne pas re-questionner TVmaze en boucle.

const TVMAZE_BASE = 'https://api.tvmaze.com';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const CACHE_TTL = "interval '30 days'";
const INTER_CALL_DELAY_MS = 120;

let lastCallAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripTags(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nettoie un titre de catalogue Xtream : préfixes langue « EN - », « AR »,
// « SRS | », doublons « (TV) », suffixes pays. Les titres Vivid/IPTV sont
// très bruités et le fuzzy TVmaze produit des faux positifs sinon.
export function cleanVodTitle(title) {
  let out = String(title ?? '');
  out = out.replace(/^(?:SRS|MVS|VOD)\s*\|\s*/i, '');
  out = out.replace(/^(?:EN|FR|AR|TR|ES|DE|IT|PT|NL|MULTI[- ]?LANG)\s*(?:-|\||::)\s*/i, '');
  out = out.replace(/\s*\((?:TV|VO|VF|VOSTFR|SUB)\)\s*$/i, '');
  out = out.replace(/\s*[-–]\s*(?:S\d{1,2}\s*E?\d{0,2}|SAISON\s*\d{1,2})\s*$/i, '');
  return out.trim().slice(0, 80);
}

async function fetchTvmaze(title) {
  await sleep(Math.max(0, lastCallAt + INTER_CALL_DELAY_MS - Date.now()));
  lastCallAt = Date.now();
  const res = await fetch(`${TVMAZE_BASE}/search/shows?q=${encodeURIComponent(title)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;
  const shows = await res.json();
  if (!Array.isArray(shows) || shows.length === 0) return null;
  const target = normalizeName(title);
  const exact = shows.find((entry) => normalizeName(entry.show?.name) === target);
  const pick = exact ?? (Number(shows[0]?.score) > 0.7 ? shows[0] : undefined);
  if (!pick?.show) return null;
  return {
    overview: pick.show.summary ? stripTags(pick.show.summary) : null,
    backdropUrl: pick.show.image?.original ?? pick.show.image?.medium ?? null,
    genres: Array.isArray(pick.show.genres) ? pick.show.genres.slice(0, 4) : [],
    year: pick.show.premiered ? Number(pick.show.premiered.slice(0, 4)) || null : null,
  };
}

// Secours TMDB (clé gratuite TMDB_API_KEY) : couvre les films et les titres
// non-anglophones que TVmaze ignore. Priorité aux résultats en fr/én.
async function fetchTmdb(title, kind, env) {
  const apiKey = env?.TMDB_API_KEY;
  if (!apiKey) return null;
  const type = kind === 'MOVIE' ? 'movie' : 'tv';
  const search = (query, language) =>
    fetch(`${TMDB_BASE}/search/${type}?api_key=${apiKey}&query=${encodeURIComponent(query)}&language=${language}&include_adult=false`, { signal: AbortSignal.timeout(10_000) })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  // 1re passe en français (catalogue francophone), 2e en anglais.
  let found = null;
  for (const language of ['fr-FR', 'en-US']) {
    const data = await search(title, language);
    const hit = Array.isArray(data?.results) && data.results.length > 0 ? data.results[0] : null;
    if (hit) { found = hit; break; }
  }
  if (!found) return null;
  return {
    description: found.overview ? stripTags(found.overview) : null,
    backdropUrl: found.backdrop_path ? `https://image.tmdb.org/t/p/w1280${found.backdrop_path}` : null,
    genres: [],
    year: (found.release_date ?? found.first_air_date ?? '').slice(0, 4) ? Number((found.release_date ?? found.first_air_date).slice(0, 4)) || null : null,
  };
}

// Synopsis + backdrop d'un titre VOD (cache-first, miss persisté). Chaîne de
// secours : TVmaze (séries anglophones) puis TMDB (films + multi-langue).
// Retourne null si aucune source ne connaît le titre — jamais bloquant.
export async function vodMetadata(env, rawTitle, kind = 'SERIES') {
  const clean = cleanVodTitle(rawTitle);
  if (!clean) return null;
  const cacheKey = `vod::${normalizeName(clean)}`;
  try {
    const cached = await env.db.query(env, `SELECT payload FROM "MetadataCache" WHERE "cacheKey" = $1 AND "expiresAt" > now() LIMIT 1`, [cacheKey]);
    if (cached.rows.length > 0) return cached.rows[0].payload;
  } catch { /* cache indisponible : on interroge les fournisseurs */ }

  let payload;
  try {
    payload = (await fetchTvmaze(clean)) ?? (await fetchTmdb(clean, kind, env));
  } catch {
    return null;
  }
  // Clé « description » : c'est le nom du champ dans le contrat VodItem.
  const result = payload
    ? { description: payload.overview ?? null, backdropUrl: payload.backdropUrl ?? null, genres: payload.genres ?? [], year: payload.year ?? null }
    : null;
  try {
    await env.db.query(
      env,
      `INSERT INTO "MetadataCache" (id, "cacheKey", title, payload, "expiresAt")
       VALUES ($1, $2, $3, $4, now() + ${CACHE_TTL})
       ON CONFLICT ("cacheKey") DO UPDATE SET payload = EXCLUDED.payload, "expiresAt" = EXCLUDED."expiresAt"`,
      [crypto.randomUUID(), cacheKey, clean, JSON.stringify(result)],
    );
  } catch { /* écriture cache non bloquante */ }
  return result;
}
