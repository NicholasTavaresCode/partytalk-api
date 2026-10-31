# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is meant to be enough on its own: an agent working here may never see the frontend repo.

## What this is

PartyTalk API — backend for live group English-practice **rooms**. People talk by voice; the frontend runs speech-to-text and streams **transcript segments** to the backend (Socket.IO or REST). An **AI host** is always in the room: it is *consulted* every N segments or after X ms of silence, listens to the most recent window of the conversation (including its own earlier lines), decides on its own whether the current topic has been talked about enough, and when it has, *speaks* a short first-person line that moves the group onto a **completely different** topic ("Ok. Now let's talk about the Usain Bolt record."). Friction and adaptation are the product, not a side effect. Rooms have a fixed session length (10 to 60 minutes) and end on their own when time is up; on end the host writes one room-level **report**. The backend never sees raw audio — the live-audio design in [docs/audio-architecture.md](docs/audio-architecture.md) is proposed, not built.

Stack: NestJS 11 · Firestore (`firebase-admin`) · Google Identity ID tokens (`google-auth-library`) · Socket.IO · Vertex AI Gemini via `@google/genai`. Developed test-first (TDD).

## Commands

```bash
npm run start:dev             # watch mode
npm run build && npm run start:prod
npm run typecheck             # tsc --noEmit against tsconfig.build.json (excludes specs)
npm run lint                  # eslint --fix (also applies prettier)
npm test                      # unit tests: src/**/*.spec.ts
npm test -- rooms.service     # one unit test file by name filter
npm test -- -t "consultHost"  # by test name
npm run test:cov              # coverage (module/main/dto/entity/interface files excluded)
npm run test:e2e              # test/*.e2e-spec.ts — hermetic, no cloud access
docker compose up -d --build  # Firestore emulator (host port 8200) + the API image on $PORT.
                              # The image bakes in the source: without --build a code change is NOT picked up
```

Served under `/api/v1`. Swagger UI at `/docs` (raw spec `/docs-json`). Health: `GET /api/v1/health/live` and `/ready` — the only `@Public()` routes.

## Architecture

Standard NestJS feature-module layout under `src/` (`auth`, `users`, `rooms`, plus `ai`, `firestore`, `config`, `health`, `common`). Cross-cutting concerns are registered **once, globally** in [app.module.ts](src/app.module.ts); do not re-register them per feature:

- `APP_GUARD` order matters: `ThrottlerGuard` (100 req/min) runs before `GoogleAuthGuard`.
- `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform` and **no** implicit conversion — query DTOs need `@Type(() => Number)` (see [pagination-query.dto.ts](src/common/dto/pagination-query.dto.ts)).
- `TransformInterceptor` wraps every success as `{ data, meta: { timestamp } }`; `AllExceptionsFilter` shapes errors as `{ statusCode, timestamp, path, message, error }` and hides 5xx details.
- `nestjs-pino` logging: pretty in dev, JSON in prod. `LOG_LEVEL` overrides and is read straight from `process.env` in the module — the one exception to the config rule below.

Global prefix, URI versioning, helmet, CORS and Swagger are wired in [main.ts](src/main.ts), **not** in `AppModule`, so e2e specs re-apply prefix and versioning themselves.

### Two abstraction patterns govern the codebase

1. **Repository pattern via abstract-class DI tokens.** Every feature depends on an abstract `XRepository` (`UsersRepository`, `RoomsRepository`); its module binds `{ provide: XRepository, useClass: FirestoreXRepository }`. Services never touch Firestore. Adding persistence means: add the method to the abstract class, implement it in the Firestore class, extend the in-memory fake in the spec.
2. **Provider abstractions for external services.** `IdTokenVerifier` → `GoogleIdTokenVerifier` ([auth/](src/auth/)) and `LlmProvider` → `VertexLlmProvider` ([ai/](src/ai/)). Swap or fake either by changing the one `useClass` binding.

`AppConfigModule`, `FirestoreModule`, `AuthModule` and `AiModule` are all `@Global()`: `ConfigService<AppConfig, true>`, the `FIRESTORE` token, `AuthService`/`WsAuthenticator` and `LlmProvider` inject anywhere without imports.

### Auth model (Google Identity, not Firebase Auth)

The frontend does "Sign in with Google" and sends the ID token as `Authorization: Bearer <token>`. `GoogleAuthGuard` protects **every** route unless `@Public()` ([public.decorator.ts](src/common/decorators/public.decorator.ts)). `AuthService.authenticate()` runs the pipeline: verify signature and `aud === GOOGLE_OAUTH_CLIENT_ID` → require an email claim → require `email_verified` → optional `ALLOWED_AUTH_DOMAINS` allow-list → find-or-JIT-provision the user → reject `status: 'disabled'`. Identity failures are 401, policy failures are 403; anything unexpected collapses to a generic 401 with the real reason (plus a hint) logged server-side.

