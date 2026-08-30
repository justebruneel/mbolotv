#!/usr/bin/env bash
# Redéploiement de l'API : l'image embarque le code (aucun bind mount du
# dépôt), donc on copie le dist compilé + le schéma/migrations Prisma dans
# le conteneur, on y régénère le client Prisma, puis on redémarre — la
# commande de démarrage du conteneur applique `prisma migrate deploy`.
#
# Usage : sudo bash scripts/deploy-api.sh [id-ou-nom-du-conteneur]
set -euo pipefail

CONTAINER="${1:-f42b1e919e0a}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORKDIR="$(docker exec "$CONTAINER" pwd)"
echo "→ Conteneur $CONTAINER, workdir : $WORKDIR"

echo "→ Copie du dist compilé…"
docker cp "$ROOT/apps/api/dist/." "$CONTAINER:$WORKDIR/apps/api/dist"

echo "→ Copie du schéma et des migrations Prisma…"
docker cp "$ROOT/apps/api/prisma/schema.prisma" "$CONTAINER:$WORKDIR/apps/api/prisma/schema.prisma"
docker exec "$CONTAINER" mkdir -p "$WORKDIR/apps/api/prisma/migrations"
docker cp "$ROOT/apps/api/prisma/migrations/." "$CONTAINER:$WORKDIR/apps/api/prisma/migrations/"

echo "→ Régénération du client Prisma dans le conteneur…"
docker exec "$CONTAINER" sh -c "cd '$WORKDIR' && pnpm --filter @mbolo/api exec prisma generate"

echo "→ Redémarrage (migrate deploy automatique au boot)…"
docker restart "$CONTAINER"

for _ in $(seq 1 30); do
  sleep 2
  if curl -fs -o /dev/null "http://127.0.0.1:4000/api/health" 2>/dev/null; then
    echo "✔ API en ligne — routes favoris actives."
    exit 0
  fi
done

echo "✖ API injoignable après 60 s — vérifier : docker logs $CONTAINER"
exit 1
