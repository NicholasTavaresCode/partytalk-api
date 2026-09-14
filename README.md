# PartyTalk API

Backend for **PartyTalk** — live group English-practice **rooms** where people talk by voice while an **AI host** sits in the room. The host keeps listening to the transcript and, whenever it judges the current topic has been talked about enough, speaks up to move the group onto a **completely different topic** — *"Ok. Now let's talk about the Usain Bolt record."* The point is friction: adapting on the spot to unrelated subjects is how participants build versatility in English. When the room ends, the host writes a short report for the group. English only.

### How a room works

1. Someone creates a room with an opening topic — typed in, or picked by the AI host on request — and a **session length** (10, 15, 30, 45 or 60 minutes). Once the owner starts it, people **talk by voice**. The frontend runs speech-to-text and streams each utterance to the backend as a **transcript segment** (Socket.IO `transcript` event, or `POST /rooms/:id/transcript`).
2. The **AI host** is consulted every _N_ segments or after _X_ ms of silence (both configurable). It listens to the most recent window of the conversation — including its own earlier lines — and decides **on its own** whether to step in. When it does, it says a short line in its own voice announcing a new, unrelated topic (*"All right. Let's talk about the incredible movie Titanic."*); that line is stored and pushed to the room as a `hostMessage` event. `POST /rooms/:id/change-topic` forces one on demand.
3. The session ends by itself when the clock runs out (or earlier, if the owner ends it). The host then produces one room-level **report** (`summary`, `highlights`, `suggestions`, `topicsExplored`) that also covers how well the group adapted to each topic change — stored on the room and emitted as `sessionEnded`.

Built with **NestJS 11** on **Firestore** (Google Cloud), **Google Identity** ("Sign in with Google") ID tokens for identity, **Socket.IO** for realtime rooms, and **Vertex AI (Gemini)** for the host. Developed test-first (TDD).

## Architecture

Standard NestJS feature-module layout. Cross-cutting concerns are registered globally in `AppModule`; each feature owns its controller, service, repository abstraction, DTOs and entities.

```
src/
├── main.ts                 # bootstrap: helmet, CORS, URI versioning (/api/v1), graceful shutdown
├── app.module.ts           # global guards (throttler + auth), ValidationPipe, response envelope, error filter
├── config/                 # typed config + Joi env validation (fail-fast)
├── firestore/              # firebase-admin app + FIRESTORE injection token
├── auth/                   # Google ID-token verification, secure-by-default guard, socket authenticator
├── ai/                     # LlmProvider abstraction + Vertex AI (Gemini) implementation
├── common/                 # exception filter, transform interceptor, @CurrentUser / @Public, DTOs
├── health/                 # liveness + Firestore readiness probes (Terminus)
├── users/                  # learner profiles (id = Google account sub)
└── rooms/                  # practice rooms: REST + Socket.IO gateway + the AI host (facilitator/)
```

### Key design decisions

- **Repository pattern with DI tokens.** Every feature depends on an abstract
  `XRepository` class, not on Firestore. The Firestore implementation is bound in
  the module. This keeps services persistence-agnostic and unit-testable with
  in-memory fakes.
- **Provider abstractions for external services.** Identity (`IdTokenVerifier`)
  and the LLM (`LlmProvider`) are abstract classes bound to concrete Google /
  Vertex implementations. Swapping providers — or injecting a deterministic fake
  in tests — is a one-line change.
- **Secure by default.** A global `GoogleAuthGuard` protects every route unless
  explicitly marked `@Public()`. User-scoped endpoints derive identity from the
  verified token, never from the URL. Sockets are authenticated on connect.
- **The host decides, the gateway keeps time.** Pure gating functions say *when*
  to consult the host (every _N_ segments, or after silence); the model itself
  decides *whether* to speak and *what* to say. Prompts and parsers are pure
  functions that ask for strict JSON.
- **Consistent HTTP contract.** Global `ValidationPipe` (whitelist + transform),
  a response envelope (`{ data, meta }`), and a centralized exception filter.

## Prerequisites

- Node.js 22+
- A Google Cloud project with **Firestore** and **Vertex AI** enabled, plus an
  OAuth 2.0 Web client id for "Sign in with Google"
- Credentials via Application Default Credentials (`gcloud auth application-default login`) or a service-account key

## Setup

```bash
npm install
cp .env.example .env      # then fill in GCP_PROJECT_ID, GOOGLE_OAUTH_CLIENT_ID, etc.
```

See `.env.example` for all configuration. Point `FIRESTORE_EMULATOR_HOST` at the
local emulator for offline development, or run `docker compose up -d --build` to
get the emulator plus the API container (the image bakes in the source, so
rebuild with `--build` after every code change).

## Running

```bash
npm run start:dev         # watch mode
npm run start:prod        # from built dist/
```

The API is served under `/api/v1`. Health probes: `GET /api/v1/health/live`, `GET /api/v1/health/ready`.

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
npm run test:e2e          # end-to-end (hermetic — fakes Google Identity/Firestore)
```

Unit tests mock external services (Firestore, Google Identity, Vertex AI) via the
repository / provider abstractions, so the suite runs with no cloud access.

## Authentication

The frontend signs in with Google and sends the ID token as
`Authorization: Bearer <token>`. The API verifies it against
`GOOGLE_OAUTH_CLIENT_ID`, optionally enforces a Workspace domain allow-list
(`ALLOWED_AUTH_DOMAINS`), auto-provisions the user on first sign-in, and attaches
the principal to the request. A user's id is always their Google account `sub`.
`AUTH_DISABLED=true` skips verification for local testing only.

## API surface (v1)

| Area   | Endpoint | Notes |
|--------|----------|-------|
| Auth   | `GET /auth/me` | The caller's resolved identity |
| Users  | `GET/PUT/DELETE /users/me` | Caller's own profile |
| Rooms  | `POST/GET /rooms`, `GET /rooms/:id`, `POST /rooms/:id/{join,leave,start,end}` | `start` begins the countdown to `scheduledEndAt`; the room ends by itself on time, or earlier via `end` |
| Rooms  | `GET/POST /rooms/:id/transcript`, `POST /rooms/:id/change-topic`, `GET /rooms/:id/host-messages` | Voice transcript + what the host said |
| Rooms  | Socket.IO namespace `rooms` | in: `joinRoom`, `leaveRoom`, `transcript`; out: `roomUpdated` (full room after a REST join/leave/start), `presence` (socket connected/left), `transcript`, `hostMessage`, `sessionEnded`, `error` |

## Notes & next steps

- The host's per-room state (segment counters, silence timers, session-end timers) is in-process,
  so the realtime layer assumes a single socket-server instance or sticky sessions;
  a multi-instance deploy would move that state into a shared store (e.g. Redis).
- Voice **audio transport** (WebRTC/SFU) is out of scope — the backend works from
  the client-produced transcript, not raw audio. See `docs/audio-architecture.md`
  for the proposed live-audio design.
