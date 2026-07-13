import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard';
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
        // Human-friendly logs in dev; structured JSON in production.
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        redact: ['req.headers.authorization'],
        autoLogging: process.env.NODE_ENV !== 'test',
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
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
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
