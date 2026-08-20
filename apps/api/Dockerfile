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
# Neon fournit souvent DATABASE_URL via PgBouncer (-pooler), mais Prisma Migrate
# a besoin d’une connexion directe pour pg_advisory_lock. DIRECT_URL est prioritaire;
# sinon on dérive l’URL directe depuis l’URL Neon poolée.
CMD ["sh", "-c", "MIGRATION_DATABASE_URL=\"${DIRECT_URL:-${DATABASE_URL/-pooler./.}}\" && DATABASE_URL=\"$MIGRATION_DATABASE_URL\" pnpm --filter @mbolo/api exec prisma migrate deploy && node apps/api/dist/main.js"]
