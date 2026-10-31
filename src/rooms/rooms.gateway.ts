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
import { HostMessage, HostTrigger } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
import { RoomReport } from './entities/room-report.entity';
import { shouldEvaluateByVolume } from './facilitator/facilitator-policy';
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

/** Per-room host state kept in memory on this socket-server instance. */
interface RoomState {
  /** Transcript segments captured since the host was last consulted. */
  sinceLastConsult: number;
  silenceTimer?: ReturnType<typeof setTimeout>;
  /** Fires at `scheduledEndAt` to end the session server-side. */
  sessionEndTimer?: ReturnType<typeof setTimeout>;
  /** A consultation (LLM call) is in flight for this room. */
  consulting: boolean;
}

/**
 * Realtime transport for rooms. Participants talk by voice; the client streams
 * speech-to-text as `transcript` events. This gateway persists each segment via
 * RoomsService and broadcasts it, then periodically *consults* the AI host:
 * every N segments (volume) or after X ms of silence, it lets the host listen
 * to the recent conversation and decide whether the current topic has been
 * talked about enough — and broadcasts a `hostMessage` only when the host
 * actually speaks. It also keeps each room's session clock and ends the session
 * server-side when the room's length runs out. Business logic (LLM, the
 * decision, persistence) stays in the service — the gateway only owns the
 * clock and the fan-out.
 *
 * NOTE: host state and session timers are in-process, so this assumes a single
 * socket-server instance (or sticky sessions), and a restart drops pending
 * timers. A multi-instance deployment would move `RoomState` into a shared
 * store (e.g. Redis).
 */
@WebSocketGateway({ namespace: 'rooms', cors: true })
export class RoomsGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RoomsGateway.name);
  private readonly rooms = new Map<string, RoomState>();
  /** Consult the host at most once per this many segments (cost bound). */
  private readonly consultEvery: number;
  private readonly silenceMs: number;

  constructor(
    private readonly roomsService: RoomsService,
    private readonly wsAuth: WsAuthenticator,
    config: ConfigService<AppConfig, true>,
  ) {
    const facilitator = config.get('facilitator', { infer: true });
    this.consultEvery = facilitator.suggestEverySegments;
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
    state.sinceLastConsult += 1;
    this.scheduleSilenceTrigger(payload.roomId);

    if (shouldEvaluateByVolume(state.sinceLastConsult, this.consultEvery)) {
      await this.consultHost(payload.roomId, 'volume');
    }
  }

  /**
   * Arm the session clock for a room that just went live: at `scheduledEndAt`
   * the session is ended server-side (report generated, `sessionEnded`
   * broadcast). Ending early via REST stands it down (see broadcastSessionEnded).
   */
  scheduleSessionEnd(room: Room): void {
    if (!room.scheduledEndAt) {
      return;
    }
    const state = this.stateFor(room.id);
    if (state.sessionEndTimer) {
      clearTimeout(state.sessionEndTimer);
    }
    const delay = Math.max(
      0,
      new Date(room.scheduledEndAt).getTime() - Date.now(),
    );
    state.sessionEndTimer = setTimeout(() => {
      void this.endSession(room.id);
    }, delay);
    state.sessionEndTimer.unref?.();
  }

  /**
   * Push the authoritative room to everyone already in it after membership or
   * lifecycle changes made over REST (join, leave, start), so existing clients
   * never have to reconstruct `participantIds` from `presence` events. Note:
   * `presence` only reflects socket subscription; this carries membership.
   */
  broadcastRoomUpdated(room: Room): void {
    this.server.to(room.id).emit('roomUpdated', room);
  }

  /** Push a line the host said to everyone in the room. */
  broadcastHostMessage(message: HostMessage): void {
    this.server.to(message.roomId).emit('hostMessage', message);
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
      void this.consultHost(roomId, 'silence');
    }, this.silenceMs);
    // Don't keep the event loop alive just for a pending check.
    state.silenceTimer.unref?.();
  }

  /**
   * Consult the host for this room. It listens to the conversation and decides
   * whether to step in; we broadcast a `hostMessage` only when it does. Guarded
   * so we never run overlapping consultations for the same room.
   */
  private async consultHost(
    roomId: string,
    trigger: HostTrigger,
  ): Promise<void> {
    const state = this.stateFor(roomId);
    if (state.consulting) {
      return; // avoid overlapping LLM calls for the same room
    }
    state.consulting = true;
    // Reset the counter up front so new segments accumulate toward the next check.
    state.sinceLastConsult = 0;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = undefined;
    }

    try {
      const message = await this.roomsService.consultHost(roomId, trigger);
      // null = the host chose to stay quiet; nothing to broadcast.
      if (message) {
        this.broadcastHostMessage(message);
      }
    } catch (error) {
      this.logger.warn(
        `Host consultation failed for room ${roomId}: ${(error as Error).message}`,
      );
    } finally {
      state.consulting = false;
    }
  }

  /** Time is up: end the session and tell the room, unless the owner already did. */
  private async endSession(roomId: string): Promise<void> {
    try {
      const room = await this.roomsService.expireRoom(roomId);
      // null = the owner ended it first; `sessionEnded` already went out then.
      if (room) {
        this.broadcastSessionEnded(roomId, room.report);
      }
    } catch (error) {
      this.logger.warn(
        `Ending room ${roomId} on time failed: ${(error as Error).message}`,
      );
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
      state = { sinceLastConsult: 0, consulting: false };
      this.rooms.set(roomId, state);
    }
    return state;
  }

  private clearRoomState(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (state?.silenceTimer) {
      clearTimeout(state.silenceTimer);
    }
    if (state?.sessionEndTimer) {
      clearTimeout(state.sessionEndTimer);
    }
    this.rooms.delete(roomId);
  }
}
