import pg from 'pg';
import { createHash } from 'node:crypto';

const connectionString = process.argv[2];
const code = 'MBLO-TESTPROXY00';
const deviceId = 'test-device-123';
const client = new pg.Client(connectionString);
await client.connect();
const codeHash = createHash('sha256').update(code).digest('hex');
const deviceHash = createHash('sha256').update(deviceId).digest('hex');
const existing = await client.query(`SELECT id FROM "AccessCode" WHERE "codeHash" = $1`, [codeHash]);
let codeId;
if (existing.rows.length > 0) {
  codeId = existing.rows[0].id;
} else {
  const inserted = await client.query(
    `INSERT INTO "AccessCode" ("id","codeHash","codeLast4",kind,"durationHours",active,"createdById") VALUES ($1,$2,$3,'STANDARD',24,true,(SELECT id FROM "User" WHERE role='OWNER' LIMIT 1)) RETURNING id`,
    [crypto.randomUUID(), codeHash, code.slice(-4)],
  );
  codeId = inserted.rows[0].id;
}
await client.query(`DELETE FROM "DeviceGrant" WHERE "accessCodeId" = $1`, [codeId]);
await client.query(
  `INSERT INTO "DeviceGrant" ("id","accessCodeId","deviceHash","expiresAt") VALUES ($1,$2,$3, now() + interval '2 hours')`,
  [crypto.randomUUID(), codeId, deviceHash],
);
console.log('Grant de test actif pour', deviceId);
await client.end();
