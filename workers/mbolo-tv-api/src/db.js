import pg from "pg";

export async function withClient(env, handler) {
  const client = new pg.Client(env.HYPERDRIVE.connectionString);
  try {
    await client.connect();
    return await handler(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function query(env, sql, params = []) {
  return withClient(env, (client) => client.query(sql, params));
}
