# PartyTalk API

Backend for **PartyTalk** — live group English-practice **rooms** where people talk by voice while an **AI facilitator** listens to the transcript, proactively suggests new related topics (to build versatility, resilience and creativity), and writes a report at the end. Also includes a solo **IELTS exam simulator** (Listening / Reading / Writing / Speaking), currently parked. English only.

### How a room works

1. People join a room and **talk by voice**. The frontend runs speech-to-text and streams each utterance to the backend as a **transcript segment** (Socket.IO `transcript` event, or `POST /rooms/:id/transcript`).
2. The **AI facilitator** watches the rolling transcript and **auto-suggests a new, related topic** — after every _N_ segments or after _X_ ms of silence (both configurable) — pushed to the room as a `topicSuggested` event. `POST /rooms/:id/suggest-topic` triggers one on demand.
3. On **end**, the AI produces one room-level **report** (`summary`, `highlights`, `suggestions`, `topicsExplored`), stored on the room and emitted as `sessionEnded`.

Built with **NestJS 11** on **Firestore** (Google Cloud), **Google Identity ("Sign in with Google") ID tokens** for identity, **Socket.IO** for realtime rooms, and **Vertex AI (Gemini)** for the AI host and rubric-based IELTS scoring. Developed test-first (TDD).

## Architecture

Standard NestJS feature-module layout. Cross-cutting concerns are registered globally in `AppModule`; each feature owns its controller, service, repository abstraction, DTOs and entity.

```
src/
├── main.ts                 # bootstrap: helmet, CORS, URI versioning (/api/v1), graceful shutdown
├── app.module.ts           # global guards (throttler + auth), ValidationPipe, response envelope, error filter
├── config/                 # typed config + Joi env validation (fail-fast)
├── firestore/              # firebase-admin app + FIRESTORE injection token
├── auth/                   # Google ID-token verification, account policy, HTTP guard + socket authenticator
├── ai/                     # LlmProvider abstraction + Vertex AI (Gemini) implementation
├── common/                 # exception filter, transform interceptor, @CurrentUser / @Public, DTOs
├── health/                 # liveness + Firestore readiness probes (Terminus)
├── users/                  # learner profiles (id = Google `sub`)
├── rooms/                  # group practice rooms: REST + Socket.IO gateway + AI host
└── ielts/                  # exams, attempts, auto + LLM rubric scoring
```

### Key design decisions

- **Repository pattern with DI tokens.** Every feature depends on an abstract
  `XRepository` class, not on Firestore. The Firestore implementation is bound in
  the module. This keeps services persistence-agnostic and unit-testable with
  in-memory fakes.
- **Provider abstractions for external services.** Identity (`IdTokenVerifier`) and
  the LLM (`LlmProvider`) are abstract classes bound to concrete Google / Vertex
  implementations. Swapping providers — or injecting a deterministic fake in
  tests — is a one-line change.
- **Secure by default.** A global `GoogleAuthGuard` protects every route unless
  explicitly marked `@Public()`. User-scoped endpoints derive identity from the
  verified token, never from the URL.
- **Consistent HTTP contract.** Global `ValidationPipe` (whitelist + transform),
  a response envelope (`{ data, meta }`), and a centralized exception filter.

## Prerequisites

- Node.js 22+
- A Google Cloud project with **Firestore** and **Vertex AI** enabled
- An OAuth 2.0 **Web application** client ID (the same one the frontend signs in with) for `GOOGLE_OAUTH_CLIENT_ID`
- Credentials via Application Default Credentials (`gcloud auth application-default login`) or a service-account key

## Setup

```bash
npm install
cp .env.example .env      # then fill in GCP_PROJECT_ID etc.
```

