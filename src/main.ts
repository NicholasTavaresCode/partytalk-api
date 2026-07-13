import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Structured logging as the app-wide logger.
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<AppConfig, true>);

  // Security headers (security-sanitize-output) + tight CORS.
  app.use(helmet());
  app.enableCors({
    origin: config.get('corsOrigins', { infer: true }),
    credentials: true,
  });

  // URI-based API versioning: /v1/...  (api-versioning).
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // OpenAPI docs at /docs (served after versioning so operation paths are correct).
  setupSwagger(app);

  // Zero-downtime deploys: close connections/flush on SIGTERM (devops-graceful-shutdown).
  app.enableShutdownHooks();

  const port = config.get('port', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`PartyTalk API listening on port ${port}`);
}

void bootstrap();
