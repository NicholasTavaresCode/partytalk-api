# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is meant to be enough on its own: an agent working here may never see the frontend repo.

## What this is

**PartyTalk** is live group English-practice **rooms**. A host creates an invite-only room (up to 5 people), everyone talks by voice, an **AI facilitator** suggests new topics from the live transcript, and the room gets a **report** when the host ends it. This repo is the backend: **PartyTalk API**.

- The browser does speech-to-text (Web Speech API) and streams **transcript segments**. The backend never sees audio.
- Voice is a browser-to-browser WebRTC mesh; the gateway only relays signaling (see [docs/audio-architecture.md](docs/audio-architecture.md)).
- The facilitator auto-suggests a topic after N segments or X ms of silence; the host can also ask for one.
- A solo **IELTS exam simulator** exists but is **parked** (endpoints, no seed content).

Stack: NestJS 11 · Firestore (via `firebase-admin`) · Google Identity ID tokens (`google-auth-library`) · Socket.IO (+ Google Cloud Pub/Sub adapter) · Vertex AI (Gemini) · nodemailer. Developed test-first (TDD).

**Sibling repo.** The frontend is **`partytalk-web`** (Next.js 16, React 19), a separate git repo usually checked out at `../partytalk-web`. It is not a monorepo and there is no shared types package. Another agent may be working there; see [Contract with partytalk-web](#contract-with-partytalk-web) before changing anything the browser sees.

## Commands

```bash
npm run start:dev         # watch mode (dev)
npm run start:prod        # from built dist/
npm run build             # nest build
npm run lint              # eslint --fix on src/ and test/ (rewrites files; check-only: npx eslint <files>)
npm run typecheck         # tsc --noEmit against tsconfig.build.json (excludes specs)
npm test                  # unit tests (*.spec.ts, under src/)
npm run test:cov          # unit tests + coverage
npm run test:e2e          # e2e tests (*.e2e-spec.ts, under test/) — hermetic
npm test -- rooms.service # run a single unit test file by name filter
./deploy-hml.sh           # build + deploy to Cloud Run HML (see "Deploying to HML")
```

`npm run typecheck` is the gate and passes. A bare `npx tsc --noEmit` also type-checks specs and fails on three pre-existing spec typing issues (`auth.service.spec.ts`, `google-auth.guard.spec.ts`, `users.service.spec.ts`); the tests themselves pass.

Listens on `PORT` (8080 in `.env.example`; the code default is 3000, which collides with the web dev server). Served under `/api/v1`. Swagger UI at `/docs` (raw spec `/docs-json`) is the live API reference. Health: `GET /api/v1/health/live`, `GET /api/v1/health/ready`.

## Running locally

- **Firestore is the emulator, never real data.** Run `docker compose up firestore` (host port **8200**) and set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8200` in `.env`. Plain `docker compose up` also runs the API in a container against it. The API warns at boot when a non-production run uses real Firestore. [firestore.rules](firestore.rules) is wide open **for the emulator only**; never deploy it to a real project.
- Vertex AI (facilitator, reports) needs Application Default Credentials locally (`gcloud auth application-default login`). Firestore via the emulator doesn't.
- The web dev server runs on `http://localhost:3000` and calls `http://localhost:8080/api/v1` plus the Socket.IO namespace `/rooms` on `:8080`. `CORS_ORIGINS` must include `http://localhost:3000` (the default).
- Sign-in needs a Google OAuth web client: `GOOGLE_OAUTH_CLIENT_ID` here must equal the web's `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
- The user often runs their own dev servers. Reuse what's running; if you start a server, stop only the PIDs you started.

## Architecture

Standard NestJS feature-module layout under `src/` (`auth`, `users`, `rooms`, `ielts`, `ai`, `mail`, `realtime`, `firestore`, `health`, `config`, `common`). Cross-cutting concerns are registered **globally** in [app.module.ts](src/app.module.ts) so every feature inherits them. Do not re-register them per feature:

- **Rate limiting** then **auth** (order matters): `ThrottlerGuard` → `GoogleAuthGuard` as `APP_GUARD`.
- **ValidationPipe** (`whitelist`, `forbidNonWhitelisted`, `transform`) as `APP_PIPE`.
- **Response envelope** `{ data, meta }` via `TransformInterceptor` (`APP_INTERCEPTOR`).
- **Centralized errors** via `AllExceptionsFilter` (`APP_FILTER`).
- Structured logging via `nestjs-pino` (`authorization` header redacted).

Bootstrap ([main.ts](src/main.ts)): helmet, CORS from config, URI versioning (`/api` prefix, default v1), `trust proxy` from `TRUST_PROXY_HOPS`, the `PubSubIoAdapter`, graceful shutdown hooks. Boot logs summarize realtime, Firestore database and voice ICE config.

### Two abstraction patterns that govern the whole codebase

1. **Repository pattern with DI tokens.** Every feature depends on an abstract `XRepository` class, never on Firestore directly. The module binds it via `{ provide: XRepository, useClass: FirestoreXRepository }`. Services stay persistence-agnostic and unit-testable with in-memory fakes. When adding persistence, add the method to the abstract class first, then implement it in the Firestore class.

2. **Provider abstractions for external services.** Each external service is an abstract class bound once:
   - identity: `IdTokenVerifier` ([auth/id-token-verifier.ts](src/auth/id-token-verifier.ts)) → `GoogleIdTokenVerifier`;
   - LLM: `LlmProvider` ([ai/llm-provider.ts](src/ai/llm-provider.ts)) → the Vertex implementation;
   - email: `Mailer` ([mail/mailer.ts](src/mail/mailer.ts)) → `SmtpMailer`.

   `AuthModule`, `AiModule`, `MailModule`, `FirestoreModule` and `AppConfigModule` are `@Global()`, so their providers and `ConfigService<AppConfig>` inject anywhere without re-importing. To swap a provider or inject a fake, change the one `useClass` binding.

### Auth model

Identity is a Google Identity Services ("Sign in with Google") ID token — **not** Firebase Auth. Secure by default: `GoogleAuthGuard` protects **every** route. Opt a route out with `@Public()` ([common/decorators/public.decorator.ts](src/common/decorators/public.decorator.ts)). The guard only extracts `Authorization: Bearer`; [AuthService](src/auth/auth.service.ts) owns the policy pipeline:

1. Verify the token; its audience must equal `GOOGLE_OAUTH_CLIENT_ID`.
2. Require a verified email.
3. Apply the optional `ALLOWED_AUTH_EMAILS` / `ALLOWED_AUTH_DOMAINS` allow-lists. Either match passes; both empty means open sign-up. HML sets the emails to its testers.
4. Find the user, or JIT-provision a record on the first authenticated request.
5. Reject `disabled` accounts.

Identity failures are 401, policy failures 403; unexpected errors collapse to 401 with a diagnostic hint (e.g. the token's `aud`) logged server-side only. There are no roles. User-scoped endpoints derive identity via `@CurrentUser()` — **never** from the URL. A user's document id is always their Google `sub`. `GET /auth/me` echoes the resolved principal; the profile is filled in later via `PUT /users/me` (the web's onboarding treats `GET /users/me` 404 as "no profile yet").

Sockets reuse the same `AuthService` through [WsAuthenticator](src/auth/ws-authenticator.ts). The token comes from `handshake.auth.token`, else the `Authorization` header, else `?token=`.

- The gateway authenticates in **Socket.IO middleware** (`afterInit` → `server.use` → `authenticateSocket`). A refused handshake, typically an expired ID token on reconnect, reaches the client as `connect_error` *before* any `connect`, and the web client retries with a fresh token.
- Handlers trust `client.data.user`, never a client-supplied uid.
- Don't move auth back into `handleConnection`: connect-then-kick is indistinguishable from a real disconnect on the client.

`AUTH_DISABLED=true` (local testing only) makes the HTTP guard skip verification and treat every request as a fixed `dev-user`. It does **not** apply to sockets — `WsAuthenticator` still requires a real token. It must be `false` anywhere shared (the HML deploy forces it).

### Room access (invite-only)

Being signed in is not enough to touch a room. The single rule is `canAccessRoom` in [rooms/room-access.ts](src/rooms/room-access.ts): the **owner**, or a caller whose Google-verified email is in `room.invitedEmails` (lowercased). Rooms without the field (pre-invite data) are owner-only. Don't add checks elsewhere — route new room operations through the service helpers:

- **Service helpers:**
  - `accessibleRoom` (owner or invitee, else 403) guards reads.
  - `participantRoom` (must also have joined) guards writes that cost or mutate: the REST transcript and ICE servers.
  - `assertOwner` guards lifecycle (start/end), invite management and the manual `suggest-topic`. Only the host steers: the controller broadcasts the result as `topicSuggested` via `RoomsGateway.announceSuggestion`, which also restarts the auto-triggers. An ended room returns 409.
- **Filtered views:** `viewFor` strips `invitedEmails` and `inviteCode` from every room returned to a non-owner. `getRoom` is the unfiltered lookup, for trusted server code only (the gateway).
- **Listing:** `GET /rooms` lists only rooms you own or are invited to. `listOpenForMember` runs two single-field Firestore queries merged in memory, so no composite index is needed.
- **Joining:** `POST :id/join` returns 409 when the room is full (`maxParticipants`, 1–5) or ended. It is idempotent for someone already seated.
- **Invite link:** `inviteCode` (128-bit, compared in constant time) is minted or rotated by `POST :id/invite-link` and nulled by `DELETE`. `POST :id/join { inviteCode }` admits a non-invitee **and appends their email to `invitedEmails`**, so link joiners are durable, visible and revocable like any invitee.
- **Revoke** (`DELETE :id/invites/:email`):
  1. The service drops the email and resolves participant uids to emails via `UsersRepository`, to free that person's seat.
  2. The controller then calls `RoomsGateway.evictFromRoom`, which makes their sockets leave the room and the voice mesh and sends them `removedFromRoom`.
  3. The gateway's `joinRoom`/`webrtc:join` re-check `canAccessRoom`, so a revoked user can't re-enter on reconnect.
- **Invitation emails:** `RoomInvitations` ([rooms/room-invitations.ts](src/rooms/room-invitations.ts)) sends them through `Mailer`.
  - **When:** on create, and on add (only addresses that weren't on the list). Never on link joins.
  - **Delivery:** fire-and-forget; a send failure is logged and never fails the invite.
  - **Content:** the host's name, the topic, and a link to `${WEB_APP_URL}/practice/{roomId}`.
  - **Off switch:** without `SMTP_USER`/`SMTP_PASSWORD`, `SmtpMailer` is disabled and only logs.

### Rooms realtime

`RoomsModule` wires both a REST `RoomsController` and a Socket.IO `RoomsGateway` (namespace `rooms`), and exports `RoomsService` so siblings reuse room logic without depending on the transport. Socket events — in: `joinRoom`, `leaveRoom`, `transcript`, `webrtc:*`; out: `presence`, `roster`, `roomUpdated`, `transcript`, `topicSuggested`, `sessionEnded`, `removedFromRoom`, `error`, `webrtc:*`.

**Keeping every client's room current.** The participant list and status live in the REST room.

- After any REST change others must see (join, leave, start, revoke), the controller calls `RoomsGateway.notifyRoomUpdated`. It emits a **data-free** `roomUpdated`, and each client refetches `GET /rooms/:id`.
- Never broadcast the room itself: views are filtered per caller, and the owner's carries the invite list and link code.
- On `joinRoom` the newcomer gets `roster` (everyone connected now, one entry per uid), because `presence` only reports later arrivals.
- `presence: left` is announced only when a person's **last** socket leaves the room, including on disconnect. `client.data.rooms` / `client.data.voice` track membership because Socket.IO empties `socket.rooms` before `handleDisconnect` runs.

**Keep the transcript hot path free of I/O before the broadcast.** In order:

1. `transcript` is authorized by `client.rooms.has(roomId)`. Sockets only enter a room after `joinRoom`'s participant check, so this needs no Firestore read.
2. The segment is built with `buildTranscriptSegment` and broadcast.
3. Only *then* is it persisted with `saveTranscriptSegment`. The write must still finish before the facilitator triggers run, since they read history from the repository.

The REST `POST /rooms/:id/transcript` path uses `addTranscriptSegment` (existence check + write). Never put Firestore reads/writes between receiving a realtime event and emitting it.

**Multiple instances.** Cloud Run can run two API instances at once even at `--max-instances 1`: it starts a replacement while the old one still holds open WebSockets. (This split a live room in HML: the host's socket stayed on the old instance and never heard the invitee.) So Socket.IO uses the Google Cloud Pub/Sub adapter ([realtime/pubsub-io.adapter.ts](src/realtime/pubsub-io.adapter.ts), enabled by `SOCKET_IO_PUBSUB_TOPIC`; each instance creates its own subscription).

- Room membership lives **only in Socket.IO rooms**, which the adapter shares across instances, so `server.to(...).emit`, `fetchSockets` and `socketsLeave` reach every instance. **Never keep membership in a local `Map`.**
- Cross-instance `fetchSockets` goes through `socketsIn`, which falls back to `server.local` if another instance doesn't answer.
- If the topic is missing or the service account lacks `roles/pubsub.editor`, the adapter logs an actionable ERROR and the API keeps serving, but only on one instance.
- Without a topic (local dev, tests), Socket.IO keeps its in-memory adapter.

**Voice signaling** (M1 of [docs/audio-architecture.md](docs/audio-architecture.md)):
- **Client→server:** `webrtc:join` (participant-checked), and `webrtc:offer|answer|ice { roomId, toUid, … }`.
- **Server→client:** `webrtc:peers { uids }` to the joiner, `webrtc:peer-offer|peer-answer|peer-ice { fromUid, … }` to the target only, and `webrtc:peer-left { uid }` when someone's last voice socket leaves.
- **Membership:** a voice member is in two Socket.IO rooms, `voice:{roomId}` (the mesh) and `voice:{roomId}:{uid}` (their seat). A newer tab or reconnect takes the seat over through `socketsLeave`.
- **Relaying:** a relay emits to the target's seat on any instance. It checks only the sender's own rooms and stamps `fromUid` from the socket.
- **Joining:** `webrtc:join` joins *before* listing peers. When the host starts, everyone joins at once and two joiners can offer each other; the client breaks that glare (the lower uid keeps its offer).

**ICE servers** come from `GET /rooms/:id/ice-servers` (seated participants only): STUN, plus a TURN relay when `TURN_URLS` **and** `TURN_SECRET` are set.

- **Credential:** minted per user by [rooms/ice-servers.ts](src/rooms/ice-servers.ts) in coturn's `use-auth-secret` scheme: `username = "<expiry>:<uid>"`, `credential = base64(HMAC-SHA1(secret, username))`, TTL `TURN_CREDENTIAL_TTL_SECONDS`.
- **Storage:** nothing is stored; the relay verifies with the shared secret.

**Facilitator.**
- `listSegments` / `listSuggestions` return the **most recent** `limit` items, oldest first. The prompt is a rolling window of the latest `ROOM_CONTEXT_SEGMENTS` lines.
- Trigger logic lives in [rooms/facilitator/facilitator-policy.ts](src/rooms/facilitator/facilitator-policy.ts) as **pure functions** (no timers/IO), and prompts in `facilitator-prompts.ts`. The gateway owns the clock and the per-room `RoomState` (counters, silence timer, in-flight guard).
- Keep decision logic pure and testable; keep timing and state in the gateway.
- The report is generated best-effort on `POST :id/end`: if the LLM fails, the room still ends without a report.

### REST surface (all under `/api/v1`, all authenticated unless noted)

| Route | Who |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | public |
| `GET /auth/me` | any signed-in user |
| `GET /users/me` (404 = no profile), `PUT /users/me`, `DELETE /users/me` | self |
| `POST /rooms`, `GET /rooms` (own + invited) | any signed-in user |
| `GET /rooms/:id`, `GET :id/transcript`, `GET :id/suggestions` | owner or invitee |
| `POST :id/join { inviteCode? }`, `POST :id/leave` | owner or invitee (join also admits a valid link holder) |
| `POST :id/transcript`, `GET :id/ice-servers` | seated participant |
| `POST :id/start`, `POST :id/end`, `POST :id/suggest-topic` | owner |
| `POST :id/invites { emails }`, `DELETE :id/invites/:email`, `POST/DELETE :id/invite-link` | owner |
| `/ielts/*` (exams, attempts, responses, score) | parked |

Limits: topic 3–120 chars, persona ≤ 300, `maxParticipants` 1–5 (default 5, capped by the P2P mesh), up to `MAX_INVITES` = 50 invites, transcript segment ≤ 2000 chars.

### Config

Env is loaded and validated once at startup (fail-fast) via Joi in [config/validation.schema.ts](src/config/validation.schema.ts). Access typed config through `ConfigService<AppConfig>` ([config/configuration.ts](src/config/configuration.ts)), not `process.env`. See `.env.example` for every variable. Notable ones:

- `FIRESTORE_DATABASE_ID` picks the database (empty = `(default)`; HML uses the named database `partytalk` in `nam5`). `FIRESTORE_EMULATOR_HOST` points at the emulator.
- `TRUST_PROXY_HOPS` (0 locally, 1 on Cloud Run) makes `req.ip` — the ThrottlerGuard's key — the real client instead of the proxy. Without it every user shares one rate-limit budget.
- `SOCKET_IO_PUBSUB_TOPIC` enables cross-instance realtime (empty locally).
- `SMTP_HOST`/`SMTP_PORT` (Gmail, 465), `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` and `WEB_APP_URL` configure invitation emails.
- `ROOM_SUGGEST_EVERY_SEGMENTS`, `ROOM_SILENCE_MS` and `ROOM_CONTEXT_SEGMENTS` are the facilitator cadence, which bounds Gemini spend per room. `VERTEX_LOCATION` and `VERTEX_*_MODEL` pick the models.
- `TURN_URLS`, `TURN_SECRET` and `TURN_CREDENTIAL_TTL_SECONDS` configure the optional voice relay.

In production, logs carry Cloud Logging's `severity` and `message` fields (set in `app.module.ts`).

## Contract with partytalk-web

Nothing enforces this contract: the web keeps a hand-written mirror of it. A change here that the browser sees needs a matching change in `partytalk-web`. Unless the user asks you to edit that repo, finish your change here and end your report with the exact contract change: the route or event, the field, the type and the status codes. The web agent can then mirror it.

- **REST envelope.** Every response is `{ data, meta }`. The web's `apiClient.ts` unwraps `data` and throws `ApiError` carrying the HTTP status, so **status codes are part of the contract**:
  - 401 sends the user back to sign-in;
  - 403 or 404 on a room renders the "not invited" or "not found" screens;
  - 404 on `GET /users/me` starts profile onboarding;
  - 409 means the room is full or has ended.
- **Shapes.** The web's `src/lib/types.ts` mirrors `src/*/entities/*.entity.ts` and `src/*/dto/*.dto.ts`.
  - **Requests:** because of `forbidNonWhitelisted`, any field the web sends that a DTO lacks is a 400.
  - **Responses:** a new response field is invisible until `types.ts` adds it, and a rename or removal breaks the web.
  - **Mirrored limits:** the web copies `MAX_INVITES` (`src/lib/invites.ts`), `maxParticipants` 1–5 and the topic 3–120 chars into its UI.
- **Socket.IO** namespace `rooms`. Event names and payloads must match the web's `ClientToServerEvents` / `ServerToClientEvents`:
  - **Client→server:** `joinRoom { roomId }`, `leaveRoom { roomId }`, `transcript { roomId, text }`, `webrtc:join { roomId }`, `webrtc:offer|answer { roomId, toUid, sdp }`, `webrtc:ice { roomId, toUid, candidate }`.
  - **Server→client:** `presence`, `roster { roomId, members: {uid, name?}[] }`, `roomUpdated { roomId }` (data-free), `transcript`, `topicSuggested`, `sessionEnded { roomId, report? }`, `removedFromRoom { roomId }`, `error { message }`, `webrtc:peers { uids }`, `webrtc:peer-offer|peer-answer { fromUid, sdp }`, `webrtc:peer-ice { fromUid, candidate }`, `webrtc:peer-left { uid }`.
- **Auth.** The web gets the GIS credential JWT and sends it as `Authorization: Bearer` on REST, and as `auth.token` in the socket handshake. It uses an `auth` callback, so every reconnect carries a fresh token.
- **What the web does that this API relies on:**
  - It emits `joinRoom` only after its REST join succeeded **and** the socket is connected, and re-emits on reconnect.
  - On every reconnect it refetches the room and the suggestions, because a reconnect may land on another instance after events were missed.
  - It never displays the transcript; transcript only feeds the facilitator and the report, and the web ignores `transcript` broadcasts.
  - It shows "Suggest a topic" to the owner only.
  - It breaks WebRTC offer glare (the lower uid keeps its offer) and rebuilds the whole mesh on reconnect.
  - Both of its exits call `POST /leave` (closing the tab doesn't), and it renders `removedFromRoom` as an access screen.

## Deploying to HML

HML is the GCP project **`partytalk-hml`** (number 484961620847, region `us-central1`), used for testing with selected users. Both URLs are deterministic: the API is `https://partytalk-api-484961620847.us-central1.run.app` and the web `https://partytalk-web-484961620847.us-central1.run.app`.

**Running a deploy.** `./deploy-hml.sh` takes 3–6 minutes. It enables the required APIs and checks the prerequisites before building:
- the Firestore database **`partytalk`** (Native, `nam5`) must exist, or the script exits;
- the service account's roles must all be granted, or it exits and prints the grant commands;
- the Pub/Sub topic `partytalk-realtime` is created if missing.

The build itself is `gcloud run deploy --source` with the Dockerfile.

**Settings.**
- **Service account:** one account, `partytalk-api-hml@partytalk-hml.iam.gserviceaccount.com`, builds and runs both this API and the web. It needs `datastore.user`, `aiplatform.user`, `logging.logWriter`, `storage.objectUser`, `artifactregistry.writer` and `pubsub.editor`.
- **Cloud Run flags:** `--min-instances 1 --max-instances 1` (the facilitator's timers are per instance) and `--timeout 3600` (a WebSocket is one request), plus `--session-affinity`, `--concurrency 200` and `--cpu-boost`.
- **Env:** the deploy sets `AUTH_DISABLED=false`, `TRUST_PROXY_HOPS=1`, `FIRESTORE_DATABASE_ID=partytalk` and Gemini `gemini-3.5-flash-lite` on `global`.
- **Testers:** only the Google accounts in the script's `ALLOWED_AUTH_EMAILS` can use HML; everyone else gets 403. A new tester must also be added to the OAuth client's test users. Redeploy after editing the list.
- **Email:** on when `MAIL_SENDER` is set in the script and a Gmail App Password exists in Secret Manager as `PARTYTALK_SMTP_PASSWORD`, readable by the service account.
- **TURN relay:** wired automatically when a `partytalk-turn` static address and the `PARTYTALK_TURN_SECRET` secret exist. All secrets go in one `--set-secrets` flag.
- **First deploy:** run this API before the web, because its `--source` build creates the `cloud-run-source-deploy` image repository the web pushes to.

**Rules.**
- Deploying, and any `gcloud` command that changes IAM, secrets or data in `partytalk-hml`, affects a shared environment. Run them only when the user asks. Otherwise hand the user the exact commands.
- Secrets (SMTP App Password, TURN secret) live only in Secret Manager, never in the repo or the script.
- Never deploy `firestore.rules` to HML.

## Testing conventions

Unit tests (`*.spec.ts` beside source) mock external services through the repository/provider abstractions, so **no cloud access is needed**. [rooms.gateway.spec.ts](src/rooms/rooms.gateway.spec.ts) uses a fake server that models Socket.IO room membership; extend it rather than mocking emits ad hoc.

e2e tests (`test/*.e2e-spec.ts`) are hermetic: they override `FIRESTORE`, `IdTokenVerifier` and repositories with fakes, and [test/setup-e2e.ts](test/setup-e2e.ts) forces `AUTH_DISABLED=false` so the real auth path is exercised. Both use `@swc/jest`. The `src/*` path alias maps in both jest configs.

The cross-instance realtime path was verified by hand: two Nest instances against the official Pub/Sub emulator Docker image. Re-verify that way after changing the gateway or the adapter.

## Known constraints / next steps

- The facilitator's per-room counters and silence timers are still **per instance**. While Cloud Run overlaps two instances, a nudge may come late or twice. HML runs one min/max instance to keep that rare.
- Gmail SMTP caps at about 500 emails per day, and a new sender's first emails may land in spam.
- IELTS is parked: exam content would come from Firestore, and no seed scripts exist yet. The web serves IELTS from in-repo mocks; don't wire the two together unless asked.

## Conventions

- An `.agents/skills/nestjs-best-practices` skill is vendored (see `skills-lock.json`). Code comments reference its rule ids (e.g. `arch-use-repository-pattern`, `security-use-guards`); follow those patterns when adding NestJS code.
- Keep Swagger decorators (`@ApiOperation`, `@ApiEnvelopeResponse`, error responses) accurate on every route you add or change. Swagger is the live spec the web side reads.
- Work on the local checkout as it is: don't pull, and don't ask to pull. Commit or push only when the user asks.
