#!/usr/bin/env bash
# Redéploiement de l'API : l'image embarque le code (aucun bind mount du
# dépôt), donc on copie le dist compilé + le schéma/migrations Prisma dans
# le conteneur, on y régénère le client Prisma, on y resynchronise les
# dépendances (un nouveau paquet dans package.json — ex. web-push — sinon
# crash au boot en boucle), puis on redémarre — la commande de démarrage du
# conteneur applique `prisma migrate deploy`.
#
# Usage : sudo bash scripts/deploy-api.sh [id-ou-nom-du-conteneur]
set -euo pipefail

# Conteneur par défaut : nom compose (mbolotv-api-1) — l'ancien id figé
# survivait au remplacement du conteneur et finissait en « No such container ».
CONTAINER="${1:-mbolotv-api-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORKDIR="$(docker exec "$CONTAINER" pwd)"
echo "→ Conteneur $CONTAINER, workdir : $WORKDIR"

echo "→ Copie du dist compilé…"
docker cp "$ROOT/apps/api/dist/." "$CONTAINER:$WORKDIR/apps/api/dist"

echo "→ Copie du schéma et des migrations Prisma…"
docker cp "$ROOT/apps/api/prisma/schema.prisma" "$CONTAINER:$WORKDIR/apps/api/prisma/schema.prisma"
docker exec "$CONTAINER" mkdir -p "$WORKDIR/apps/api/prisma/migrations"
docker cp "$ROOT/apps/api/prisma/migrations/." "$CONTAINER:$WORKDIR/apps/api/prisma/migrations/"

echo "→ Copie du package.json et du lockfile (définition des dépendances)…"
docker cp "$ROOT/apps/api/package.json" "$CONTAINER:$WORKDIR/apps/api/package.json"
docker cp "$ROOT/pnpm-lock.yaml" "$CONTAINER:$WORKDIR/pnpm-lock.yaml"

echo "→ Installation des dépendances dans le conteneur (no-op si à jour)…"
# NODE_ENV=development : le conteneur tourne en production, mais sans ça pnpm
# SAUTE les devDependencies (et prune le CLI prisma déjà installé) — le boot
# lance `prisma migrate deploy` (CLI en devDependencies).
# CI=true : pnpm n'affiche aucune invite (sinon il sort sans rien faire en
# mode non interactif).
docker exec "$CONTAINER" sh -c "cd '$WORKDIR' && NODE_ENV=development CI=true pnpm install --no-frozen-lockfile"

echo "→ Régénération du client Prisma dans le conteneur…"
docker exec "$CONTAINER" sh -c "cd '$WORKDIR' && pnpm --filter @mbolo/api exec prisma generate"

echo "→ Redémarrage (migrate deploy automatique au boot)…"
docker restart "$CONTAINER"

# Le boot applique migrate deploy + génération Prisma : compter plusieurs minutes.
for _ in $(seq 1 60); do
  sleep 5
  if curl -fs -o /dev/null "http://127.0.0.1:4000/api/health" 2>/dev/null; then
    echo "✔ API en ligne — routes favoris actives."
    exit 0
  fi
done

echo "✖ API injoignable après 60 s — vérifier : docker logs $CONTAINER"
exit 1
