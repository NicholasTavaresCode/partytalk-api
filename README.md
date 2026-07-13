# PartyTalk API

Backend for **PartyTalk** — live group English-practice **rooms** where people talk by voice while an **AI facilitator** listens to the transcript, proactively suggests new related topics (to build versatility, resilience and creativity), and writes a report at the end. Also includes a solo **IELTS exam simulator** (Listening / Reading / Writing / Speaking), currently parked. English only.

### How a room works

1. People join a room and **talk by voice**. The frontend runs speech-to-text and streams each utterance to the backend as a **transcript segment** (Socket.IO `transcript` event, or `POST /rooms/:id/transcript`).
2. The **AI facilitator** watches the rolling transcript and **auto-suggests a new, related topic** — after every _N_ segments or after _X_ ms of silence (both configurable) — pushed to the room as a `topicSuggested` event. `POST /rooms/:id/suggest-topic` triggers one on demand.
3. On **end**, the AI produces one room-level **report** (`summary`, `highlights`, `suggestions`, `topicsExplored`), stored on the room and emitted as `sessionEnded`.

Built with **NestJS 11** on **Firestore** (Google Cloud), **Firebase Auth** for identity, **Socket.IO** for realtime rooms, and **Vertex AI (Gemini)** for the AI host and rubric-based IELTS scoring. Developed test-first (TDD).

## Architecture

Standard NestJS feature-module layout. Cross-cutting concerns are registered globally in `AppModule`; each feature owns its controller, service, repository abstraction, DTOs and entity.

```
src/
├── main.ts                 # bootstrap: helmet, CORS, URI versioning (/api/v1), graceful shutdown
├── app.module.ts           # global guards (throttler + auth), ValidationPipe, response envelope, error filter
├── config/                 # typed config + Joi env validation (fail-fast)
├── firestore/              # firebase-admin app + FIRESTORE injection token
├── auth/                   # Firebase ID-token verification + secure-by-default guard
├── ai/                     # LlmProvider abstraction + Vertex AI (Gemini) implementation
├── common/                 # exception filter, transform interceptor, @CurrentUser / @Public, DTOs
├── health/                 # liveness + Firestore readiness probes (Terminus)
├── users/                  # learner profiles (id = Firebase UID)
├── rooms/                  # group practice rooms: REST + Socket.IO gateway + AI host
└── ielts/                  # exams, attempts, auto + LLM rubric scoring
```

### Key design decisions

- **Repository pattern with DI tokens.** Every feature depends on an abstract
  `XRepository` class, not on Firestore. The Firestore implementation is bound in
  the module. This keeps services persistence-agnostic and unit-testable with
  in-memory fakes.
- **Provider abstractions for external services.** Identity (`TokenVerifier`) and
  the LLM (`LlmProvider`) are abstract classes bound to concrete Firebase / Vertex
  implementations. Swapping providers — or injecting a deterministic fake in
  tests — is a one-line change.
- **Secure by default.** A global `FirebaseAuthGuard` protects every route unless
  explicitly marked `@Public()`. User-scoped endpoints derive identity from the
  verified token, never from the URL.
- **Consistent HTTP contract.** Global `ValidationPipe` (whitelist + transform),
  a response envelope (`{ data, meta }`), and a centralized exception filter.

## Prerequisites

- Node.js 22+
- A Google Cloud project with **Firestore**, **Firebase Auth**, and **Vertex AI** enabled
- Credentials via Application Default Credentials (`gcloud auth application-default login`) or a service-account key

## Setup

```bash
npm install
cp .env.example .env      # then fill in GCP_PROJECT_ID etc.
```

See `.env.example` for all configuration. Point `FIRESTORE_EMULATOR_HOST` at the
local emulator for offline development.

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
envelope), and error shapes. Click **Authorize** and paste a Firebase ID token to
call protected endpoints from the browser.

## Testing (TDD)

```bash
npm test                  # unit tests
npm run test:cov          # with coverage
npm run test:e2e          # end-to-end (hermetic — fakes Firebase/Firestore)
```

Unit tests mock external services (Firestore, Firebase Auth, Vertex AI) via the
repository / provider abstractions, so the suite runs with no cloud access.

## Authentication

The frontend authenticates with Firebase Auth and sends the ID token as
`Authorization: Bearer <token>`. The API verifies it with the Firebase Admin SDK
and attaches the user to the request. A user's id is always their Firebase UID.

## API surface (v1)

| Area   | Endpoint | Notes |
|--------|----------|-------|
| Users  | `GET/PUT/DELETE /users/me` | Caller's own profile |
| Rooms  | `POST/GET /rooms`, `GET /rooms/:id`, `POST /rooms/:id/{join,leave,start,end}` | `end` generates the room report |
| Rooms  | `GET/POST /rooms/:id/transcript`, `POST /rooms/:id/suggest-topic`, `GET /rooms/:id/suggestions` | Voice transcript + AI topic nudges |
| Rooms  | Socket.IO namespace `rooms` | in: `joinRoom`, `leaveRoom`, `transcript`; out: `presence`, `transcript`, `topicSuggested`, `sessionEnded` |
| IELTS  | `GET /ielts/exams`, `GET /ielts/exams/:id` | Browse content by section |
| IELTS  | `POST /ielts/attempts`, `GET /ielts/attempts`, `PATCH /ielts/attempts/:id/responses`, `POST /ielts/attempts/:id/score` | Auto-score L/R, LLM rubric for W/S |

## Notes & next steps

- Socket.IO handshake authentication (verifying the Firebase token on connect,
  and deriving the speaker uid from it) is stubbed and marked `TODO` in the gateway.
- The facilitator's per-room state (segment counters, silence timers) is in-process,
  so the realtime layer assumes a single socket-server instance or sticky sessions;
  a multi-instance deploy would move that state into a shared store (e.g. Redis).
- Voice **audio transport** (WebRTC/SFU) is out of scope — the backend works from
  the client-produced transcript, not raw audio.
- IELTS is parked; its exam content is served from Firestore and seed scripts are
  not yet included.
