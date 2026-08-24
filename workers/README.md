# Workers Cloudflare — Mbolo TV

Toute la partie runtime de Mbolo TV tient dans **deux Cloudflare Workers** (plan
gratuit, aucune carte bancaire) : aucun serveur, aucun Docker, aucun processus
permanent. Chaque brique est soit une route HTTP déclenchée par une requête,
soit un Cron Trigger déclenché par une horloge.

## `mbolo-tv-video-proxy` — relais vidéo à la marge

Proxy HLS avec réécriture de playlists et cache edge (`caches.default`).
La source IPTV ne reçoit qu'une requête par segment unique grâce au cache,
peu importe le nombre de spectateurs simultanés ; la bande passante résidentielle
n'est jamais sollicitée.

- Déploiement : `npx wrangler deploy` (dans ce dossier)
- URL publique : `https://mbolo-tv-video-proxy.mbolo-tv-video-proxy.workers.dev/?url=<URL encodée>`
- Seek/scrubbing : en-têtes `Range` transmis à l'origine (réponses 206).

## `mbolo-tv-api` — API métier + imports + crons

Connecté à Neon Postgres via **Hyperdrive** (driver `pg`, `nodejs_compat`).

### Routes publiques (consommées par le frontend web)

```
GET  /api/health · /api/categories
GET  /api/channels?category&country&q&limit&offset · /api/channels/countries
GET  /api/channels/:id · /:id/epg · /:id/play
GET  /api/matches?state&sport&from&to · GET/POST /api/matches/:id(/play)
GET  /api/epg/range · /api/programmes/search?q
POST /api/activity/heartbeat · GET /api/activity/counts · /api/activity/viewers/:channelId
GET  /api/access/status · POST /api/access/redeem
```

### Routes console propriétaire (`cookie mbolo_owner_session`, JWT HS256)

```
POST /api/owner/auth/login · logout · GET session · GET/DELETE sessions(/:id)
GET  /api/owner/sources · POST create · GET/PATCH/DELETE /:id · GET /:id/test · /:id/credentials
POST /api/owner/sources/:id/import            → ImportRun exécuté via waitUntil
GET  /api/owner/imports · /:id · POST /:id/cancel
GET  /api/owner/overview · catalog · catalog/channels
POST /api/owner/categories · PATCH categories/:id · PATCH channels/:id · POST channels/:id/test
GET/PATCH /api/owner/profile · GET audit
GET/POST /api/owner/access-codes · DELETE /:id
```

L'import M3U/XTREAM (fetch playlist, parsing, upserts Category/Channel/StreamVariant,
prune des variantes disparues, EPG auto) tourne **dans le Worker** : ni Redis,
ni BullMQ, ni filesystem. Les logos conservent leur URL d'origine (`logoKey`),
ce qui évite tout stockage côté edge. Un import volumineux peut aussi être
repris par le Cron `*/2 * * * *` qui reprend tout `ImportRun` resté `QUEUED`.

### Cron Triggers (wrangler.toml `[triggers]`)

| Cron | Rôle |
|---|---|
| `*/2 * * * *` | reprise des imports `QUEUED` |
| `*/10 * * * *` | santé des flux (batch 10, GET 1 Mo max, pause 400 ms) |
| `*/15 * * * *` | découverte de matchs depuis l'EPG |
| `0 5 * * *` | import XMLTV complet |

### Configuration

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "75d74bf3c4b24e36ab9666697030b0fb"
```

Secrets :
- `ENCRYPTION_KEY` — AES-256-GCM des locators/connexions (`iv(12)|tag(16)|ct`,
  clé = SHA-256 du secret). Doit être identique entre toutes les instances.
- `JWT_ACCESS_SECRET` — signature des sessions owner.
- `wrangler secret put <NOM>` pour chacun.

Variables (`[vars]`) : `VIDEO_PROXY_URL`, `PUBLIC_API_URL` (base des logos),
`CORS_ALLOWED_ORIGINS`, `MATCH_DETECTION_ENABLED`, `EPG_MAX_BYTES`…

### Scripts utilitaires (`workers/mbolo-tv-api/scripts`)

- `apply-ddl.mjs` : table `ActivityHeartbeat` (compteurs spectateurs 60 s).
- `bootstrap-owner.mjs "<url>" "<email>" "<password>"` : provisionne le compte
  OWNER (PBKDF2-SHA256 100 k itérations — plafond PBKDF2 du runtime Workers)
  et révoque les sessions actives. À relancer après tout changement de mot de passe.
- `seed-test-grant.mjs` / `cleanup-test-channel.mjs` : fixtures de test `/play`.

## Ce qui reste du backend NestJS (`apps/api`)

Code de référence et tests unitaires (74 tests Jest). Redis/BullMQ/ioredis ont
été **entièrement retirés** du projet ainsi que le service `apps/worker`.
Aucune partie de l'application ne nécessite un processus permanent.
