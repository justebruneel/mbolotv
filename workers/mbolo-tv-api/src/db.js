import pg from "pg";

// Transition Sept-Oct 2026 (quota Neon épuisé, base PostgreSQL locale sur le
// relay résidentiel) : quand DB_GATEWAY_URL est défini, les requêtes partent
// en HTTPS vers la passerelle scripts/db-gateway.mjs via le tunnel relay-dns —
// le protocole wire Postgres ne pouvant pas traverser l'edge Cloudflare.
// Retirer la variable au retour Neon : le binding HYPERDRIVE reprend la main,
// ce fichier et tous les appelants sont inchangés (le faux client n'expose
// que query(), le seul membre jamais utilisé).
// Symétrique de pgSafeReplacer (scripts/db-gateway.mjs) : la passerelle HTTP
// transporte les valeurs pg en JSON, les Date/Uint8Array/bigint marquées
// __pg redeviennent de vrais objets — sinon grant.expiresAt.toISOString() et
// compagnie cassent partout où le code suppose le pilote pg natif.
function revivePg(_key, value) {
  if (value && typeof value === "object" && typeof value.__pg === "string") {
    if (value.__pg === "date") return new Date(value.v);
    if (value.__pg === "bytes") return Uint8Array.from(atob(value.v), (c) => c.charCodeAt(0));
    if (value.__pg === "bigint") return value.v;
  }
  return value;
}

// Sens requête : les params Uint8Array (colonnes Bytes — identifiants chiffrés
// des sources, locators de flux) survivent mal à JSON.stringify tout seul
// ({"0":123,...} → bytea vide stocké, silencieux). Même codec que la réponse,
// dans l'autre sens : marqué ici, décodé par decodeParam côté passerelle.
function bytesToB64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function paramCodec(_key, value) {
  const raw = this[_key];
  if (raw instanceof Uint8Array) return { __pg: "bytes", v: bytesToB64(raw) };
  if (typeof raw === "bigint" || typeof value === "bigint") return { __pg: "bigint", v: String(raw ?? value) };
  return value;
}

async function gatewayQuery(env, sql, params = []) {
  if (env.__gwCount) env.__gwCount.n += 1;
  const response = await fetch(env.DB_GATEWAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mbolo-db-token": env.DB_GATEWAY_TOKEN },
    body: JSON.stringify({ sql, params }, paramCodec),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`db gateway ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
  const data = JSON.parse(await response.text(), revivePg);
  const result = data.results?.[0];
  if (!result) throw new Error("db gateway: réponse inattendue");
  return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
}

export async function withClient(env, handler) {
  if (env.DB_GATEWAY_URL) return handler({ query: (sql, params) => gatewayQuery(env, sql, params) });
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
