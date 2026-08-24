import pg from 'pg';

const [, , connectionString, channelId] = process.argv;
const client = new pg.Client(connectionString);
await client.connect();
await client.query(`DELETE FROM "StreamVariant" WHERE "channelId" = $1`, [channelId]);
await client.query(`DELETE FROM "Channel" WHERE id = $1`, [channelId]);
await client.query(`DELETE FROM "Category" WHERE slug = 'test-proxy-ephemere'`);
const left = await client.query(`SELECT COUNT(*)::int AS count FROM "Channel" WHERE name LIKE 'TEST%'`);
console.log('Canal de test supprimé. Canaux TEST restants:', left.rows[0].count);
await client.end();
