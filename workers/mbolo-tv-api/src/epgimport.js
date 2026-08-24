import { importKey, decryptLocator } from './crypto.js';
import { parseXmltvStream } from './xmltv.js';

function normalizeName(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function resolveEpgUrl(env, cryptoKey, source) {
  if (source.epgUrl) return source.epgUrl;
  if (source.kind !== 'XTREAM') return null;
  try {
    const connection = JSON.parse(await decryptLocator(cryptoKey, source.connectionEncrypted));
    if (!connection.url || !connection.username || !connection.password) return null;
    const base = connection.url.replace(/\/+$/, '');
    return `${base}/xmltv.php?username=${encodeURIComponent(connection.username)}&password=${encodeURIComponent(connection.password)}`;
  } catch {
    return null;
  }
}

// Réplique de epg-import.service.ts : mapping tvg-id (insensible à la casse)
// puis fallback display-name normalisé ; delete-then-insert par canal.
export async function runEpgImportForSource(env, sourceId) {
  const key = await importKey(env.ENCRYPTION_KEY);
  const maxBytes = Number(env.EPG_MAX_BYTES ?? 40 * 1024 * 1024);
  const sourceRows = await env.db.query(env, `SELECT id, kind, "epgUrl", "connectionEncrypted" FROM "Source" WHERE id = $1`, [sourceId]);
  const source = sourceRows.rows[0];
  if (!source) return { skipped: true };

  const url = await resolveEpgUrl(env, key, source);
  if (!url) return { skipped: true };

  const channels = await env.db.query(env, `SELECT id, name, "tvgId" FROM "Channel" WHERE EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = "Channel".id AND v."isActive")`);
  const tvgMap = new Map();
  const nameMap = new Map();
  for (const channel of channels.rows) {
    if (channel.tvgId) tvgMap.set(channel.tvgId.toLowerCase(), channel.id);
    nameMap.set(normalizeName(channel.name), channel.id);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': 'MboloTV/0.1 (EPG import)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(Number(env.EPG_FETCH_TIMEOUT_MS ?? 900_000)),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok || !response.body) return { ok: false };

  const programmesByChannel = new Map();
  try {
    await parseXmltvStream(
      response.body,
      {
        onChannel: (channel) => undefined,
        onProgramme: (programme) => {
          const channelId = tvgMap.get(programme.channelId.toLowerCase()) ?? nameMap.get(normalizeName(programme.channelId)) ?? null;
          if (!channelId) return;
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
  } catch {
    return { ok: false };
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
    for (let offset = 0; offset < values.length; offset += 5000) {
      const sliceValues = values.slice(offset, offset + 5000);
      const sliceParams = params.slice(offset * 8, (offset + 5000) * 8);
      await env.db.query(
        env,
        `INSERT INTO "EpgProgramme" (id, "channelId", "startsAt", "endsAt", title, description, "imageUrl", metadata) VALUES ${sliceValues.join(', ')}`,
        sliceParams,
      );
    }
  }
  await env.db.query(env, `UPDATE "Source" SET "lastSyncedAt" = now() WHERE id = $1`, [sourceId]);
  return { ok: true, channels: programmesByChannel.size };
}
