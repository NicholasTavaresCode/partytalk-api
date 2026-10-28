import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsAuthenticator } from '../auth/ws-authenticator';
import { AppConfig } from '../config/configuration';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { RoomReport } from './entities/room-report.entity';
import {
  SuggestionTrigger,
  TopicSuggestion,
} from './entities/topic-suggestion.entity';
import { shouldSuggestByVolume } from './facilitator/facilitator-policy';
import { canAccessRoom, normalizeEmail } from './room-access';
import { RoomsService } from './rooms.service';

/** Mirrors PostTranscriptDto's limit for the REST path. */
const MAX_SEGMENT_CHARS = 2000;

/** Socket.IO room holding every socket in a room's voice mesh. */
const voiceRoom = (roomId: string) => `voice:${roomId}`;
/** Socket.IO room holding the one socket that speaks for `uid` in that mesh. */
const voiceSeat = (roomId: string, uid: string) => `voice:${roomId}:${uid}`;

interface JoinRoomPayload {
  roomId: string;
}

interface TranscriptPayload {
  roomId: string;
  text: string;
}

/** A WebRTC signaling message addressed to one peer in the room. */
interface SignalPayload {
  roomId: string;
  toUid: string;
  sdp?: unknown;
  candidate?: unknown;
}

/**
 * The authenticated user is attached to the socket at connection time; `rooms`
 * and `voice` remember which rooms (and voice meshes) it entered, because
 * Socket.IO has already emptied `socket.rooms` by the time `handleDisconnect` runs.
 */
type AuthedSocket = Socket & {
  data: {
    user?: AuthenticatedPrincipal;
    rooms?: Set<string>;
    voice?: Set<string>;
  };
};

/** Per-room facilitator state kept in memory on this socket-server instance. */
interface RoomState {
  sinceLastSuggestion: number;
  silenceTimer?: ReturnType<typeof setTimeout>;
  suggesting: boolean;
}

/**
 * Realtime transport for rooms. Participants talk by voice; the client streams
 * speech-to-text as `transcript` events. This gateway broadcasts each segment,
 * persists it via RoomsService, and runs the AI facilitator's auto-triggers:
 * suggest a new topic every N segments (volume) or after X ms of silence.
 * Business logic (LLM, persistence) stays in the service — the gateway only
 * owns the clock and the fan-out.
 *
 * Rooms are invite-only: entering (`joinRoom`, `webrtc:join`) requires having
 * joined via REST *and* still passing `canAccessRoom`, and `evictFromRoom`
 * kicks a revoked invitee's live sockets out of the room and the voice mesh.
 *
 * It also relays WebRTC signaling (`webrtc:*`) for the P2P voice mesh described
 * in docs/audio-architecture.md (M1). Only tiny SDP/ICE messages pass through
 * here; audio flows browser-to-browser.
 *
 * Who is in a room or its voice mesh lives only in Socket.IO rooms, which the
 * Pub/Sub adapter (PubSubIoAdapter) shares across instances — Cloud Run can run
 * two at once even at max-instances 1. So presence, room updates and WebRTC
 * relays reach sockets on any instance; never keep membership in a local Map.
 * Only the facilitator's counters and silence timers stay per instance: while
 * two instances overlap, a room's nudges may come from either.
 */
