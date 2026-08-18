# Déploiement gratuit sans carte bancaire (Vercel + Render + Neon + Supabase)

Architecture cible — 100 % tier gratuit, **aucune carte bancaire** :

- **Web (Next.js)** → [Vercel](https://vercel.com) — gratuit, auto-deploy sur chaque push vers `main`.
- **API (NestJS)** → [Render](https://render.com) — web service Docker gratuit (512 Mo RAM, 100 Go egress/mois).
- **Base de données (PostgreSQL)** → [Neon](https://neon.tech) — gratuit (0,5 Go), persistant, sans carte.
- **Logos + playlists téléversées** → [Supabase Storage](https://supabase.com) (S3 compatible, 1 Go gratuit).

L'API ne peut pas tourner sur Vercel : le proxy vidéo exige un process long-running
(timeouts serverless, pas de stockage persistant, sessions en mémoire perdues à chaque cold start).
Fly.io ne propose plus de tier gratuit aux nouveaux comptes (carte obligatoire) — d'où Render.

## 1. Neon — base de données PostgreSQL

1. Inscrire un compte sur neon.tech (gratuit, sans carte).
2. Créer un projet (région proche, ex. `eu-central-1` (Francfort)).
3. Dans *Connection Details*, copier la chaîne de connexion du pooler **direct**
   (`postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`).
4. Créer une branche `dev` (pour les essais locaux) et une branche `main` (production).

## 2. Supabase Storage — logos et playlists (optionnel mais recommandé)

1. Inscrire un compte sur supabase.com (gratuit, sans carte) et créer un projet.
2. *Storage → S3 Access Keys* : créer une clé, noter l'access key et la secret key.
3. Créer un bucket privé (ex. `mbolo`) — les logos sont servis via URL signées, pas besoin de bucket public.
4. Endpoint S3 : `https://<project-ref>.supabase.co/storage/v1/s3` (région `us-east-1`).

> Sans Supabase, garder `STORAGE_DRIVER=local` : logos et playlists téléversées vivent
> sur le disque éphémère de Render et sont perdus à chaque redéploiement.

## 3. Render — API

Prérequis : compte Render (gratuit, sans carte) connecté à GitHub.

La config est dans `render.yaml` à la racine (blueprint) :

1. dashboard.render.com → *New +* → *Blueprint* → sélectionner le repo `mbolotv`.
2. Le blueprint crée le service `mbolo-tv-api` (Docker, plan free, région Francfort, health check `/api/health`).
3. Renseigner les variables d'environnement demandées (saisie unique dans le dashboard) :

   | Variable | Valeur |
   | --- | --- |
   | `DATABASE_URL` | chaîne de connexion Neon (branche `main`) |
   | `ENCRYPTION_KEY` | `openssl rand -base64 32` — **ne jamais changer ensuite** (connexions chiffrées) |
   | `OWNER_EMAIL` | compte owner (provisionné au boot) |
   | `OWNER_CONSOLE_PATH` | chemin privé de la console (ex. `/control/mot-de-passe-long`) |
   | `CORS_ALLOWED_ORIGINS` | `https://VOTRE-APP.vercel.app` (URL Vercel réelle) |
   | `APP_URL` | `https://VOTRE-APP.vercel.app` |
   | `PUBLIC_API_URL` | `https://mbolo-tv-api.onrender.com` |
   | `STORAGE_DRIVER` | `s3` (ou `local` si pas de Supabase) |
   | `S3_ENDPOINT` | `https://<project-ref>.supabase.co/storage/v1/s3` |
   | `S3_ACCESS_KEY` / `S3_SECRET_KEY` | clés Supabase S3 |
   | `S3_BUCKET` | `mbolo` |
   | `S3_REGION` | `us-east-1` |

4. *Apply* → déploiement (build Docker, ~5-10 min au premier coup).
5. Vérifier : `curl https://mbolo-tv-api.onrender.com/api/health` → `{"status":"ok",...}`.

### Limites du tier gratuit Render

- **Sleep** : l'instance dort après 15 min sans trafic ; la première requête après
  réveil met ~1 min (cold start). En visionnage actif (segments toutes les 5-10 s),
  l'instance reste éveillée.
- **Disque éphémère** : toute donnée écrite hors Supabase (DB locale, uploads locaux) est
  perdue à chaque redéploiement → la DB est sur Neon et le stockage sur Supabase par design.
- **Egress** : 100 Go/mois cumulés (proxying vidéo + logos). ~1-2 Go/heure de visionnage.

## 4. Vercel — Web

1. vercel.com → *Add New Project* → importer le repo GitHub `mbolotv`.
2. **Root Directory** : `apps/web`.
3. Framework détecté : Next.js — build/install command par défaut.
4. Environment variables :

   | Variable | Valeur |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | `https://mbolo-tv-api.onrender.com` |

5. *Deploy*. Chaque push sur `main` redéploie automatiquement.

## 5. Ordre de déploiement recommandé

1. Neon (base) → 2. Supabase Storage → 3. Render (API, avec l'URL Vercel dans le CORS) → 4. Vercel.

## 6. Développement local

La base est désormais PostgreSQL partout (y compris en dev) :

```sh
# apps/api/.env (et .env racine)
DATABASE_URL=postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Utiliser la branche `dev` de Neon pour ne pas polluer la production.
Les migrations sont appliquées automatiquement par `prisma migrate deploy` au boot du
conteneur ; en local : `pnpm --filter @mbolo/api exec prisma migrate dev`.

> Ancienne base SQLite locale (`apps/api/prisma/dev.db`) : non utilisée par le nouveau
> schéma. Réimporter les sources depuis la console après le passage à Postgres.

## 7. Notes

- Le workflow GitHub Actions `ci.yml` valide typecheck + tests + build sur chaque push.
- Les crons de health-check tournent dans le process API (in-process) — pas de service séparé.
- `apps/worker` (BullMQ) n'est pas déployé : `QUEUE_DRIVER=inprocess` suffit pour un
  process unique. Si un jour plusieurs instances : `QUEUE_DRIVER=bullmq` + Redis géré
  (Upstash free) + `STREAM_SESSION_STORE=redis` + `STREAM_PLAYLIST_CACHE=redis`.