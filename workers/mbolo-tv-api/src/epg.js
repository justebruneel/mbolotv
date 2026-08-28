import { resolveLogoUrl } from "./channels.js";
import { loadHiddenIds } from "./categories.js";

const PLAYABLE_CHANNEL = `EXISTS (
  SELECT 1 FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId"
  WHERE v."channelId" = c.id AND v."isActive" AND (v."healthStatus" IS NULL OR v."healthStatus" = 'OK') AND s.status <> 'DISABLED'
)`;

async function hiddenFilter(env, startIndex) {
  const hiddenIds = await loadHiddenIds(env);
  if (hiddenIds.size === 0) return { sql: "", params: [] };
  return {
    sql: ` AND (c."categoryId" IS NULL OR c."categoryId" <> ALL($${startIndex}::text[]))`,
    params: [[...hiddenIds]],
  };
}

export async function searchProgrammes(env, query) {
  const params = [`%${query.q}%`];
  const hidden = await hiddenFilter(env, params.length + 1);
  params.push(...hidden.params);
  let categorySql = "";
  if (query.category) {
    params.push(query.category);
    categorySql = ` AND c."categoryId" IN (SELECT id FROM "Category" WHERE slug = $${params.length})`;
  }
  params.push(query.limit ?? 30);
  const result = await env.db.query(
    env,
    `SELECT p.id, p."channelId", p.title, p.description, p."imageUrl", p."startsAt", p."endsAt",
            c.id AS c_id, c.name AS c_name, c."canonicalName" AS c_canonical, c.country AS c_country, c."categoryId" AS c_category, c."logoKey" AS c_logo
     FROM "EpgProgramme" p JOIN "Channel" c ON c.id = p."channelId"
     WHERE p.title ILIKE $1 AND c."isVisible" = true AND ${PLAYABLE_CHANNEL}${hidden.sql}${categorySql}
     ORDER BY p."startsAt" DESC LIMIT $${params.length}`,
    params,
  );
  const items = result.rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    channel: {
      id: row.c_id,
      name: row.c_name,
      canonicalName: row.c_canonical,
      country: row.c_country,
      categoryId: row.c_category,
      logoUrl: resolveLogoUrl(env, row.c_logo),
    },
  }));
  return { items, total: items.length };
}

// Décalage horaire d'un fuseau à un instant donné (gère la DST).
function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    map.hour === "24" ? 0 : Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - date.getTime();
}

// Instant UTC d'une heure « murale » dans un fuseau (2 passes suffisent à converger).
function zonedInstant(timeZone, year, month, day, hours, minutes) {
  let guess = Date.UTC(year, month - 1, day, hours, minutes);
  for (let i = 0; i < 2; i += 1) {
    guess = Date.UTC(year, month - 1, day, hours, minutes) - tzOffsetMs(new Date(guess), timeZone);
  }
  return new Date(guess);
}

function civilDate(timeZone, date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-")
    .map(Number);
}

const PRIME_WINDOW_MS = 150 * 60_000; // 20:00 → 22:30

function primeWindow(env, now) {
  const timeZone = env.EPG_PRIME_TZ || "Europe/Paris";
  // Base : ce soir ; s'il est déjà plus de 22h30, on vise demain soir.
  const target = now.getTime() > zonedInstant(timeZone, ...civilDate(timeZone, now), 22, 30).getTime()
    ? new Date(now.getTime() + 24 * 3_600_000)
    : now;
  const start = zonedInstant(timeZone, ...civilDate(timeZone, target), 20, 0);
  return { start, end: new Date(start.getTime() + PRIME_WINDOW_MS) };
}

function programmeType(categories) {
  const joined = (categories ?? []).join(" ").toLowerCase();
  if (/film|movie|cinéma|cinema/.test(joined)) return "movie";
  if (/série|serie|series|feuilleton/.test(joined)) return "series";
  if (/sport|football|rugby|tennis|basket|match/.test(joined)) return "sports";
  if (/documentaire|documentary/.test(joined)) return "documentary";
  if (/journal|news|info/.test(joined)) return "news";
  if (/jeunesse|kids|dessin|enfant|animation/.test(joined)) return "kids";
  if (/emission|émission|show|divertissement/.test(joined)) return "show";
  return null;
}