- A user's document id is the Google `sub`. Derive identity via `@CurrentUser()` / `@CurrentUser('uid')` — **never** from the URL or body.
- There are no roles; every authenticated user has the same access. Ownership checks (room owner) live in services.
- `AUTH_DISABLED=true` makes the guard treat every request as a fixed `dev-user` — local testing only; e2e setup forces it back to `false`.
- `GET /auth/me` echoes the resolved principal.

### Rooms realtime + the AI host

`RoomsModule` exposes REST (`RoomsController`) and a Socket.IO gateway (namespace `rooms`); `RoomsService` owns all business rules and is exported for sibling modules.

- **Socket auth is enforced on connect.** `WsAuthenticator` reads the token from `handshake.auth.token`, then the bearer header, then `?token=`; `handleConnection` pins the principal on `client.data.user` or disconnects. `joinRoom` additionally requires the uid to already be in the room's `participantIds` (join via REST first).
- Events — in: `joinRoom`, `leaveRoom`, `transcript`; out: `roomUpdated`, `presence`, `transcript`, `hostMessage`, `sessionEnded`, `error`.
- **Membership is pushed, presence is not membership.** REST `join`, `leave` and `start` call `roomsGateway.broadcastRoomUpdated(room)` so everyone already in the socket room gets the authoritative `Room` (`participantIds`, status, `scheduledEndAt`). `presence` only says a socket subscribed or unsubscribed and is not emitted on disconnect. Any new REST mutation of a room must broadcast the same way ([rooms.controller.spec.ts](src/rooms/rooms.controller.spec.ts) pins this wiring).
- **Opening topic.** `POST /rooms` takes either `topic` or `hostPicksTopic: true` (then `topic` is optional and ignored — `@ValidateIf` in the DTO). The service asks the host through `buildOpeningTopicPrompt` with an area drawn at random from `OPENING_TOPIC_AREAS` so rooms vary, stores the pick as `room.topic` with `topicPickedByHost: true`, and fails the request with 503 if the AI is unavailable; there is deliberately no canned fallback.
- **Session length.** `durationMinutes` ∈ {10, 15, 30, 45, 60} (default 30) is chosen at creation. `startRoom` accepts only a `waiting` room (409 otherwise, so the clock can never be restarted) and stamps `startedAt` / `scheduledEndAt`; the controller then arms `roomsGateway.scheduleSessionEnd(room)`, an in-process timer that calls `roomsService.expireRoom()` (ends without an owner check, `null` if already ended) and broadcasts `sessionEnded`. A manual `end` stands the timer down through `broadcastSessionEnded()`.
- **What the host produces is a `HostMessage`** ([host-message.entity.ts](src/rooms/entities/host-message.entity.ts)): `message` is the exact line it says (clients display or voice it verbatim), `topic` the new subject, `reason` why now, `trigger` = `volume | silence | manual`. It is not a suggestion; the host announces the change.
- **Two paths into the host.** `consultHost(roomId, trigger)` is the auto path: the model returns `shouldSpeak`, and `null` means it chose to stay quiet (nothing is broadcast). `forceTopicChange(roomId)` is the manual path behind `POST /rooms/:id/change-topic`; it always persists a line and the controller pushes it to the room via `roomsGateway.broadcastHostMessage()`.
- **What the host hears each turn:** the `ROOM_CONTEXT_SEGMENTS` *most recent* segments (`listRecentSegments`, newest-first query flipped back to chronological — `listSegments` returns the *first* N and is only for reads and the report) plus every line it already said, woven in as `Host (you): …`, and the list of topics already covered so it never repeats one.
- **Gateway owns the clock; policy is pure.** [facilitator-policy.ts](src/rooms/facilitator/facilitator-policy.ts) holds pure gating functions and `formatConversation`. The gateway keeps per-room `RoomState` (segment counter, silence `setTimeout`, a `consulting` flag that prevents overlapping LLM calls) **in-process** — single instance or sticky sessions only.
- Only the socket `transcript` event triggers auto-consultation; `POST /rooms/:id/transcript` persists without consulting.
- `POST /rooms/:id/end` (owner-only) generates the report best-effort — an LLM failure still ends the room — then the controller calls `roomsGateway.broadcastSessionEnded()`, which also clears that room's timers.

