# Live Audio + Real-time AI Facilitator — Architecture (Milestone Design)

**Status:** proposed · **Date:** 2026-07-07 · **Owner:** backend

This document designs the subsystem that lets people hold a **real-time group
voice call** while the **AI listens to the live audio server-side** and suggests
new topics *during* the call. It is a design to review **before** implementation.

---

## 1. Goal & the "cheapest" constraint

The chosen direction is **lowest cost**. Cost in a live-audio + AI system comes
from three places:

| Cost source | Cheapest choice | Why |
|---|---|---|
| **Human↔human media** | **P2P mesh WebRTC** (no media server) | Browsers send audio directly to each other. Our server only relays tiny signaling messages. No SFU, no egress, no per-minute media bill. |
| **Getting audio to the AI** | **Client mic → WebSocket → backend** | Reuses a plain WebSocket; no media server needed just for the AI to hear. |
| **AI "listening" (STT)** | **Google Cloud Speech-to-Text**, chunked + gated by VAD | STT is the one unavoidable cost. We minimise minutes billed (see §7). |
| **Suggestions / report (LLM)** | **Gemini Flash** (already wired) | Cheap, already behind `LlmProvider`. |

**Net:** the only meaningful recurring cost is **STT minutes** (plus a small TURN
relay bill). No paid SFU. This is the cheapest architecture that still delivers
group voice + server-side AI listening.

### Non-goals (this milestone)
- Not building an SFU. Mesh is fine for small rooms; §8 covers the migration path.
- Not doing speaker diarization from a single mixed stream — each client streams
  its **own** mic, so attribution is free.
- Not video.

---

## 2. Why not the alternatives (recorded for posterity)

- **LiveKit / managed SFU** — best UX and scales, but a paid service / real infra.
  Rejected on cost for now; it is the natural upgrade (see §8).
- **Gemini Live API** — elegant (audio-native, no separate STT) but audio-token
  pricing tends to exceed streaming STT, and it still needs a transport for humans
  to hear each other. Keep as a future option behind the same `SttProvider` seam.
- **Self-hosted mediasoup** — most control, most engineering + ops. Overkill now.

---

## 3. High-level architecture

```
     Browser A                         Browser B                Browser C
  ┌───────────┐   P2P audio (WebRTC)  ┌───────────┐            ┌───────────┐
  │  mic/spkr │◄────────────────────► │  mic/spkr │◄─ mesh ──► │  mic/spkr │
  └─────┬─────┘                       └─────┬─────┘            └─────┬─────┘
        │  ▲                                │                        │
        │  │ signaling (offer/answer/ICE)   │                        │
        │  │ over Socket.IO 'rooms' ns      │                        │
        │  │                                │                        │
   mic  │  │                          mic   │                   mic  │
  audio │  │                         audio  │                  audio │
  (WS)  ▼  │                          (WS)  ▼                  (WS)  ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                        NestJS backend (control plane)                  │
  │                                                                        │
  │  SignalingGateway ──── relays SDP/ICE (no media touches the server)    │
  │                                                                        │
  │  AudioIngestGateway ── receives per-speaker PCM/Opus frames  ┐         │
  │                                                              ▼         │
  │  SttProvider (Google Cloud STT streaming)  ── partial/final transcripts│
  │                                                              │         │
  │                                                              ▼         │
  │  RoomsService.addTranscriptSegment()  ──►  TranscriptSegment (Firestore)│
  │                                                              │         │
  │  Facilitator engine (EXISTING): volume/silence triggers ─────┤         │
  │        → generateTopicSuggestion() → 'topicSuggested' emit    │         │
  │        → on end: generateReport() → 'sessionEnded' emit       ┘         │
  └──────────────────────────────────────────────────────────────────────┘
                                   │
                        STUN (free) + TURN (cheap coturn) for NAT traversal
```

**Key idea:** two independent audio paths.
1. **Human path** — P2P mesh, never touches our server (cheap, low latency).
2. **AI path** — each client sends a *copy* of its own mic to the backend, which
   transcribes it and feeds the facilitator we already built.

---

## 4. What we reuse vs. build new

### Reuse (already built, unchanged)
- `RoomsService.addTranscriptSegment()` — the single ingestion point.
- `TranscriptSegment`, `TopicSuggestion`, `RoomReport` entities + repository.
- Facilitator policy + prompts (`shouldSuggestByVolume/BySilence`, topic + report
  prompts/parsers).