// « À la une » : meilleurs programmes de la fenêtre prime time (20:00–22:30
// dans EPG_PRIME_TZ, défaut Europe/Paris). Sans enrichissement TMDB côté
// worker, le score privilégie les programmes illustrés ; les doublons de
// titre (même programme sur plusieurs chaînes) ne ressortent qu'une fois.
export async function epgFeatured(env, limit = 5) {
  const now = new Date();
  const { start, end } = primeWindow(env, now);
  const params = [start, end];
  const hidden = await hiddenFilter(env, params.length + 1);
  params.push(...hidden.params);
  const result = await env.db.query(
    env,
    `SELECT p.id, p."channelId", p.title, p.description, p."imageUrl", p."startsAt", p."endsAt", p.metadata,
            c.id AS c_id, c.name AS c_name, c."logoKey" AS c_logo
     FROM "EpgProgramme" p JOIN "Channel" c ON c.id = p."channelId"
     WHERE p."startsAt" >= $1 AND p."startsAt" <= $2 AND c."isVisible" = true AND ${PLAYABLE_CHANNEL}${hidden.sql}
     ORDER BY p."startsAt" ASC LIMIT 500`,
    params,
  );
  const scored = result.rows.map((row) => {
    // jsonb : renvoyé déjà parsé par pg ; text : à parser (selon le driver)
    let metadata = row.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }
    const categories = metadata?.categories ?? [];
    const type = programmeType(categories);
    return {
      row,
      type,
      score: (row.imageUrl ? 0.5 : 0) + (type === "movie" ? 0.3 : 0),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const seenTitles = new Set();
  const items = [];
  for (const { row, type } of scored) {
    if (items.length >= limit) break;
    // Placeholders de grille sans contenu réel
    if (/^no ?data$/i.test(row.title.trim())) continue;
    const key = row.title
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    items.push({
      channelId: row.channelId,
      channel: {
        id: row.c_id,
        name: row.c_name,
        logoUrl: resolveLogoUrl(env, row.c_logo),
      },
      programme: {
        channelId: row.channelId,
        id: row.id,
        title: row.title,
        description: row.description,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        imageUrl: row.imageUrl,
        type,
      },
    });
  }
  return items;
}

export async function epgRange(env, query) {
  const to = query.to
    ? new Date(query.to)
    : new Date(Date.now() + 5 * 3_600_000);
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 6 * 3_600_000);
  const params = [to, from];
  const hidden = await hiddenFilter(env, params.length + 1);
  params.push(...hidden.params);
  let categorySql = "";
  if (query.category) {
    params.push(query.category);
    categorySql = ` AND c."categoryId" IN (SELECT id FROM "Category" WHERE slug = $${params.length})`;
  }
  const result = await env.db.query(
    env,
    `SELECT p.id, p."channelId", p.title, p.description, p."imageUrl", p."startsAt", p."endsAt",
            c.id AS c_id, c.name AS c_name, c."canonicalName" AS c_canonical, c.country AS c_country, c."categoryId" AS c_category, c."logoKey" AS c_logo
     FROM "EpgProgramme" p JOIN "Channel" c ON c.id = p."channelId"
     WHERE p."startsAt" < $1 AND p."endsAt" > $2 AND c."isVisible" = true AND ${PLAYABLE_CHANNEL}${hidden.sql}${categorySql}
     ORDER BY c.id ASC, p."startsAt" ASC LIMIT 500`,
    params,
  );
  const programmesByChannel = new Map();
  for (const row of result.rows) {
    const list = programmesByChannel.get(row.channelId) ?? [];
    list.push({
      id: row.id,
      channelId: row.channelId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      title: row.title,
      description: row.description,
      imageUrl: row.imageUrl,
    });
    programmesByChannel.set(row.channelId, list);
  }
  const items = [];
  for (const row of result.rows) {
    if (items.some((item) => item.channel.id === row.channelId)) continue;
    const list = programmesByChannel.get(row.channelId);
    if (!list) continue;
    items.push({
      channel: {
        id: row.c_id,
        name: row.c_name,
        canonicalName: row.c_canonical,
        country: row.c_country,
        categoryId: row.c_category,
        logoUrl: resolveLogoUrl(env, row.c_logo),
      },
      programmes: list,
    });
  }
  return { items, from: from.toISOString(), to: to.toISOString() };
}
