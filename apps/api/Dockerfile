# Contexte de build : racine du monorepo (flyctl deploy depuis la racine).
FROM node:22-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mbolo/contracts build
RUN pnpm --filter @mbolo/api build
RUN pnpm --filter @mbolo/api exec prisma generate

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN mkdir -p /data/uploads

WORKDIR /app
COPY --from=builder /app /app

EXPOSE 4000
# Migrations SQLite appliquées sur le volume persistant avant le démarrage.
CMD ["sh", "-c", "pnpm --filter @mbolo/api exec prisma migrate deploy && node apps/api/dist/main.js"]
