import pg from 'pg';
import crypto from 'node:crypto';

// Bootstrap du compte OWNER avec le format PBKDF2 du Worker
// ($pbkdf2-sha256$v=1$<iter>$<salt>$<hash>). Équivalent du onModuleInit Nest.
const [connectionString, email, password] = process.argv.slice(2);
if (!connectionString || !email || !password) {
  console.error('Usage: node scripts/bootstrap-owner.mjs "<postgres-url>" "<email>" "<password>"');
  process.exit(1);
}

const ITERATIONS = 100_000;
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const b64 = (value) => value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passwordHash = `$pbkdf2-sha256$v=1$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;

const client = new pg.Client(connectionString);
await client.connect();
const existing = await client.query(`SELECT id FROM "User" WHERE email = $1 LIMIT 1`, [email.trim().toLowerCase()]);
let userId;
if (existing.rows.length > 0) {
  userId = existing.rows[0].id;
  await client.query(`UPDATE "User" SET "passwordHash" = $2, role = 'OWNER' WHERE id = $1`, [userId, passwordHash]);
} else {
  const inserted = await client.query(
    `INSERT INTO "User" (id, email, role, "passwordHash") VALUES ($1, $2, 'OWNER', $3) RETURNING id`,
    [crypto.randomUUID(), email.trim().toLowerCase(), passwordHash],
  );
  userId = inserted.rows[0].id;
}
await client.query(`UPDATE "OwnerSession" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId]);
console.log('Owner provisionné (PBKDF2):', email);
await client.end();
