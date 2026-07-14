import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { GoogleAuthGuard } from './auth/google-auth.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AppConfigModule } from './config/config.module';
import { FirestoreModule } from './firestore/firestore.module';
import { HealthModule } from './health/health.module';
import { IeltsModule } from './ielts/ielts.module';
import { RoomsModule } from './rooms/rooms.module';
import { UsersModule } from './users/users.module';

/**
 * Root module. Cross-cutting concerns are registered globally here so every
 * feature module inherits them: structured logging, request validation, a
 * consistent response envelope, centralized error handling, rate limiting, and
 * secure-by-default authentication.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        // Verbose in dev (so guard/service `debug` diagnostics are visible),
        // quieter in prod. Override anytime with LOG_LEVEL=debug|info|warn.
        level:
          process.env.LOG_LEVEL ??
          (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        // Colorized, single-line, human-friendly logs in dev; JSON in prod.
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: 'SYS:HH:MM:ss.l',
                  // Drop noisy fields; the messages below carry what matters.
                  ignore: 'pid,hostname,req,res',
                },
              },
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        autoLogging: process.env.NODE_ENV !== 'test',
        // Make failures stand out: 4xx → warn, 5xx/errors → error.
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // One readable line per request instead of a serialized req/res blob.
        customSuccessMessage: (req, res) =>
          `${req.method} ${req.url} → ${res.statusCode}`,
        customErrorMessage: (req, res, err) =>
          `${req.method} ${req.url} → ${res.statusCode} (${err.message})`,
      },
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }],
    }),
    FirestoreModule,
    AuthModule,
    AiModule,
    HealthModule,
    UsersModule,
    RoomsModule,
    IeltsModule,
  ],
  providers: [
    // Rate limiting first, then authentication (security-rate-limiting, security-use-guards).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: GoogleAuthGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
