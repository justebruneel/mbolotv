# Déploiement (Vercel + Fly.io)

Architecture cible :

- **Web (Next.js)** → [Vercel](https://vercel.com) — gratuit, auto-deploy sur chaque push vers `main`.
- **API (NestJS)** → [Fly.io](https://fly.io) — 3 VM gratuites, volume persistant 3 Go (SQLite + uploads + logos), 160 Go d'egress/mois.

L'API ne peut pas tourner sur Vercel : le proxy vidéo exige un process long-running
(timeouts serverless, pas de stockage persistant, sessions en mémoire perdues à chaque cold start).

## 1. Fly.io — API

Prérequis : compte Fly.io (gratuit, pas de carte bancaire) et `flyctl` :

```sh
curl -L https://fly.io/install.sh | sh
fly auth login
```

Créer l'app et le volume, puis déployer (la config est dans `fly.toml` à la racine) :

```sh
fly apps create mbolo-tv-api
fly volumes create mbolo_data --app mbolo-tv-api --size 1 --region ams
fly deploy --remote-only
```

> `--remote-only` : le build Docker est fait sur les machines de Fly (aucun Docker local requis).

### Secrets (jamais dans le repo)

```sh
fly secrets set --app mbolo-tv-api \
  JWT_ACCESS_SECRET="$(openssl rand -base64 48)" \
  JWT_REFRESH_SECRET="$(openssl rand -base64 48)" \
  ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  OWNER_CONSOLE_PATH="/control/CHANGEZ-CE-CHEMIN" \
  OWNER_EMAIL="votre@email.com" \
  OWNER_PASSWORD="UN-MOT-DE-PASSE-FORT" \
  CORS_ALLOWED_ORIGINS="https://VOTRE-APP.vercel.app" \
  APP_URL="https://VOTRE-APP.vercel.app" \
  API_URL="https://mbolo-tv-api.fly.dev" \
  PUBLIC_API_URL="https://mbolo-tv-api.fly.dev"
```

- `ENCRYPTION_KEY` : base64 de 32 octets — **ne jamais changer après la première base de données** (les connexions chiffrées seraient indéchiffrables).
- `OWNER_EMAIL` / `OWNER_PASSWORD` : le compte owner est provisionné automatiquement au premier démarrage.
- `CORS_ALLOWED_ORIGINS` : remplacer `VOTRE-APP.vercel.app` par l'URL Vercel réelle.
- Les valeurs par défaut (`QUEUE_DRIVER=inprocess`, `STREAM_SESSION_STORE=memory`, `DATABASE_URL=file:/data/dev.db`, …) sont déjà dans `fly.toml`.

### Déploiement GitHub Actions

Le workflow `.github/workflows/deploy.yml` déploie automatiquement l'API à chaque
push sur `main` touchant l'API. Prérequis : un token d'accès Fly dans les secrets du repo :

```sh
fly tokens create deploy --app mbolo-tv-api
```

→ GitHub → repo → Settings → Secrets and variables → Actions → `FLY_API_TOKEN`.

### Vérification

```sh
curl https://mbolo-tv-api.fly.dev/api/health
# {"status":"ok","uptimeSeconds":...}
```

## 2. Vercel — Web

1. vercel.com → *Add New Project* → importer le repo GitHub `mbolotv`.
2. **Root Directory** : `apps/web`.
3. Framework détecté : Next.js — build command et install command par défaut.
4. Environment variables (build time, le client lit `NEXT_PUBLIC_API_URL`) :

   | Variable | Valeur |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | `https://mbolo-tv-api.fly.dev` |

5. *Deploy*. Chaque push sur `main` redéploie automatiquement.

Mettre à jour ensuite le secret Fly `CORS_ALLOWED_ORIGINS` et `APP_URL` avec l'URL
`https://VOTRE-APP.vercel.app` réelle, puis redéployer l'API (`fly deploy`).

## 3. Limites du tier gratuit

- **Egress** : 160 Go/mois cumulés (proxying vidéo + logos). Une heure de
  visionnage ≈ 1-2 Go. Au-delà, l'instance reste up mais facturée à l'usage
  (aucune coupure — surveiller le dashboard Fly).
- **VM** : 256 Mo de RAM, 1 vCPU partagé. L'import M3U et l'upload de playlist
  sont streamés (mémoire bornée), mais un import géant (500 Mo+) sera lent.
- **Volume** : 3 Go gratuits (SQLite + uploads + logos). Les logos importés
  comptent dans ce quota : surveiller `fly volume snapshots` / le dashboard.
- **Vercel Hobby** : builds et fonctions en nombre limité — amplement suffisant
  pour cette app (pages statiques + SSR minimal).

## 4. Notes

- La base SQLite vit sur le volume Fly (`/data/dev.db`) : les redéploiements
  ne perdent rien. Pour repartir de zéro : `fly volumes destroy mbolo_data` puis recréer.
- Les crons de health-check tournent dans le process API (in-process) — pas de service séparé.
- `apps/worker` (BullMQ) n'est pas déployé : `QUEUE_DRIVER=inprocess` suffit pour un
  process unique. Si un jour plusieurs instances : `QUEUE_DRIVER=bullmq` + Redis géré
  (Upstash free) + `STREAM_SESSION_STORE=redis` + `STREAM_PLAYLIST_CACHE=redis`.
