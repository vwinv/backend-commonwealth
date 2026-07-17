import { mkdirSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const uploadRoot = join(process.cwd(), 'uploads');
  mkdirSync(join(uploadRoot, 'documents'), { recursive: true });
  mkdirSync(join(uploadRoot, 'ateliers'), { recursive: true });
  mkdirSync(join(uploadRoot, 'health-signatures'), { recursive: true });
  mkdirSync(join(uploadRoot, 'enrollment-signatures'), { recursive: true });
  mkdirSync(join(uploadRoot, 'document-signatures'), { recursive: true });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  // Signatures (data URL base64) > limite Express par défaut (100kb).
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use('/uploads', express.static(uploadRoot));
  app.enableShutdownHooks();
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });
  app.setGlobalPrefix('api');
  // 3001 par défaut pour laisser `npm run dev` (Nuxt) sur 3000.
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
