import { importKey, decryptLocator } from './crypto.js';
import { parseXmltvStream } from './xmltv.js';
import { resolveRelay } from './relay.js';

const MAX_REDIRECTS = 5;

async function fetchThroughRelay(env, url, timeoutMs) {
  let currentUrl = url;
  let hops = 0;
  for (;;) {
    const relayed = resolveRelay(env, currentUrl);
    const response = await fetch(relayed.url, {
      headers: { "user-agent": "MboloTV/0.1 (EPG import)", ...relayed.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    if (++hops > 5) throw new Error("Trop de redirections");
    currentUrl = new URL(location, response.url || currentUrl).toString();
    void response.body?.cancel().catch(() => undefined);
  }
}

function stripAccents(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Clé de correspondance tolérante entre tvgId / noms de chaînes / IDs XMLTV :
// accents, casse, ponctuation, préfixes pays et suffixes qualité ignorés.
export function channelKey(value) {
  let out = stripAccents(String(value ?? "")).toLowerCase();
  out = out.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");
  out = out.replace(/\|\|[^|]*\|\|/g, " ");
  out = out.replace(/\[[^\]]*\]/g, " ");
  out = out.replace(/\b(fhd|uhd|4k|k|hd|hevc|h265|h264|sd)\b/g, " ");
  out = out.replace(/^[a-z]{2,3}\s*[:|·\-]\s*/, "");
  out = out.replace(/[^a-z0-9]+/g, "");
  return out;
}

function normalizeName(value) {
  return stripAccents(String(value ?? ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveEpgUrl(env, cryptoKey, source) {
  if (source.epgUrl) return source.epgUrl;
  if (source.kind !== "XTREAM") return null;
  try {
    const connection = JSON.parse(await decryptLocator(cryptoKey, source.connectionEncrypted));
    if (!connection.url || !connection.username || !connection.password) return null;
    const base = connection.url.replace(/\/+$/, "");
    return `${base}/xmltv.php?username=${encodeURIComponent(connection.username)}&password=${encodeURIComponent(connection.password)}`;
  } catch {
    return null;
  }
}

// Import EPG : mapping multi-niveaux (tvgId brut → clé normalisée → nom XML
// normalisé), delete-then-insert par canal, fetch via le relais si mappé.
export async function runEpgImportForSource(env, sourceId) {
  const cryptoKey = await importKey(env.ENCRYPTION_KEY);
  const maxBytes = Number(env.EPG_MAX_BYTES ?? 40 * 1024 * 1024);
  const sourceRows = await env.db.query(env, `SELECT id, kind, "epgUrl", "connectionEncrypted" FROM "Source" WHERE id = $1`, [sourceId]);
  const source = sourceRows.rows[0];
  if (!source) return { skipped: true };

  const url = await resolveEpgUrl(env, cryptoKey, source);
  if (!url) return { skipped: true };

  const channels = await env.db.query(
    env,
    `SELECT c.id, c.name, c."tvgId" FROM "Channel" c WHERE EXISTS (
       SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = c.id AND v."isActive"
     )`,
  );
  const tvgMap = new Map();
  const keyMap = new Map();
  const nameMap = new Map();
  for (const channel of channels.rows) {
    if (channel.tvgId) {
      tvgMap.set(String(channel.tvgId).toLowerCase(), channel.id);
      keyMap.set(channelKey(channel.tvgId), channel.id);
    }
    nameMap.set(channelKey(channel.name), channel.id);
  }

  let response;
  try {
    response = await fetchThroughRelay(env, url, Number(env.EPG_FETCH_TIMEOUT_MS ?? 900_000));
  } catch (error) {
    console.error("[epg] fetch échec:", error instanceof Error ? error.message : error);
    return { ok: false };
  }
  if (!response.ok || !response.body) {
    console.error("[epg] HTTP", response.status, "pour", source.name);
    return { ok: false };
  }

  const programmesByChannel = new Map();
  let unmatchedSample = [];

  try {
    await parseXmltvStream(
      response.body,
      {
        onChannel: () => undefined,
        onProgramme: (programme) => {
          const raw = programme.channelId;
          const channelId =
            tvgMap.get(raw.toLowerCase()) ??
            keyMap.get(channelKey(raw)) ??
            nameMap.get(channelKey(raw)) ??
            null;
          if (!channelId) {
            if (unmatchedSample.length < 5) unmatchedSample.push(raw.slice(0, 40));
            return;
          }
          const list = programmesByChannel.get(channelId) ?? [];
          list.push({
            id: crypto.randomUUID(),
            title: programme.title,
            description: programme.description,
            imageUrl: programme.imageUrl ?? null,
            startsAt: programme.startsAt,
            endsAt: programme.endsAt,
            metadata: programme.categories.length > 0 ? JSON.stringify({ categories: programme.categories }) : null,
          });
          programmesByChannel.set(channelId, list);
        },
      },
      maxBytes,
    );
  } catch (error) {
    console.error("[epg] parse échec:", error instanceof Error ? error.message : error);
    return { ok: false };
  }

  if (programmesByChannel.size === 0) {
    console.error("[epg] 0 programme mappé pour", source.name, "| exemples IDs XML non résolus:", unmatchedSample.join(" | "));
    return { ok: false, mapped: 0 };
  }

  for (const [channelId, programmes] of programmesByChannel) {
    await env.db.query(env, `DELETE FROM "EpgProgramme" WHERE "channelId" = $1`, [channelId]);
    const values = [];
    const params = [];
    programmes.forEach((programme, position) => {
      const base = position * 8;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
      params.push(programme.id, channelId, programme.startsAt, programme.endsAt, programme.title, programme.description, programme.imageUrl, programme.metadata);
    });
    for (let offset = 0; offset < values.length; offset += 500) {
      await env.db.query(
        env,
        `INSERT INTO "EpgProgramme" (id, "channelId", "startsAt", "endsAt", title, description, "imageUrl", metadata) VALUES ${values
          .slice(offset, offset + 500)
          .join(", ")}`,
        params.slice(offset * 8, (offset + 500) * 8),
      );
    }
  }
  await env.db.query(env, `UPDATE "Source" SET "lastSyncedAt" = now() WHERE id = $1`, [sourceId]);
  console.log("[epg]", source.name, "→", programmesByChannel.size, "canaux EPG mappés");
  return { ok: true, channels: programmesByChannel.size };
}
