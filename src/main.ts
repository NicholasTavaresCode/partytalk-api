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
  // A literal "*" cannot be combined with credentials — the browser needs the
  // caller's specific origin echoed back. So when CORS_ORIGINS is "*" we use
  // `origin: true`, which reflects the request origin (and allows credentials);
  // otherwise we allow only the configured origins.
  const corsOrigins = config.get('corsOrigins', { infer: true });
  const allowAnyOrigin = corsOrigins.includes('*');
  app.enableCors({
    origin: allowAnyOrigin ? true : corsOrigins,
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

  // Startup summary — makes the effective auth/CORS config obvious at a glance,
  // so misconfig (wrong client id, missing origin) is caught without guessing.
  const logger = app.get(Logger);
  const env = config.get('env', { infer: true });
  const auth = config.get('auth', { infer: true });

  logger.log(
    `PartyTalk API listening on http://localhost:${port}/api/v1 [${env}]`,
  );
  logger.log(
    `CORS allowed origins: ${
      allowAnyOrigin ? '(any origin — reflected)' : corsOrigins.join(', ') || '(none)'
    }`,
  );
  if (auth.disabled) {
    logger.warn(
      'AUTH DISABLED (AUTH_DISABLED=true) — every request is treated as a dev user. Do not deploy like this.',
    );
  } else {
    logger.log(
      `Auth: Google Identity — expected client id (aud): ${auth.googleOAuthClientId || '(UNSET!)'}`,
    );
    logger.log(
      `Auth domain allow-list: ${auth.allowedAuthDomains.join(', ') || '(open sign-up — any verified Google account)'}`,
    );
  }
}

void bootstrap();