### LLM usage

Every prompt asks for **strict JSON** (`json: true` → `responseMimeType: application/json`) and is built and parsed by pure functions in [facilitator-prompts.ts](src/rooms/facilitator/facilitator-prompts.ts): `buildHostPrompt`/`parseHostTurn` for a host turn, `buildReportPrompt`/`parseReport` for the end report. Parsers strip code fences and throw on missing fields; `parseHostTurn` defaults `shouldSpeak` to `false` so a malformed reply never interrupts the room, and tolerates a missing `reason`. The host prompt deliberately asks for *unrelated* topics and a first-person spoken line — keep that intent if you touch the wording. `VertexLlmProvider` wraps SDK failures in a 503; every call uses `VERTEX_HOST_MODEL`.

### Firestore layout

Collection names live in [firestore.constants.ts](src/firestore/firestore.constants.ts): `users/{sub}`, `rooms/{id}` with subcollections `segments` and `hostMessages`. Document ids always equal entity ids (server-minted UUIDs or the Google `sub`). The `Firestore` instance is injected via the `FIRESTORE` symbol with `ignoreUndefinedProperties: true`. With `FIRESTORE_EMULATOR_HOST` set no credentials are needed; Vertex AI still needs ADC.

### Config

Env is validated once at startup by Joi ([validation.schema.ts](src/config/validation.schema.ts)) and exposed typed through [configuration.ts](src/config/configuration.ts). Read it as `config.get('facilitator', { infer: true })`, never `process.env`. Adding a variable means touching the Joi schema, the `AppConfig` interface and loader, and `.env.example`. Host knobs: `ROOM_SUGGEST_EVERY_SEGMENTS` (consultation cadence — the env name predates the host rename and was kept so existing `.env` files keep working), `ROOM_SILENCE_MS`, `ROOM_CONTEXT_SEGMENTS`.

### Swagger conventions

Entities and the principal are **classes with `@ApiProperty`** (not interfaces) so `@nestjs/swagger` can reflect them; object literals stay assignable. Controllers declare `@ApiBearerAuth('google')`, pair each `@ApiOperation` with `@ApiEnvelopeResponse(Model, { isArray?, created? })` ([api-envelope.ts](src/common/swagger/api-envelope.ts)) so the docs show the real envelope, and use `ErrorResponseDto` for error responses. A new `@ApiTags` name must also be added to `TAG_DESCRIPTIONS` in [swagger.ts](src/swagger.ts).

## Testing conventions

- **Unit** (`*.spec.ts` beside source, `@swc/jest`): in-memory fakes `extends XRepository`, `LlmProvider` as `{ generate: jest.fn() }`, `ConfigService` as `{ get: () => ({ ... }) }`. Services are built with `Test.createTestingModule`; the gateway, guard and auth helpers are constructed directly. The rooms service spec asserts on the prompt text sent to the fake LLM (what the host heard); the gateway spec drives the silence trigger with `jest.useFakeTimers()` and `advanceTimersByTimeAsync`.
- **e2e** (`test/*.e2e-spec.ts`): [setup-e2e.ts](test/setup-e2e.ts) seeds the env the Joi schema requires. Specs boot the real `AppModule` and override `FIRESTORE` (a stub exposing `listCollections`), `IdTokenVerifier` (a fake that treats the bearer token *as* the `sub`; `Bearer invalid` → 401) and the repositories. Use [users.e2e-spec.ts](test/users.e2e-spec.ts) as the template.
- The `src/*` path alias maps in both jest configs.

## Known constraints / next steps

- Host per-room state and session-end timers are in-process (above): a restart leaves live rooms past `scheduledEndAt` un-ended until the owner ends them, and a multi-instance deploy needs shared state (e.g. Redis).
- `maxParticipants` is capped at 5 because the planned voice transport is P2P mesh WebRTC. [docs/audio-architecture.md](docs/audio-architecture.md) lays out signaling, audio ingest and an `SttProvider` seam feeding `RoomsService.addTranscriptSegment()`; of its milestones only M0 (socket auth) exists.
- The IELTS exam simulator was removed in September 2026; the product is rooms only. Don't reintroduce exam/scoring code.

## Conventions

The vendored `.agents/skills/nestjs-best-practices` skill (pinned in `skills-lock.json`) defines rule ids that doc comments cite (`arch-use-repository-pattern`, `di-use-interfaces-tokens`, `security-use-guards`, …). Follow those patterns and cite the rule id in the doc comment when adding NestJS code. Prettier (single quotes, trailing commas) runs through `npm run lint` / `npm run format`.