See `.env.example` for all configuration. For offline development, run
`docker compose up firestore` (emulator on host port 8200) and set
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8200`.

## Running

```bash
npm run start:dev         # watch mode
npm run start:prod        # from built dist/
```

The API listens on `PORT` (8080 in `.env.example`) and is served under `/api/v1`. Health probes: `GET /api/v1/health/live`, `GET /api/v1/health/ready`.

### Interactive API docs (Swagger / OpenAPI)

With the app running, open **`/docs`** for the Swagger UI (raw spec at **`/docs-json`**).
Every endpoint is documented with a summary, a detailed description of its rules
and side effects, request/response schemas (including the real `{ data, meta }`
envelope), and error shapes. Click **Authorize** and paste a Google ID token to
call protected endpoints from the browser.

## Testing (TDD)

```bash
npm test                  # unit tests
npm run test:cov          # with coverage
npm run test:e2e          # end-to-end (hermetic — fakes Firestore and the token verifier)
```

Unit tests mock external services (Firestore, Google token verification, Vertex AI) via the
repository / provider abstractions, so the suite runs with no cloud access.

## Authentication

The frontend signs in with Google Identity Services and sends the Google ID token
as `Authorization: Bearer <token>` (and as `auth.token` in the Socket.IO
handshake). The API verifies it with `google-auth-library`, checking that its
audience matches `GOOGLE_OAUTH_CLIENT_ID`, then applies account policy: verified
email required, optional `ALLOWED_AUTH_DOMAINS` allow-list, and disabled accounts
rejected. Users are provisioned on their first authenticated request. A user's id
is always their Google `sub`.

For local testing only, `AUTH_DISABLED=true` skips verification on HTTP routes and
treats every request as a fixed dev user. Socket connections still require a real
token.

## API surface (v1)

| Area   | Endpoint | Notes |
|--------|----------|-------|
| Auth   | `GET /auth/me` | Caller's resolved identity (provisions the user on first call) |
| Users  | `GET/PUT/DELETE /users/me` | Caller's own profile |
| Rooms  | `POST/GET /rooms`, `GET /rooms/:id`, `POST /rooms/:id/{join,leave,start,end}` | Invite-only: owner + `invitedEmails` (403 otherwise); `GET /rooms` lists only yours/invited; `end` generates the room report |
| Invites | `POST /rooms/:id/invites`, `DELETE /rooms/:id/invites/:email`, `POST/DELETE /rooms/:id/invite-link` | Owner-only. Revoking kicks the person out live (`removedFromRoom`); the invite link (`join { inviteCode }`) adds the joiner's email to the list |
| Rooms  | `GET/POST /rooms/:id/transcript`, `POST /rooms/:id/suggest-topic`, `GET /rooms/:id/suggestions` | Voice transcript + AI topic nudges |
| Rooms  | Socket.IO namespace `rooms` | in: `joinRoom`, `leaveRoom`, `transcript`; out: `presence`, `roster`, `roomUpdated`, `transcript`, `topicSuggested`, `sessionEnded`, `removedFromRoom` |
| Voice  | `GET /rooms/:id/ice-servers` | STUN + (when configured) TURN with a short-lived per-user credential; seated participants only |
| Voice  | Socket.IO namespace `rooms` | WebRTC signaling relay — in: `webrtc:join`, `webrtc:offer`, `webrtc:answer`, `webrtc:ice`; out: `webrtc:peers`, `webrtc:peer-offer`, `webrtc:peer-answer`, `webrtc:peer-ice`, `webrtc:peer-left` |
| IELTS  | `GET /ielts/exams`, `GET /ielts/exams/:id` | Browse content by section |
| IELTS  | `POST /ielts/attempts`, `GET /ielts/attempts`, `PATCH /ielts/attempts/:id/responses`, `POST /ielts/attempts/:id/score` | Auto-score L/R, LLM rubric for W/S |

## Notes & next steps

- The facilitator's per-room state (segment counters, silence timers) and voice-mesh membership are in-process,
  so the realtime layer assumes a single socket-server instance or sticky sessions;
  a multi-instance deploy would move that state into a shared store (e.g. Redis).
- The backend works from the client-produced transcript, not raw audio. Voice is a
  browser-to-browser WebRTC mesh; the gateway only relays signaling
  (`docs/audio-architecture.md`, milestone M1). Peers behind symmetric NATs connect
  through a coturn relay (`TURN_URLS`) using credentials the API mints per user from
  `TURN_SECRET`; without one, browsers get STUN only.
- Live transcript lines are broadcast before they are persisted, so listeners see
  them at socket latency rather than after a Firestore round-trip.
- IELTS is parked; its exam content is served from Firestore and seed scripts are
  not yet included.
