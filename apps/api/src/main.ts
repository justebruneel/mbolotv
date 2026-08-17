import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
// undici npm (corrigé) remplace celui embarqué dans Node 22.x : l'embarqué
// plante le process sur certaines réponses volumineuses (nodejs/undici#5360).
import { fetch as undiciFetch } from 'undici';
import { AppModule } from './app.module';

// Limite haute des corps de requête : nécessaire pour les téléversements de
// playlists M3U depuis la console (jusqu'à plusieurs centaines de Mo).
// Les routes JSON ne sont pas affectées (validation Zod des payloads réels).
const UPLOAD_BODY_LIMIT = 512 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  installProcessSafetyNet();
  // Les signatures diffèrent légèrement (RequestInfo) : comportement identique.
  globalThis.fetch = undiciFetch as typeof fetch;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: UPLOAD_BODY_LIMIT }),
  );
  const config = app.get(ConfigService);
  const instance = app.getHttpAdapter().getInstance();
  await instance.register(cookie);

  // Corps bruts (téléversements de playlists .m3u) : Fastify ne parse que le
  // JSON par défaut et renverrait 415 sur application/octet-stream.
  for (const contentType of ['application/octet-stream', 'text/plain', 'application/x-mpegurl']) {
    instance.addContentTypeParser(
      contentType,
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
  }

  app.enableCors({
    origin: corsOrigins(config),
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('api');

  if (config.get<string>('STORAGE_DRIVER', 'local') === 'local') {
    const uploadsDir = resolve(config.get<string>('STORAGE_LOCAL_DIR', './uploads'));
    await mkdir(uploadsDir, { recursive: true });
    await instance.register(fastifyStatic, { root: uploadsDir, prefix: '/uploads/' });
  }

  const port = config.get<number>('API_PORT', 4000);
  await app.listen(port, '0.0.0.0');
  console.info(`Mbolo TV API listening on http://localhost:${port}`);
}

void bootstrap();

/**
 * Filet de sécurité : undici (Node < correctif nodejs/undici#5360) peut lever
 * une AssertionError incatchable depuis le handler 'end' d'un socket quand un
 * corps de réponse reste non lu et que le fournisseur ferme la connexion.
 * On journalise et on continue au lieu de laisser le process mourir.
 */
function installProcessSafetyNet(): void {
  const log = (source: string, error: unknown): void => {
    console.error(`[process] ${source} (non fatal, le serveur continue) :`, error);
  };
  process.on('uncaughtException', (error) => log('uncaughtException', error));
  process.on('unhandledRejection', (reason) => log('unhandledRejection', reason));
}

function corsOrigins(config: ConfigService): string[] {
  const fromEnv = (config.get<string>('CORS_ALLOWED_ORIGINS', '') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  // Par défaut on accepte localhost et 127.0.0.1 : l'hôte saisi dans le
  // navigateur ne doit pas casser l'authentification de la console.
  const configured = config.get<string>('APP_URL', 'http://localhost:3000');
  return Array.from(new Set([configured, 'http://localhost:3000', 'http://127.0.0.1:3000']));
}
