import pg from 'pg';

const [, , connectionString, encryptionKey] = process.argv;
const client = new pg.Client(connectionString);
await client.connect();

const enc = new TextEncoder();
const digest = await crypto.subtle.digest('SHA-256', enc.encode(encryptionKey));
const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8')));
const payload = Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);

const cat = await client.query(
  `INSERT INTO "Category" (id, slug, name) VALUES ($1, 'test-proxy-ephemere', 'TEST PROXY')
   ON CONFLICT (slug) DO UPDATE SET name = 'TEST PROXY' RETURNING id`,
  [crypto.randomUUID()],
);
const channel = await client.query(
  `INSERT INTO "Channel" (id, name, "canonicalName", "normalizedKey", "isVisible", "sortOrder", "categoryId")
   VALUES ($1, 'TEST Worker Proxy', 'TEST Worker Proxy', $2, true, -999, $3)
   ON CONFLICT ("normalizedKey") DO UPDATE SET "isVisible" = true RETURNING id`,
  [crypto.randomUUID(), 'test-worker-proxy-' + Date.now(), cat.rows[0].id],
);
await client.query(
  `INSERT INTO "StreamVariant" (id, "channelId", "sourceId", "encryptedLocator")
   VALUES ($1, $2, (SELECT id FROM "Source" LIMIT 1), $3)`,
  [crypto.randomUUID(), channel.rows[0].id, payload],
);
console.log('CHANNEL_TEST_ID=' + channel.rows[0].id);
await client.end();
