/**
 * Nettoyage one-shot des chaînes non lisibles :
 *  - marqueurs de dossiers M3U ("##### SPORTS #####") et sous-playlists
 *    conteneurs (.m3u) importées comme chaînes ;
 *  - chaînes orphelines (aucune variante) restées en base après suppression
 *    de leur source.
 *
 * Usage :
 *   tsx prisma/cleanup-fake-channels.ts          # dry-run (rapport uniquement)
 *   tsx prisma/cleanup-fake-channels.ts --apply  # suppression en cascade
 *
 * L'encryption des locators se base sur ENCRYPTION_KEY (voir .env).
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { isFolderMarker } from '../src/modules/sources/m3u.parser';

for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) loadEnv({ path });
}

const prisma = new PrismaClient();

function loadKey(): Buffer {
  const secret = process.env['ENCRYPTION_KEY'] ?? '';
  if (secret.length < 16) {
    throw new Error('ENCRYPTION_KEY doit contenir au moins 16 caractères');
  }
  return createHash('sha256').update(secret).digest();
}

function decrypt(payload: Uint8Array, key: Buffer): string {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function isContainerUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u');
  } catch {
    return false;
  }
}

function isSuspicious(url: string | null, name: string): boolean {
  if (isFolderMarker(name)) return true;
  if (url !== null && isContainerUrl(url)) return true;
  return false;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const key = loadKey();

  const channels = await prisma.channel.findMany({
    include: { variants: { select: { encryptedLocator: true } } },
  });

  const flagged: Array<{ id: string; name: string; reason: string }> = [];
  for (const channel of channels) {
    const urls: string[] = [];
    for (const variant of channel.variants) {
      try {
        urls.push(decrypt(new Uint8Array(variant.encryptedLocator), key));
      } catch {
        // Locator illisible : on ignore ce variant pour le diagnostic.
      }
    }
    if (channel.variants.length === 0) {
      flagged.push({ id: channel.id, name: channel.name, reason: 'orpheline (aucune variante)' });
      continue;
    }
    const nameFlag = isFolderMarker(channel.name);
    const urlFlag = urls.some((url) => isContainerUrl(url));
    if (nameFlag || urlFlag) {
      flagged.push({
        id: channel.id,
        name: channel.name,
        reason: [nameFlag ? 'marqueur de dossier' : null, urlFlag ? 'URL conteneur (.m3u)' : null]
          .filter(Boolean)
          .join(' + '),
      });
    }
  }

  console.log(`\n=== Nettoyage des fausses chaînes (${apply ? 'APPLICATION' : 'dry-run'}) ===`);
  console.log(`Chaînes analysées : ${channels.length}`);
  console.log(`Chaînes suspectes    : ${flagged.length}\n`);

  for (const entry of flagged) {
    console.log(`  - ${entry.name}  [${entry.reason}]`);
  }

  if (!apply) {
    console.log('\nAucune modification effectuée. Relancez avec --apply pour supprimer en cascade.');
    return;
  }

  const ids = flagged.map((entry) => entry.id);
  let removed = 0;
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const result = await prisma.channel.deleteMany({
      where: { id: { in: ids.slice(i, i + BATCH) } },
    });
    removed += result.count;
    console.log(`  ... ${Math.min(i + BATCH, ids.length)}/${ids.length} (${removed} supprimées)`);
  }
  console.log(`\nSupprimées : ${removed} chaînes (variants, favoris et EPG supprimés en cascade).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
