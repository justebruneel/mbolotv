import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get(ConfigService);
  const instance = app.getHttpAdapter().getInstance();
  await instance.register(cookie);

  app.enableCors({
    origin: config.get<string>('APP_URL', 'http://localhost:3000'),
    credentials: true,
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