@WebSocketGateway({ namespace: 'rooms', cors: true })
export class RoomsGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RoomsGateway.name);
  private readonly rooms = new Map<string, RoomState>();
  private readonly everySegments: number;
  private readonly silenceMs: number;

  constructor(
    private readonly roomsService: RoomsService,
    private readonly wsAuth: WsAuthenticator,
    config: ConfigService<AppConfig, true>,
  ) {
    const facilitator = config.get('facilitator', { infer: true });
    this.everySegments = facilitator.suggestEverySegments;
    this.silenceMs = facilitator.silenceMs;
  }

  /**
   * Authenticate every handshake in Socket.IO middleware, before the socket
   * connects. A refusal (usually an expired Google ID token on a reconnect)
   * reaches the client as `connect_error`, which it answers by retrying with a
   * fresh token — instead of a connect-then-kick it can't tell apart from a
   * real disconnect.
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticateSocket(socket as AuthedSocket, next);
    });
  }

  /**
   * Pin the verified identity to the socket, so every handler can trust
   * `client.data.user` and never a client-supplied uid.
   */
  async authenticateSocket(
    client: AuthedSocket,
    next: (err?: Error) => void,
  ): Promise<void> {
    try {
      client.data.user = await this.wsAuth.authenticate(client);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  }

  /**
   * Drop the socket from any voice mesh so peers tear down its connection, and
   * tell its rooms the person left — a closed tab never sends `leaveRoom`.
   */
  async handleDisconnect(client: AuthedSocket): Promise<void> {
    const uid = client.data.user?.uid;
    if (!uid) {
      return;
    }
    for (const roomId of client.data.voice ?? []) {
      await this.announceVoiceLeftIfGone(roomId, uid);
    }
    for (const roomId of client.data.rooms ?? []) {
      await this.announceLeftIfGone(roomId, uid);
    }
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ): Promise<void> {
    const user = this.requireUser(client);
    if (!(await this.mayEnter(client, user, payload.roomId))) {
      return;
    }

    await client.join(payload.roomId);
    (client.data.rooms ??= new Set()).add(payload.roomId);
    // `presence` only reports people who join later, so hand the newcomer
    // everyone already here — otherwise the host shows up as an offline "Guest".
    client.emit('roster', {
      roomId: payload.roomId,
      members: await this.membersOf(payload.roomId),
    });
    this.server.to(payload.roomId).emit('presence', {
      roomId: payload.roomId,
      uid: user.uid,
      name: user.name,
      event: 'joined',
    });
  }

  @SubscribeMessage('leaveRoom')
  async handleLeaveRoom(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ): Promise<void> {
    const user = this.requireUser(client);
    await this.leaveVoice(client, payload.roomId, user.uid);
    await client.leave(payload.roomId);
    client.data.rooms?.delete(payload.roomId);
    await this.announceLeftIfGone(payload.roomId, user.uid);
  }

  @SubscribeMessage('transcript')
  async handleTranscript(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: TranscriptPayload,
  ): Promise<void> {
    const user = this.requireUser(client);
    // Sockets only enter the room after joinRoom's participant check, so this
    // in-memory test authorizes the hot path without a Firestore read.
    if (!client.rooms.has(payload.roomId)) {
      client.emit('error', {
        message: 'Join the room before sending transcript',
      });
      return;
    }
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > MAX_SEGMENT_CHARS) {
      return;
    }

    // Fan out first so listeners see the line at socket latency; the write
    // lands afterwards and must finish before the facilitator reads history.
    const segment = this.roomsService.buildTranscriptSegment(
      payload.roomId,
      { uid: user.uid, name: user.name },
      text,
    );
    this.server.to(payload.roomId).emit('transcript', segment);
    try {
      await this.roomsService.saveTranscriptSegment(segment);
    } catch (error) {
      this.logger.warn(
        `Failed to persist segment for room ${payload.roomId}: ${(error as Error).message}`,
      );
      return;
    }

    const state = this.stateFor(payload.roomId);
    state.sinceLastSuggestion += 1;
    this.scheduleSilenceTrigger(payload.roomId);

    if (shouldSuggestByVolume(state.sinceLastSuggestion, this.everySegments)) {
      await this.suggestAndBroadcast(payload.roomId, 'volume');
    }
  }

  /**
   * Enter the room's voice mesh. Replies with the peers already in it, and the
   * joiner offers to each of them.
   */
  @SubscribeMessage('webrtc:join')
  async handleWebrtcJoin(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ): Promise<void> {
    const user = this.requireUser(client);
    const { roomId } = payload;
    if (!(await this.mayEnter(client, user, roomId))) {
      return;
    }

    // One voice connection per person: a newer tab or a reconnect takes the
    // seat over, wherever the older socket lives, so offers never reach two.
    const seat = voiceSeat(roomId, user.uid);
    this.server
      .in(seat)
      .except(client.id)
      .socketsLeave([voiceRoom(roomId), seat]);
    // Join first, then list. When the host starts, everyone joins at once; this
    // way two simultaneous joiners both see (and offer to) each other, and the
    // client settles that glare (useVoiceMesh) — rather than each missing the
    // other and nobody offering at all.
    await client.join([voiceRoom(roomId), seat]);
    (client.data.voice ??= new Set()).add(roomId);
    const uids = (await this.uidsIn(voiceRoom(roomId))).filter(
      (uid) => uid !== user.uid,
    );
    client.emit('webrtc:peers', { uids });
  }

  @SubscribeMessage('webrtc:offer')
  handleWebrtcOffer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: SignalPayload,
  ): void {
    this.relay(client, payload, 'webrtc:peer-offer', { sdp: payload.sdp });
  }

  @SubscribeMessage('webrtc:answer')
  handleWebrtcAnswer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: SignalPayload,
  ): void {
    this.relay(client, payload, 'webrtc:peer-answer', { sdp: payload.sdp });
  }

  @SubscribeMessage('webrtc:ice')
  handleWebrtcIce(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: SignalPayload,
  ): void {
    this.relay(client, payload, 'webrtc:peer-ice', {
      candidate: payload.candidate,
    });
  }

  /**
   * Kick a revoked invitee out: every socket of theirs (matched by uid or by the
   * revoked email) leaves the room and the voice mesh and is told why; the room
   * sees them leave.
   */
  async evictFromRoom(
    roomId: string,
    uids: string[],
    email: string,
  ): Promise<void> {
    const target = normalizeEmail(email);
    // Their sockets in the room channel or only in its voice mesh, on any instance.
    const sockets = new Map<
      string,
      Awaited<ReturnType<typeof this.socketsIn>>[number]
    >();
    for (const room of [roomId, voiceRoom(roomId)]) {
      for (const socket of await this.socketsIn(room)) {
        sockets.set(socket.id, socket);
      }
    }
    const evicted = new Set<string>();
    for (const socket of sockets.values()) {
      const user = (socket.data as AuthedSocket['data']).user;
      if (
        !user ||
        !(
          uids.includes(user.uid) || normalizeEmail(user.email ?? '') === target
        )
      ) {
        continue;
      }
      socket.leave(roomId);
      socket.leave(voiceRoom(roomId));
      socket.leave(voiceSeat(roomId, user.uid));
      socket.emit('removedFromRoom', { roomId });
      evicted.add(user.uid);
    }
    for (const uid of evicted) {
      this.server
        .to([roomId, voiceRoom(roomId)])
        .emit('webrtc:peer-left', { uid });
      this.server.to(roomId).emit('presence', { roomId, uid, event: 'left' });
    }
  }

  /**
   * Tell everyone in the room that its REST state changed — someone joined or
   * left, the host started it, an invite was revoked — so each client refetches
   * `GET /rooms/:id`. Deliberately carries no room data: that endpoint filters
   * owner-only fields per caller, and broadcasting the room would hand every
   * participant the invite list and link code.
   */
  notifyRoomUpdated(roomId: string): void {
    this.server.to(roomId).emit('roomUpdated', { roomId });
  }

  /**
   * The sockets in a Socket.IO room, across every instance. If another instance
   * doesn't answer in time (e.g. Cloud Run is retiring it), fall back to this
   * instance's view rather than failing the event.
   */
  private async socketsIn(room: string) {
    try {
      return await this.server.in(room).fetchSockets();
    } catch (error) {
      this.logger.warn(
        `fetchSockets(${room}) across instances failed (${(error as Error).message}); using this instance only`,
      );
      return this.server.local.in(room).fetchSockets();
    }
  }

  /** The distinct people (uids) with a socket in a Socket.IO room. */
  private async uidsIn(room: string): Promise<string[]> {
    const uids = new Set<string>();
    for (const socket of await this.socketsIn(room)) {
      const user = (socket.data as AuthedSocket['data']).user;
      if (user) {
        uids.add(user.uid);
      }
    }
    return [...uids];
  }

  /** Who is connected to the room right now, one entry per person. */
  private async membersOf(
    roomId: string,
  ): Promise<{ uid: string; name?: string }[]> {
    const members = new Map<string, string | undefined>();
    for (const socket of await this.socketsIn(roomId)) {
      const user = (socket.data as AuthedSocket['data']).user;
      if (user) {
        members.set(user.uid, user.name);
      }
    }
    return [...members].map(([uid, name]) => ({ uid, name }));
  }

  /** Announce `left` only once the person's last socket in the room is gone. */
  private async announceLeftIfGone(roomId: string, uid: string): Promise<void> {
    if ((await this.membersOf(roomId)).some((m) => m.uid === uid)) {
      return; // still here in another tab
    }
    this.server.to(roomId).emit('presence', { roomId, uid, event: 'left' });
  }

  /**
   * Broadcast a topic the host asked for (REST `suggest-topic`) to the whole
   * room, and restart the automatic triggers so the AI doesn't pile another
   * nudge on top of it.
   */
  announceSuggestion(roomId: string, suggestion: TopicSuggestion): void {
    const state = this.rooms.get(roomId);
    if (state) {
      this.resetTriggers(state);
    }
    this.server.to(roomId).emit('topicSuggested', suggestion);
  }

  /** Broadcast the end-of-session report and drop the room's timers/state. */
  broadcastSessionEnded(roomId: string, report?: RoomReport): void {
    this.clearRoomState(roomId);
    this.server.in(voiceRoom(roomId)).socketsLeave(voiceRoom(roomId));
    this.server.to(roomId).emit('sessionEnded', { roomId, report });
  }

  /**
   * Forward a signaling message to one peer's seat, on whichever instance it
   * is. The sender must still hold its own seat in this room's mesh (a newer
   * tab may have taken it over) and is stamped from the verified socket —
   * never from the payload. Checking costs no I/O: it's the socket's own rooms.
   */
  private relay(
    client: AuthedSocket,
    payload: SignalPayload,
    event: string,
    body: Record<string, unknown>,
  ): void {
    const user = this.requireUser(client);
    if (
      typeof payload?.roomId !== 'string' ||
      typeof payload.toUid !== 'string' ||
      !client.rooms.has(voiceRoom(payload.roomId)) ||
      !client.rooms.has(voiceSeat(payload.roomId, user.uid))
    ) {
      return;
    }
    this.server
      .to(voiceSeat(payload.roomId, payload.toUid))
      .emit(event, { fromUid: user.uid, ...body });
  }

  private async leaveVoice(
    client: AuthedSocket,
    roomId: string,
    uid: string,
  ): Promise<void> {
    if (!client.data.voice?.delete(roomId)) {
      return;
    }
    await client.leave(voiceRoom(roomId));
    await client.leave(voiceSeat(roomId, uid));
    await this.announceVoiceLeftIfGone(roomId, uid);
  }

  /** Tell the mesh a peer left, unless they're still in it from another socket. */
  private async announceVoiceLeftIfGone(
    roomId: string,
    uid: string,
  ): Promise<void> {
    if ((await this.uidsIn(voiceRoom(roomId))).includes(uid)) {
      return;
    }
    this.server
      .to([roomId, voiceRoom(roomId)])
      .emit('webrtc:peer-left', { uid });
  }

  /**
   * Only people who took a seat via REST *and* are still invited may subscribe —
   * the invite check stops a revoked user from slipping back in on reconnect.
   */
  private async mayEnter(
    client: AuthedSocket,
    user: AuthenticatedPrincipal,
    roomId: string,
  ): Promise<boolean> {
    const room = await this.roomsService.getRoom(roomId);
    if (room.participantIds.includes(user.uid) && canAccessRoom(room, user)) {
      return true;
    }
    client.emit('error', {
      message: 'You are not a participant of this room',
    });
    return false;
  }

  private scheduleSilenceTrigger(roomId: string): void {
    const state = this.stateFor(roomId);
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
    }
    state.silenceTimer = setTimeout(() => {
      void this.suggestAndBroadcast(roomId, 'silence');
    }, this.silenceMs);
    // Don't keep the event loop alive just for a pending nudge.
    state.silenceTimer.unref?.();
  }

  private async suggestAndBroadcast(
    roomId: string,
    trigger: SuggestionTrigger,
  ): Promise<void> {
    const state = this.stateFor(roomId);
    if (state.suggesting) {
      return; // avoid overlapping LLM calls for the same room
    }
    state.suggesting = true;
    // Reset counters up front so new segments accumulate toward the next nudge.
    this.resetTriggers(state);

    try {
      const suggestion = await this.roomsService.generateTopicSuggestion(
        roomId,
        trigger,
      );
      this.server.to(roomId).emit('topicSuggested', suggestion);
    } catch (error) {
      this.logger.warn(
        `Topic suggestion failed for room ${roomId}: ${(error as Error).message}`,
      );
    } finally {
      state.suggesting = false;
    }
  }

  private resetTriggers(state: RoomState): void {
    state.sinceLastSuggestion = 0;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = undefined;
    }
  }

  private requireUser(client: AuthedSocket): AuthenticatedPrincipal {
    const user = client.data.user;
    if (!user) {
      // Should not happen — the handshake middleware refuses unauthenticated sockets.
      client.disconnect(true);
      throw new Error('Unauthenticated socket');
    }
    return user;
  }

  private stateFor(roomId: string): RoomState {
    let state = this.rooms.get(roomId);
    if (!state) {
      state = { sinceLastSuggestion: 0, suggesting: false };
      this.rooms.set(roomId, state);
    }
    return state;
  }

  private clearRoomState(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (state?.silenceTimer) {
      clearTimeout(state.silenceTimer);
    }
    this.rooms.delete(roomId);
  }
}
