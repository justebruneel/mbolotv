# Contexte de build : racine du monorepo (Render, Fly ou autre avec Docker).
FROM node:22-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mbolo/contracts build
RUN pnpm --filter @mbolo/api exec prisma generate
RUN pnpm --filter @mbolo/api build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN mkdir -p /data/uploads

WORKDIR /app
COPY --from=builder /app /app

EXPOSE 4000
# Migrations PostgreSQL (Prisma) appliquées avant le démarrage.
# PRISMA_MIGRATE_SKIP_ADVISORY_LOCKING : tolère une URL "pooled" (Neon) ; avec une
# connexion directe la variable est sans effet.
CMD ["sh", "-c", "PRISMA_MIGRATE_SKIP_ADVISORY_LOCKING=1 pnpm --filter @mbolo/api exec prisma migrate deploy && node apps/api/dist/main.js"]
