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
import { SuggestionTrigger } from './entities/topic-suggestion.entity';
import { shouldSuggestByVolume } from './facilitator/facilitator-policy';
import { canAccessRoom, normalizeEmail } from './room-access';
import { RoomsService } from './rooms.service';

/** Mirrors PostTranscriptDto's limit for the REST path. */
const MAX_SEGMENT_CHARS = 2000;

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

/** The authenticated user is attached to the socket at connection time. */
type AuthedSocket = Socket & { data: { user?: AuthenticatedPrincipal } };

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
 * NOTE: facilitator state and voice membership are in-process, so this assumes
 * a single socket-server instance (or sticky sessions). A multi-instance
 * deployment would move them into a shared store (e.g. Redis).
 */
@WebSocketGateway({ namespace: 'rooms', cors: true })
export class RoomsGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RoomsGateway.name);
  private readonly rooms = new Map<string, RoomState>();
  /** Voice mesh members per room: roomId → (uid → socket id). */
  private readonly voice = new Map<string, Map<string, string>>();
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

  /** Drop the socket from any voice mesh so peers tear down its connection. */
  handleDisconnect(client: AuthedSocket): void {
    const uid = client.data.user?.uid;
    if (!uid) {
      return;
    }
    for (const roomId of [...this.voice.keys()]) {
      this.leaveVoice(roomId, uid, client.id);
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
    this.leaveVoice(payload.roomId, user.uid, client.id);
    await client.leave(payload.roomId);
    this.server.to(payload.roomId).emit('presence', {
      roomId: payload.roomId,
      uid: user.uid,
      event: 'left',
    });
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
   * Enter the room's voice mesh. Replies with the peers already in it; the
   * joiner sends each of them an offer, so there is never offer glare.
   */
  @SubscribeMessage('webrtc:join')
  async handleWebrtcJoin(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ): Promise<void> {
    const user = this.requireUser(client);
    if (!(await this.mayEnter(client, user, payload.roomId))) {
      return;
    }

    let members = this.voice.get(payload.roomId);
    if (!members) {
      members = new Map();
      this.voice.set(payload.roomId, members);
    }
    const uids = [...members.keys()].filter((uid) => uid !== user.uid);
    members.set(user.uid, client.id);
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
    const sockets = await this.server.in(roomId).fetchSockets();
    for (const socket of sockets) {
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
      this.leaveVoice(roomId, user.uid, socket.id);
      socket.emit('removedFromRoom', { roomId });
      this.server
        .to(roomId)
        .emit('presence', { roomId, uid: user.uid, event: 'left' });
    }
    // Voice members who never subscribed to the room channel.
    for (const uid of uids) {
      const socketId = this.voice.get(roomId)?.get(uid);
      if (socketId) {
        this.leaveVoice(roomId, uid, socketId);
      }
    }
  }

  /** Broadcast the end-of-session report and drop the room's timers/state. */
  broadcastSessionEnded(roomId: string, report?: RoomReport): void {
    this.clearRoomState(roomId);
    this.voice.delete(roomId);
    this.server.to(roomId).emit('sessionEnded', { roomId, report });
  }

  /**
   * Forward a signaling message to one peer. Both ends must be current voice
   * members of the room, and the sender is stamped from the verified socket —
   * never from the payload. Membership is in memory, so relaying costs no I/O.
   */
  private relay(
    client: AuthedSocket,
    payload: SignalPayload,
    event: string,
    body: Record<string, unknown>,
  ): void {
    const user = this.requireUser(client);
    const members = this.voice.get(payload.roomId);
    if (members?.get(user.uid) !== client.id) {
      return;
    }
    const target = members.get(payload.toUid);
    if (!target) {
      return;
    }
    this.server.to(target).emit(event, { fromUid: user.uid, ...body });
  }

  private leaveVoice(roomId: string, uid: string, socketId: string): void {
    const members = this.voice.get(roomId);
    // A newer socket (e.g. a reconnect) may already own this uid's slot.
    if (members?.get(uid) !== socketId) {
      return;
    }
    members.delete(uid);
    if (members.size === 0) {
      this.voice.delete(roomId);
    }
    this.server.to(roomId).emit('webrtc:peer-left', { uid });
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
    state.sinceLastSuggestion = 0;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = undefined;
    }

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
