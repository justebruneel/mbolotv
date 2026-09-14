// Passerelle SQL en HTTP — transition Sept-Oct 2026.
//
// Contexte : le quota de transfert Neon est épuisé (~réinit. 1er oct.) et le
// protocole wire PostgreSQL ne peut PAS transiter par le Cloudflare edge d'un
// tunnel cloudflared (le port 443 n'accepte que TLS/HTTP ; Hyperdrive parle en
// SSLRequest libpq → « Unknown message code: H »). Cette passerelle remplace
// donc Hyperdrive côté Worker : le Worker poste {sql, params} en HTTPS via le
// tunnel relay-dns existant, la passerelle exécute en local (localhost:5432)
// et renvoie {rows, rowCount} — mêmes clés que pg.Client.query, les appelants
// ne voient rien.
//
// Sécurité :
//  - écoute sur 127.0.0.1 uniquement (inaccessible sauf via le tunnel) ;
//  - jeton d'origine partagés en en-tête x-mbolo-db-token, comparaison en
//    temps constant ;
//  - rôle SQL « mbolo » (droits limités à la base mbolo, jamais superuser) ;
//  - statement_timeout + taille de corps plafonnées.
//
// Lancement : systemd --user mbolo-db-gateway.service (EnvironmentFile=~db-gateway.env)
// Retour Neon prévu : supprimer DB_GATEWAY_URL des vars du Worker — db.js
// retombe alors sur l'binding HYPERDRIVE comme avant, sans redéploiement de ce
// fichier.

import pg from "pg";
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.DB_GATEWAY_PORT || 8086);
const TOKEN = process.env.DB_GATEWAY_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 25000);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STATEMENTS = 200;

if (!TOKEN || !DATABASE_URL) {
  console.error("db-gateway: DB_GATEWAY_TOKEN et DATABASE_URL requis (EnvironmentFile db-gateway.env)");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 8000,
  statement_timeout: STATEMENT_TIMEOUT_MS,
});
pool.on("error", (error) => console.error("[db-gateway] pool:", error.message));

// Colonnes `timestamp without time zone` (défaut Prisma DateTime) : la base
// est en UTC (session TimeZone=UTC), donc la valeur littérale stockée est en
// heure UTC — mais node-pg les interprète à l'heure LOCALE du processus, or
// cette machine tourne sur une horaire America/New_York (+4 h d'erreur, qui
// gelait les sessions et décalait les dates affichées). Ces parseurs forcent
// l'UTC, comme le ferait Hyperdrive côté Neon (calculation en UTC).
pg.types.setTypeParser(1114, (value) => new Date(`${String(value).replace(" ", "T")}Z`));
pg.types.setTypeParser(1082, (value) => new Date(`${value}T00:00:00Z`));

function tokenOk(presented) {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("corps trop volumineux")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const started = Date.now();

// node-postgres renvoie des objets JS (Date, Buffer, bigint) que JSON ne sait
// pas porter. Ces valeurs sont marquées ici et réhydratées côté Worker dans
// src/db.js (revivePg) — pour que les appelants reçoivent exactement la même
// chose qu'avec le pilote pg direct (Hyperdrive).
function pgSafeReplacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date) return { __pg: "date", v: raw.toISOString() };
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return { __pg: "bytes", v: Buffer.from(raw).toString("base64") };
  if (typeof raw === "bigint" || typeof value === "bigint") return { __pg: "bigint", v: String(raw ?? value) };
  return value;
}

// Sens requête (symétrique de paramCodec dans src/db.js) : les params marqués
// reviennent à leurs types pg natifs avant client.query — sans ce décodage,
// un Uint8Array sérialisé {"0":...} passerait pour un bytea vide.
function decodeParam(value) {
  if (value && typeof value === "object" && typeof value.__pg === "string") {
    if (value.__pg === "bytes") return Buffer.from(value.v, "base64");
    if (value.__pg === "bigint") return value.v;
  }
  return value;
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-mbolo-gateway": "1" });
    res.end(JSON.stringify(obj, pgSafeReplacer));
  };

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    send(200, { ok: true, uptimeSec: Math.round((Date.now() - started) / 1000) });
    return;
  }

  if (req.method === "POST" && req.url === "/query") {
    if (!tokenOk(req.headers["x-mbolo-db-token"])) { send(401, { error: "non autorisé" }); return; }
    let statements;
    try {
      const body = JSON.parse(await readBody(req));
      statements = Array.isArray(body.statements)
        ? body.statements
        : typeof body.sql === "string" ? [{ sql: body.sql, params: body.params ?? [] }] : null;
    } catch { send(400, { error: "corps JSON invalide" }); return; }
    if (!statements || statements.length === 0 || statements.length > MAX_STATEMENTS) {
      send(400, { error: `statements requis (1-${MAX_STATEMENTS})` }); return;
    }
    if (statements.some((item) => typeof item?.sql !== "string" || !item.sql.trim())) {
      send(400, { error: "sql manquant" }); return;
    }
    let client;
    try {
      client = await pool.connect();
      const results = [];
      for (const item of statements) {
        const out = await client.query(item.sql, (Array.isArray(item.params) ? item.params : []).map(decodeParam));
        results.push({ rows: out.rows ?? [], rowCount: out.rowCount ?? 0 });
      }
      send(200, { results });
    } catch (error) {
      send(500, { error: String(error?.message ?? error).slice(0, 500) });
    } finally {
      client?.release();
    }
    return;
  }

  send(404, { error: "introuvable" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[db-gateway] en écoute sur 127.0.0.1:${PORT}`));

process.on("SIGTERM", () => { server.close(); pool.end().finally(() => process.exit(0)); });