- `generateTopicSuggestion()`, `generateReport()`, room lifecycle, Socket.IO
  broadcasts (`topicSuggested`, `sessionEnded`).
- `LlmProvider` (Gemini) abstraction.

> The facilitator does not care where transcript segments come from. Today a test
> REST call creates them; after this milestone the STT pipeline creates them. That
> is the whole point of the repository/ingestion seam.

### Build new
1. **`SignalingGateway`** (or new events on the existing `rooms` gateway):
   relay `webrtc:offer`, `webrtc:answer`, `webrtc:ice` between peers in a room.
2. **`AudioIngestGateway`** — a WebSocket endpoint that accepts binary audio frames
   from each client, keyed by `{roomId, uid}`.
3. **`SttProvider`** abstraction + **`GoogleSttProvider`** implementation
   (streaming recognize), mirroring how `LlmProvider`/`TokenVerifier` are done.
4. **`AudioSessionManager`** — per-`{roomId, uid}` STT stream lifecycle; on each
   **final** transcript it calls `addTranscriptSegment()` and lets the existing
   facilitator triggers run.
5. **Socket auth** — verify the Firebase token on the signaling + audio handshake
   (closes the existing gateway `TODO`; required before any audio flows).

---

## 5. Core interfaces (sketches, for review — not final)

```ts
// STT behind a provider seam, like LlmProvider. Swappable for Gemini Live later.
export interface SttStream {
  /** Push a chunk of encoded audio (e.g. LINEAR16/Opus) for this speaker. */
  write(chunk: Buffer): void;
  /** Fired when the recognizer finalizes an utterance. */
  onFinal(cb: (text: string) => void): void;
  onPartial?(cb: (text: string) => void): void; // optional live captions
  close(): Promise<void>;
}

export abstract class SttProvider {
  abstract open(opts: { languageCode: string; sampleRateHz: number }): SttStream;
}
```

```
Audio frame protocol (client → AudioIngestGateway), first cut:
  - Handshake: { type: 'start', roomId, token, sampleRateHz, encoding }
  - Media:     binary frames (20–40 ms of Opus/PCM)
  - Control:   { type: 'stop' }
Server maps the socket → { roomId, uid } (uid from the verified token).
```

```
WebRTC signaling events (Socket.IO 'rooms' namespace):
  in:  webrtc:join      { roomId }
  in:  webrtc:offer     { roomId, toUid, sdp }
  in:  webrtc:answer    { roomId, toUid, sdp }
  in:  webrtc:ice       { roomId, toUid, candidate }
  out: webrtc:peer-*    (relayed to the target peer)
  out: webrtc:peers     { uids[] }   // who to connect to on join
```

---

## 6. Real-time flow (happy path)

```
1. Client joins room (REST join) → opens signaling socket → 'webrtc:join'.
2. Server returns current peer uids; clients exchange offer/answer/ICE via relay.
3. Mesh audio connects → participants hear each other (no server media).
4. Each client also opens the audio-ingest WS and streams ITS OWN mic.
5. Server opens one SttProvider stream per {roomId, uid}.
6. On each FINAL transcript → addTranscriptSegment() → segment persisted + emitted.
7. Facilitator triggers (existing): every N segments OR X ms silence →
   generateTopicSuggestion() → 'topicSuggested' pushed to the room DURING the call.
8. Owner ends room → generateReport() from full transcript → 'sessionEnded'.
```

Latency budget for a suggestion ≈ STT finalization (~0.5–2 s) + LLM (~1–2 s). Fine
for a conversational nudge; it does not gate human audio (that is P2P).

---

## 7. Cost model & levers

Recurring cost ≈ **STT minutes** + **small TURN egress** + **modest Gemini calls**.

Order-of-magnitude (validate against live pricing before launch):
- Google STT streaming ≈ **$0.024/min** per audio stream. A 4-person, 20-min room
  streaming all four mics ≈ 80 stream-minutes ≈ **~$1.90/room**. This is the number
  to optimise.

**Levers (each reduces STT minutes, the dominant cost):**
1. **Client-side VAD** — only stream frames when someone is actually speaking. In a
   group call each person speaks a fraction of the time → large savings. (VAD is
   *speech detection*, not transcription, so it respects "frontend doesn't transcribe".)
2. **Silence/hold gating** — stop the STT stream during long silences; reopen on VAD.
3. **Chunked batch STT** instead of streaming for the non-caption path — cheaper per
   minute, acceptable latency for topic nudges (we only need finals).
