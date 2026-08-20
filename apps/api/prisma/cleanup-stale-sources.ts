/**
 * Nettoie les sources anciennes clairement non fonctionnelles.
 *
 * Dry-run par défaut, aucune suppression sans --apply.
 *
 * Exemples:
 *   pnpm --filter @mbolo/api exec tsx prisma/cleanup-stale-sources.ts
 *   pnpm --filter @mbolo/api exec tsx prisma/cleanup-stale-sources.ts --older-than-days=30
 *   pnpm --filter @mbolo/api exec tsx prisma/cleanup-stale-sources.ts --older-than-days=30 --apply
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) loadEnv({ path });
}

function directDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.replace('-pooler.', '.');
    return url.toString();
  } catch {
    return raw;
  }
}

const rawDatabaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!rawDatabaseUrl) throw new Error('DATABASE_URL ou DIRECT_URL est requis');
process.env.DATABASE_URL = process.env.DIRECT_URL || directDatabaseUrl(rawDatabaseUrl);

const prisma = new PrismaClient();
const ACTIVE_IMPORT_STATES = new Set(['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING']);

type CandidateSource = {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: Date;
  variants: Array<{ isActive: boolean }>;
  importRuns: Array<{ state: string; startedAt: Date }>;
};

function olderThanDays(): number {
  const value = process.argv.find((arg) => arg.startsWith('--older-than-days='))?.split('=')[1] ?? '30';
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--older-than-days doit être un entier entre 1 et 3650');
  return days;
}

function isCandidate(source: CandidateSource, cutoff: Date): { ok: boolean; reason: string } {
  if (source.createdAt >= cutoff) return { ok: false, reason: '' };
  if (source.variants.some((variant) => variant.isActive)) return { ok: false, reason: '' };
  if (source.importRuns.some((run) => ACTIVE_IMPORT_STATES.has(run.state))) return { ok: false, reason: '' };
  const latest = source.importRuns[0];
  if (source.status === 'FAILED') return { ok: true, reason: 'source FAILED, aucune variante active' };
  if (!latest) return { ok: true, reason: 'aucun import enregistré, aucune variante active' };
  if (latest.state === 'FAILED' || latest.state === 'CANCELED') return { ok: true, reason: `dernier import ${latest.state}, aucune variante active` };
  return { ok: false, reason: '' };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Dry-run par défaut. Ajoutez --apply pour supprimer les sources affichées et les chaînes devenues orphelines.');
    return;
  }
  const apply = process.argv.includes('--apply');
  const days = olderThanDays();
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const sources = await prisma.source.findMany({
    include: { variants: { select: { isActive: true } }, importRuns: { select: { state: true, startedAt: true }, orderBy: { startedAt: 'desc' }, take: 5 } },
    orderBy: { createdAt: 'asc' },
  }) as CandidateSource[];
  const candidates = sources.map((source) => ({ source, ...isCandidate(source, cutoff) })).filter((entry) => entry.ok);

  console.log(`\n=== Nettoyage Neon des sources obsolètes (${apply ? 'APPLICATION' : 'DRY-RUN'}) ===`);
  console.log(`Critère : créées avant ${cutoff.toISOString()} et sans variante active`);
  console.log(`Sources analysées : ${sources.length}`);
  console.log(`Sources candidates : ${candidates.length}\n`);
  for (const { source, reason } of candidates) console.log(`- ${source.name} [${source.kind}] ${source.id}: ${reason}`);

  if (!apply) {
    console.log('\nAucune modification effectuée. Relancez avec --apply uniquement après vérification de cette liste.');
    return;
  }
  if (candidates.length === 0) { console.log('\nRien à supprimer.'); return; }
  const ids = candidates.map(({ source }) => source.id);
  const removedSources = await prisma.source.deleteMany({ where: { id: { in: ids } } });
  const removedOrphans = await prisma.channel.deleteMany({ where: { variants: { none: {} } } });
  console.log(`\nSources supprimées : ${removedSources.count}`);
  console.log(`Chaînes orphelines supprimées : ${removedOrphans.count}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => void prisma.$disconnect());
