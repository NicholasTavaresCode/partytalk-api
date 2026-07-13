import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Human-readable descriptions for each tag, shown at the top of every group in
 * the Swagger UI. Keep tag names in sync with the `@ApiTags(...)` on controllers.
 */
const TAG_DESCRIPTIONS: Array<[name: string, description: string]> = [
  ['Health', 'Liveness and readiness probes for orchestration and uptime checks.'],
  [
    'Users',
    'The authenticated user’s own learner profile (English level, IELTS target). Identity always comes from the verified Firebase token — never from the URL.',
  ],
  [
    'Rooms',
    'Live group English-practice rooms guided by an AI host: create, discover, join/leave, run the session lifecycle, and exchange transcript messages. Realtime delivery is over the Socket.IO `rooms` namespace; these REST endpoints own persistence and host replies.',
  ],
  [
    'IELTS',
    'Solo IELTS exam simulator. Browse exam content per section, run an attempt, submit responses, and score it — Listening/Reading auto-scored against a key, Writing/Speaking graded by the AI against the IELTS band rubric.',
  ],
];

/**
 * Mounts the OpenAPI document at `/docs` (UI) and `/docs-json` (raw spec).
 * Documents the bearer-token scheme once so every `@ApiBearerAuth()` operation
 * shows the Authorize control.
 */
export function setupSwagger(app: INestApplication): void {
  const builder = new DocumentBuilder()
    .setTitle('PartyTalk API')
    .setDescription(
      [
        'Backend for PartyTalk — live group English-practice rooms with an AI host, plus a solo IELTS exam simulator.',
        '',
        '**Authentication.** All endpoints require a Firebase ID token as `Authorization: Bearer <token>` unless explicitly public (the health probes). Click **Authorize** and paste a token.',
        '',
        '**Response envelope.** Successful responses are wrapped as `{ "data": <payload>, "meta": { "timestamp": <ISO-8601> } }`. Errors use `{ statusCode, timestamp, path, message, error }`.',
        '',
        '**Versioning.** All routes are served under `/api/v1`.',
        '',
        '**Rate limiting.** 100 requests/minute per client; `429 Too Many Requests` when exceeded.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Firebase ID token obtained by the frontend after sign-in.',
      },
      'firebase',
    );

  for (const [name, description] of TAG_DESCRIPTIONS) {
    builder.addTag(name, description);
  }

  const document = SwaggerModule.createDocument(app, builder.build());

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'PartyTalk API — Docs',
  });
}