4. **Suggestion cadence** already config-gated (`ROOM_SUGGEST_EVERY_SEGMENTS`,
   `ROOM_SILENCE_MS`) — controls LLM spend independently.
5. **TURN**: self-host `coturn` on a small VM; most mesh traffic uses STUN (free)
   and only NAT-restricted peers relay.

**Guardrails to build:** per-room max minutes / hard stop, and a kill-switch env to
disable STT (fall back to manual `suggest-topic`) if spend spikes.

---

## 8. Scaling limits & upgrade path (honest constraints)

- **Mesh scales poorly with size.** Each peer uploads its mic to every other peer:
  `O(n²)` connections. Practical ceiling ≈ **4–5 participants** on typical uplinks.
  For "party talk" small rooms this is fine; enforce `maxParticipants ≤ 5` while on
  mesh.
- **AI-path fan-in is `O(n)`** (one mic stream per participant to the server) — fine.
- **When rooms need to be bigger**, swap the human path to an **SFU** (LiveKit is the
  low-effort choice): clients publish one stream, the SFU forwards, and the AI agent
  subscribes to tracks instead of us running the audio-ingest WS. Because STT sits
  behind `SttProvider` and ingestion behind `addTranscriptSegment()`, **the
  facilitator and persistence do not change** — only the transport swaps.
- **Backend statefulness:** STT streams + facilitator timers are in-process → single
  instance or sticky sessions for now (already noted for the gateway). Multi-instance
  later → shared state (Redis) + the SFU-agent model.

---

## 9. Security

- **Auth is mandatory before audio.** Verify the Firebase ID token on BOTH the
  signaling handshake and the audio-ingest handshake; derive `uid` from the token,
  never trust a body/query `uid`. (Closes the current gateway `TODO`.)
- Authorize that the `uid` is actually a participant of `roomId` before relaying
  signaling or accepting audio.
- TURN credentials should be short-lived (time-limited HMAC), minted by the API.
- Rate-limit signaling; cap audio frame size / bitrate server-side.

---

## 10. Proposed milestones (each independently shippable & testable)

| # | Milestone | Deliverable | Verifiable by |
|---|---|---|---|
| **M0** | Socket auth | Firebase-token handshake guard for the `rooms` namespace + participant check | unit + a socket auth test |
| **M1** | Signaling + mesh voice | `webrtc:*` relay events; two browsers hear each other P2P | manual 2-client call |
| **M2** | Audio ingest + STT | `AudioIngestGateway` + `SttProvider`/`GoogleSttProvider`; mic → transcript segments persisted | integration test with a fake SttProvider; live smoke with Google STT |
| **M3** | Real-time suggestions | Existing facilitator triggers fire from STT-sourced segments → `topicSuggested` mid-call | e2e with faked STT feeding canned utterances |
| **M4** | End report from live session | `sessionEnded` report over a real call | manual + existing report tests |
| **M5** | Cost controls + hardening | VAD gating, per-room minute cap, STT kill-switch, TURN credentials | load/cost test, chaos (STT down) |

Each milestone keeps the `SttProvider` / `addTranscriptSegment` seams, so the
facilitator built already is exercised end-to-end from M3 on.

---

## 11. Resolved decisions (2026-07-07)

1. **Participant cap** — ✅ cap rooms at **≤5** while on mesh. Enforce in
   `CreateRoomDto`/service (`maxParticipants` max 5 on mesh).
2. **STT language** — English-only (`en-US` default; revisit multi-locale later).
3. **Live captions** — **finals-only to the AI for now** (my call). Partial-result
   captions are a cheap later add (no extra STT minutes) behind the same stream.
4. **TURN** — **self-host `coturn`** (cheapest). API mints short-lived TURN creds.
5. **Monetization / budget** — **users pay per room created.** So cost-per-room must
   be bounded: the per-room STT minute cap + kill-switch (§7) are **requirements**,
   and we should **meter STT minutes per room** for costing/billing. No billing
   system is built yet — just the metering hook + guardrails.
6. **Frontend** — will adapt to these API resources; this repo owns the contract
   (events + audio protocol) but not the client. Don't block on it.

---

## 12. Recommendation

Proceed **M0 → M1 → M2 → M3** to reach the core promise (AI suggests topics during a
live, cheap, P2P voice call) with STT as the only real cost. Treat LiveKit/SFU as the
explicit upgrade once rooms outgrow mesh — the seams here make that swap contained.
