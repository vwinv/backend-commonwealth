import { mkdirSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const uploadRoot = join(process.cwd(), 'uploads');
  mkdirSync(join(uploadRoot, 'documents'), { recursive: true });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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
