import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { fetch as undiciFetch } from 'undici';
import { AppModule } from './app.module';

const UPLOAD_BODY_LIMIT = 512 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  installProcessSafetyNet();
  globalThis.fetch = undiciFetch as typeof fetch;
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: UPLOAD_BODY_LIMIT }));
  const config = app.get(ConfigService);
  const instance = app.getHttpAdapter().getInstance();
  await instance.register(cookie);

  // Les playlists sont traitées en flux, jamais matérialisées entièrement dans le heap.
  for (const contentType of ['application/octet-stream', 'text/plain', 'application/x-mpegurl']) {
    instance.addContentTypeParser(contentType, (request, payload, done) => done(null, payload));
  }

  app.enableCors({
    origin: corsOrigins(config),
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'range', 'x-requested-with'],
    exposedHeaders: ['content-length', 'content-range', 'accept-ranges'],
    maxAge: 86_400,
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

function installProcessSafetyNet(): void {
  const log = (source: string, error: unknown): void => console.error(`[process] ${source} (non fatal, le serveur continue) :`, error);
  process.on('uncaughtException', (error) => log('uncaughtException', error));
  process.on('unhandledRejection', (reason) => log('unhandledRejection', reason));
}

function corsOrigins(config: ConfigService): string[] | true {
  // Render peut conserver une ancienne valeur CORS_ALLOWED_ORIGINS qui ne
  // correspond pas au domaine Vercel actif. Le mode permissif est volontaire:
  // l’API catalogue et le proxy de lecture sont publics, et SameSite=strict
  // protège les cookies de la console owner contre les requêtes cross-site.
  const mode = (config.get<string>('CORS_MODE', 'permissive') ?? 'permissive').trim().toLowerCase();
  if (mode !== 'strict') return true;

  const origins = (config.get<string>('CORS_ALLOWED_ORIGINS', '') ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return origins.length > 0 ? origins : true;
}
