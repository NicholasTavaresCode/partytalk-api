# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PartyTalk API — backend for live group English-practice **rooms**. People talk by voice; the frontend does speech-to-text and streams **transcript segments** to the backend. An **AI facilitator** watches the rolling transcript and auto-suggests related topics (after N segments or X ms of silence), then writes a room **report** on end. Also ships a solo **IELTS exam simulator** (currently parked). Audio transport (WebRTC/SFU) is out of scope — the backend works from client-produced transcript, never raw audio.

Stack: NestJS 11 · Firestore · Firebase Auth · Socket.IO · Vertex AI (Gemini). Developed test-first (TDD).

## Commands

```bash
npm run start:dev         # watch mode (dev)
npm run start:prod        # from built dist/
npm run build             # nest build
npm run lint              # eslint --fix
npm run typecheck         # tsc --noEmit against tsconfig.build.json
npm test                  # unit tests (*.spec.ts, under src/)
npm run test:cov          # unit tests + coverage
npm run test:e2e          # e2e tests (*.e2e-spec.ts, under test/) — hermetic
npm test -- rooms.service # run a single unit test file by name filter
```

Served under `/api/v1`. Swagger UI at `/docs` (raw spec `/docs-json`). Health: `GET /api/v1/health/live`, `GET /api/v1/health/ready`.

## Architecture

Standard NestJS feature-module layout under `src/`. Cross-cutting concerns are registered **globally** in [app.module.ts](src/app.module.ts) so every feature inherits them — do not re-register per feature:

- **Rate limiting** then **auth** (order matters): `ThrottlerGuard` → `FirebaseAuthGuard` as `APP_GUARD`.
- **ValidationPipe** (`whitelist`, `forbidNonWhitelisted`, `transform`) as `APP_PIPE`.
- **Response envelope** `{ data, meta }` via `TransformInterceptor` (`APP_INTERCEPTOR`).
- **Centralized errors** via `AllExceptionsFilter` (`APP_FILTER`).
- Structured logging via `nestjs-pino` (`authorization` header redacted).

Bootstrap ([main.ts](src/main.ts)): helmet, CORS from config, URI versioning (`/api` prefix, default v1), graceful shutdown hooks.

### Two abstraction patterns that govern the whole codebase

1. **Repository pattern with DI tokens.** Every feature depends on an abstract `XRepository` class, never on Firestore directly. The module binds it via `{ provide: XRepository, useClass: FirestoreXRepository }`. Services stay persistence-agnostic and unit-testable with in-memory fakes. When adding persistence, add the method to the abstract class first, then implement it in the Firestore class.

2. **Provider abstractions for external services.** Identity (`TokenVerifier` in [auth/](src/auth/)) and LLM (`LlmProvider` in [ai/llm-provider.ts](src/ai/llm-provider.ts)) are abstract classes bound to concrete Firebase/Vertex implementations. `AiModule` and `AppConfigModule` are `@Global()`, so `LlmProvider` and `ConfigService<AppConfig>` inject anywhere without re-importing. To swap a provider or inject a fake, change the one `useClass` binding.

### Auth model

Secure by default: `FirebaseAuthGuard` protects **every** route. Opt a route out with `@Public()` ([common/decorators/public.decorator.ts](src/common/decorators/public.decorator.ts)). User-scoped endpoints derive identity from the verified token via `@CurrentUser()` — **never** from the URL. A user's document id is always their Firebase UID.

### Rooms realtime

`RoomsModule` wires both a REST `RoomsController` and a Socket.IO `RoomsGateway` (namespace `rooms`), and exports `RoomsService` so siblings reuse room logic without depending on the transport. Socket events — in: `joinRoom`, `leaveRoom`, `transcript`; out: `presence`, `transcript`, `topicSuggested`, `sessionEnded`.

Facilitator trigger logic lives in [rooms/facilitator/facilitator-policy.ts](src/rooms/facilitator/facilitator-policy.ts) as **pure functions** (no timers/IO) — the gateway owns the clock and calls them. Keep decision logic pure and testable; keep timing/state in the gateway.

### Config

Env is loaded and validated once at startup (fail-fast) via Joi in [config/validation.schema.ts](src/config/validation.schema.ts). Access typed config through `ConfigService<AppConfig>` ([config/configuration.ts](src/config/configuration.ts)), not `process.env`. See `.env.example`; point `FIRESTORE_EMULATOR_HOST` at the local emulator for offline dev.

## Testing conventions

Unit tests (`*.spec.ts` beside source) mock external services through the repository/provider abstractions — **no cloud access needed**. e2e tests (`test/*.e2e-spec.ts`) are hermetic and fake Firebase/Firestore. Both use `@swc/jest`. The `src/*` path alias maps in both jest configs.

## Known constraints / next steps

- Socket.IO handshake auth (verifying the Firebase token on connect, deriving speaker uid) is stubbed in the gateway.
- Facilitator per-room state (segment counters, silence timers) is **in-process** — assumes a single socket-server instance or sticky sessions. Multi-instance deploy needs shared state (e.g. Redis).
- IELTS is parked; exam content is served from Firestore, seed scripts not yet included.

## Conventions

An `.agents/skills/nestjs-best-practices` skill is vendored (see `skills-lock.json`); code comments reference its rule ids (e.g. `arch-use-repository-pattern`, `security-use-guards`). Follow those patterns when adding NestJS code.
