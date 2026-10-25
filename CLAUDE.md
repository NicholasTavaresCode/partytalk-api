# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PartyTalk API — backend for live group English-practice **rooms**. People talk by voice; the frontend does speech-to-text and streams **transcript segments** to the backend. An **AI facilitator** watches the rolling transcript and auto-suggests related topics (after N segments or X ms of silence), then writes a room **report** on end. Also ships a solo **IELTS exam simulator** (currently parked). The backend works from client-produced transcript, never raw audio; voice is a browser-to-browser WebRTC mesh for which the gateway only relays signaling (see [docs/audio-architecture.md](docs/audio-architecture.md)).

Stack: NestJS 11 · Firestore (via `firebase-admin`) · Google Identity ID tokens (`google-auth-library`) · Socket.IO · Vertex AI (Gemini). Developed test-first (TDD).

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
./deploy-hml.sh           # enable APIs, check Firestore, build (Cloud Build) + deploy to Cloud Run HML; prerequisites in its header
```

Listens on `PORT` (8080 in `.env.example`; the code default is 3000, which collides with the web dev server). Served under `/api/v1`. Swagger UI at `/docs` (raw spec `/docs-json`). Health: `GET /api/v1/health/live`, `GET /api/v1/health/ready`.

## Architecture

Standard NestJS feature-module layout under `src/`. Cross-cutting concerns are registered **globally** in [app.module.ts](src/app.module.ts) so every feature inherits them — do not re-register per feature:

- **Rate limiting** then **auth** (order matters): `ThrottlerGuard` → `GoogleAuthGuard` as `APP_GUARD`.
- **ValidationPipe** (`whitelist`, `forbidNonWhitelisted`, `transform`) as `APP_PIPE`.
- **Response envelope** `{ data, meta }` via `TransformInterceptor` (`APP_INTERCEPTOR`).
- **Centralized errors** via `AllExceptionsFilter` (`APP_FILTER`).
- Structured logging via `nestjs-pino` (`authorization` header redacted).

Bootstrap ([main.ts](src/main.ts)): helmet, CORS from config, URI versioning (`/api` prefix, default v1), graceful shutdown hooks.

### Two abstraction patterns that govern the whole codebase

1. **Repository pattern with DI tokens.** Every feature depends on an abstract `XRepository` class, never on Firestore directly. The module binds it via `{ provide: XRepository, useClass: FirestoreXRepository }`. Services stay persistence-agnostic and unit-testable with in-memory fakes. When adding persistence, add the method to the abstract class first, then implement it in the Firestore class.

2. **Provider abstractions for external services.** Identity (`IdTokenVerifier` in [auth/id-token-verifier.ts](src/auth/id-token-verifier.ts), bound to `GoogleIdTokenVerifier`) and LLM (`LlmProvider` in [ai/llm-provider.ts](src/ai/llm-provider.ts), bound to the Vertex implementation) are abstract classes. `AuthModule`, `AiModule` and `AppConfigModule` are `@Global()`, so `AuthService`, `LlmProvider` and `ConfigService<AppConfig>` inject anywhere without re-importing. To swap a provider or inject a fake, change the one `useClass` binding.

### Auth model

Identity is a Google Identity Services ("Sign in with Google") ID token — **not** Firebase Auth. Secure by default: `GoogleAuthGuard` protects **every** route. Opt a route out with `@Public()` ([common/decorators/public.decorator.ts](src/common/decorators/public.decorator.ts)). The guard only extracts `Authorization: Bearer`; [AuthService](src/auth/auth.service.ts) owns the policy pipeline: verify the token (audience must equal `GOOGLE_OAUTH_CLIENT_ID`) → require a verified email → optional `ALLOWED_AUTH_EMAILS` / `ALLOWED_AUTH_DOMAINS` allow-lists (either match passes; both empty = open sign-up; HML sets the emails to its testers) → find-or-JIT-provision the user → reject `disabled` accounts. Identity failures are 401, policy failures 403; unexpected errors collapse to 401 with a diagnostic hint logged server-side only. There are no roles. User-scoped endpoints derive identity via `@CurrentUser()` — **never** from the URL. A user's document id is always their Google `sub`. `GET /auth/me` echoes the resolved principal.

Sockets reuse the same `AuthService` through [WsAuthenticator](src/auth/ws-authenticator.ts) (token from `handshake.auth.token`, else the `Authorization` header, else `?token=`). The gateway authenticates in **Socket.IO middleware** (`afterInit` → `server.use` → `authenticateSocket`), so a refused handshake — typically an expired ID token on reconnect — reaches the client as `connect_error` *before* any `connect`, and the web client retries with a fresh token. Handlers trust `client.data.user`, never a client-supplied uid. Don't move auth back into `handleConnection`: connect-then-kick is indistinguishable from a real disconnect on the client.

`AUTH_DISABLED=true` (local testing only) makes the HTTP guard skip verification and treat every request as a fixed `dev-user`. It does **not** apply to sockets — `WsAuthenticator` still requires a real token.

### Room access (invite-only)

Being signed in is not enough to touch a room. The single rule is `canAccessRoom` in [rooms/room-access.ts](src/rooms/room-access.ts): the **owner**, or a caller whose Google-verified email is in `room.invitedEmails` (lowercased). Rooms without the field (pre-invite data) are owner-only. Don't add checks elsewhere — route new room operations through the service helpers:

- `accessibleRoom` (owner/invitee, else 403) for reads; `participantRoom` (also must have joined) for writes that cost or mutate — REST transcript, manual `suggest-topic`; `assertOwner` for lifecycle and invite management.
- `viewFor` strips `invitedEmails` and `inviteCode` from every room returned to a non-owner. `getRoom` is the unfiltered lookup for trusted server code only (the gateway).
- `GET /rooms` lists only rooms you own or are invited to (`listOpenForMember`: two single-field Firestore queries merged in memory, so no composite index).
- **Invite link:** `inviteCode` (128-bit, compared in constant time) is minted/rotated by `POST :id/invite-link` and nulled by `DELETE`. `POST :id/join { inviteCode }` admits a non-invitee **and appends their email to `invitedEmails`**, so link joiners are durable, visible and revocable like any invitee.
- **Revoke** (`DELETE :id/invites/:email`) drops the email, resolves participant uids → emails via `UsersRepository` to free the seat, then the controller calls `RoomsGateway.evictFromRoom`, which makes their sockets leave the room and voice mesh and sends them `removedFromRoom`. The gateway's `joinRoom`/`webrtc:join` re-check `canAccessRoom`, so a revoked user can't re-enter on reconnect.

### Rooms realtime

`RoomsModule` wires both a REST `RoomsController` and a Socket.IO `RoomsGateway` (namespace `rooms`), and exports `RoomsService` so siblings reuse room logic without depending on the transport. Socket events — in: `joinRoom`, `leaveRoom`, `transcript`; out: `presence`, `transcript`, `topicSuggested`, `sessionEnded`, `removedFromRoom`, `error`.

**Keep the transcript hot path free of I/O before the broadcast.** `transcript` is authorized by `client.rooms.has(roomId)` (sockets only enter a room after `joinRoom`'s participant check), built with `buildTranscriptSegment`, broadcast, and only *then* persisted with `saveTranscriptSegment` — the write must still finish before the facilitator triggers run, since they read history from the repository. The REST `POST /rooms/:id/transcript` path uses `addTranscriptSegment` (existence check + write).

**Voice signaling** (M1 of [docs/audio-architecture.md](docs/audio-architecture.md)): in `webrtc:join` (participant-checked; replies `webrtc:peers { uids }` with members already in the mesh — the joiner offers to each, so no glare), `webrtc:offer|answer|ice { roomId, toUid, … }`; out `webrtc:peer-offer|peer-answer|peer-ice { fromUid, … }` to the target socket only, and `webrtc:peer-left { uid }` to the room on leave/disconnect. Relays check in-memory membership only and stamp `fromUid` from the socket.

**ICE servers** come from `GET /rooms/:id/ice-servers` (seated participants only): STUN, plus a TURN relay when `TURN_URLS` **and** `TURN_SECRET` are set, with a per-user credential minted by [rooms/ice-servers.ts](src/rooms/ice-servers.ts) in coturn's `use-auth-secret` scheme (`username = "<expiry>:<uid>"`, `credential = base64(HMAC-SHA1(secret, username))`, TTL `TURN_CREDENTIAL_TTL_SECONDS`). Nothing is stored; the relay verifies with the shared secret. In HML, `deploy-hml.sh` wires a relay automatically when a `partytalk-turn` static address exists (the secret comes from Secret Manager `PARTYTALK_TURN_SECRET`).

`listSegments` / `listSuggestions` return the **most recent** `limit` items, oldest first — the facilitator's prompt is a rolling window of the latest `ROOM_CONTEXT_SEGMENTS` lines.

Facilitator trigger logic lives in [rooms/facilitator/facilitator-policy.ts](src/rooms/facilitator/facilitator-policy.ts) as **pure functions** (no timers/IO) — the gateway owns the clock and calls them. Keep decision logic pure and testable; keep timing/state in the gateway.

### Config

Env is loaded and validated once at startup (fail-fast) via Joi in [config/validation.schema.ts](src/config/validation.schema.ts). Access typed config through `ConfigService<AppConfig>` ([config/configuration.ts](src/config/configuration.ts)), not `process.env`. See `.env.example`. `FIRESTORE_DATABASE_ID` picks the database (empty = `(default)`; HML uses the named database `partytalk` in `nam5`); point `FIRESTORE_EMULATOR_HOST` at the local emulator for dev (the API warns at boot when a non-production run uses real Firestore). `TRUST_PROXY_HOPS` (0 locally, 1 on Cloud Run) makes `req.ip` — the ThrottlerGuard's key — the real client instead of the proxy; without it every user shares one rate-limit budget. In production, logs carry Cloud Logging's `severity` and `message` fields (set in `app.module.ts`).

## Testing conventions

Unit tests (`*.spec.ts` beside source) mock external services through the repository/provider abstractions — **no cloud access needed**. e2e tests (`test/*.e2e-spec.ts`) are hermetic: they override `FIRESTORE`, `IdTokenVerifier` and repositories with fakes, and [test/setup-e2e.ts](test/setup-e2e.ts) forces `AUTH_DISABLED=false` so the real auth path is exercised. Both use `@swc/jest`. The `src/*` path alias maps in both jest configs.

## Known constraints / next steps

- Facilitator per-room state (segment counters, silence timers) and voice-mesh membership are **in-process** — assumes a single socket-server instance or sticky sessions. Multi-instance deploy needs shared state (e.g. Redis).
- IELTS is parked; exam content is served from Firestore, seed scripts not yet included.

## Conventions

An `.agents/skills/nestjs-best-practices` skill is vendored (see `skills-lock.json`); code comments reference its rule ids (e.g. `arch-use-repository-pattern`, `security-use-guards`). Follow those patterns when adding NestJS code.
