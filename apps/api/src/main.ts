import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { fetch as undiciFetch, setGlobalDispatcher, Agent } from 'undici';
import { AppModule } from './app.module';
import { TunnelSafeExceptionFilter } from './common/filters/tunnel-safe-exception.filter';

const UPLOAD_BODY_LIMIT = 512 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  installProcessSafetyNet();
  globalThis.fetch = undiciFetch as typeof fetch;
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: UPLOAD_BODY_LIMIT }));
  const config = app.get(ConfigService);
  app.useGlobalFilters(new TunnelSafeExceptionFilter());
  // Sur certaines machines (pas de sortie IPv6 réelle, ULA Tailscale en global),
  // undici tente l'IPv6 et échoue. On force IPv4 pour les fetches sortants.
  if (config.get<string>('FORCE_IPV4', 'false') === 'true') {
    setGlobalDispatcher(new Agent({ connect: { family: 4, autoSelectFamily: false } }));
  }
  const instance = app.getHttpAdapter().getInstance();
  await instance.register(cookie);

  // Les playlists sont traitées en flux, jamais matérialisées entièrement dans le heap.
  // Les outils IPTV externes poussent les .m3u/.m3u8 avec des MIME très variés :
  // on déclare les variantes courantes puis un repli générique pour ne plus
  // renvoyer de 415 « Unsupported Media Type » sur /owner/sources/:id/playlist.
  const streamContentTypes = ['application/octet-stream', 'text/plain', 'application/x-mpegurl', 'application/vnd.apple.mpegurl', 'audio/x-mpegurl', 'audio/mpegurl'];
  for (const contentType of streamContentTypes) {
    instance.addContentTypeParser(contentType, (_request, payload, done) => done(null, payload));
  }
  // Repli générique : tout autre MIME arrive en Buffer (l'upload de playlist
  // accepte les deux formes) au lieu d'un 415 bloquant.
  instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => done(null, payload));

  const cors = resolveCors(config);
  app.enableCors({
    origin: cors.origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'range', 'x-requested-with', 'x-device-id'],
    exposedHeaders: ['content-length', 'content-range', 'accept-ranges'],
    maxAge: 86_400,
  });
  app.setGlobalPrefix('api');

  if (config.get<string>('STORAGE_DRIVER', 'local') === 'local') {
    const uploadsDir = resolve(config.get<string>('STORAGE_LOCAL_DIR', './uploads'));
    await mkdir(uploadsDir, { recursive: true });
    await instance.register(fastifyStatic, {
      root: uploadsDir,
      prefix: '/uploads/',
      // Les logos sont adressés par clé de fichier : un changement de logo
      // change d'URL → cache long sans risque de servir du périmé.
      setHeaders: (response) => {
        response.header('cache-control', 'public, max-age=86400');
      },
    });
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

function resolveCors(config: ConfigService): { origins: string[] | boolean } {
  const isProd = (config.get<string>('NODE_ENV') ?? 'development').trim().toLowerCase() === 'production';
  const mode = (config.get<string>('CORS_MODE') ?? (isProd ? 'strict' : 'permissive')).trim().toLowerCase();
  if (mode === 'permissive') return { origins: true };

  const origins = (config.get<string>('CORS_ALLOWED_ORIGINS', '') ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (origins.length === 0) {
    // Refuser CORS plutôt que de retomber silencieusement sur un mode permissif :
    // une liste vide en mode strict est une erreur de configuration qui ne doit
    // pas devenir une faille. La console owner fonctionne en same-origin (proxy
    // reverse) : seul le navigateur cross-origin nécessite CORS_ALLOWED_ORIGINS.
    console.error(`[cors] CORS_MODE=strict mais CORS_ALLOWED_ORIGINS est vide → CORS refusé. Configurez CORS_ALLOWED_ORIGINS (ex: https://mbolo.tv).`);
    return { origins: false };
  }
  return { origins };
}
