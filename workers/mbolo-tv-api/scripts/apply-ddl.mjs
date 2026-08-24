import pg from 'pg';

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('Usage: node scripts/apply-ddl.mjs "<postgres-url>"');
  process.exit(1);
}

const client = new pg.Client(connectionString);
await client.connect();
await client.query(`
  CREATE TABLE IF NOT EXISTS "ActivityHeartbeat" (
    "deviceHash" TEXT PRIMARY KEY,
    "channelId" TEXT,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await client.query(`CREATE INDEX IF NOT EXISTS "ActivityHeartbeat_lastSeenAt_idx" ON "ActivityHeartbeat" ("lastSeenAt")`);
const check = await client.query(`SELECT COUNT(*)::int AS count FROM "ActivityHeartbeat"`);
console.log('DDL appliqué. Lignes ActivityHeartbeat:', check.rows[0].count);
await client.end();
