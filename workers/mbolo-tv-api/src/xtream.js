// Réplique de xtream.connector.ts : catégories + live_streams, URLs
// {base}/live/{user}/{pass}/{stream_id}.m3u8, rejet d'auth {"user_info":{"auth":0}}.
const MAX_API_BYTES = 50 * 1024 * 1024;
// Les panels IPTV débittent souvent à ~0,3 Mo/s : un catalogue de 24k chaînes
// (~11 Mo de JSON) prend ~40 s. 180 s laisse une marge confortable.
const CONNECTOR_TIMEOUT_MS = 180_000;

function isFolderMarker(title) {
  return /^#{2,}.+#{2,}$/.test(title.trim());
}

function normalizeIcon(icon) {
  if (!icon) return undefined;
  if (icon.startsWith('//')) return `https:${icon}`;
  return icon;
}

function isAuthRejected(payload) {
  if (typeof payload !== 'object' || payload === null) return false;
  const info = payload.user_info;
  return typeof info === 'object' && info !== null && Number(info.auth) === 0;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0' } });
  const text = await response.text();
  if (text.length > MAX_API_BYTES) throw new Error('Réponse Xtream trop volumineuse');
  return JSON.parse(text);
}

export async function fetchXtreamEntries(connection) {
  const base = connection.url.replace(/\/+$/, '');
  const user = encodeURIComponent(connection.username);
  const pass = encodeURIComponent(connection.password);

  let categoryNames = new Map();
  try {
    const categoryPayload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`);
    if (isAuthRejected(categoryPayload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');
    for (const category of Array.isArray(categoryPayload) ? categoryPayload : []) {
      if (category.category_id != null && category.category_name) categoryNames.set(String(category.category_id), String(category.category_name).trim());
    }
  } catch (error) {
    if (String(error.message).includes('identifiants')) throw error;
  }

  let payload;
  try {
    payload = await fetchJson(`${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`);
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'Réponse Xtream invalide (JSON attendu)' : `Échec de récupération du flux Xtream : ${error.message}`);
  }
  if (isAuthRejected(payload)) throw new Error('Identifiants Xtream invalides (authentification refusée)');

  const streams = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.live_streams)
      ? payload.live_streams
      : [];

  const entries = [];
  for (const stream of streams) {
    if (stream.stream_id == null || (stream.stream_type !== 'live' && stream.stream_type !== undefined)) continue;
    const title = String(stream.name ?? `Chaîne ${stream.num ?? stream.stream_id}`).trim();
    if (isFolderMarker(title)) continue;
    const groupTitle =
      (stream.category_id != null && categoryNames.get(String(stream.category_id)))
      || (stream.category_name ? String(stream.category_name).trim() : undefined);
    entries.push({
      title,
      tvgId: stream.epg_channel_id ? String(stream.epg_channel_id) : undefined,
      tvgLogo: normalizeIcon(stream.stream_icon),
      groupTitle,
      url: `${base}/live/${encodeURIComponent(connection.username)}/${encodeURIComponent(connection.password)}/${stream.stream_id}.m3u8`,
    });
  }
  return { entries };
}
