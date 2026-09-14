import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
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

interface JoinRoomPayload {
  roomId: string;
}

interface TranscriptPayload {
  roomId: string;
  text: string;
}

/** The authenticated user is attached to the socket at connection time. */
type AuthedSocket = Socket & { data: { user?: AuthenticatedPrincipal } };

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
export class RoomsGateway implements OnGatewayConnection {
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
   * Authenticate the Google ID token at connection time and pin the identity to
   * the socket. Unauthenticated sockets are dropped immediately, so every
   * handler can trust `client.data.user` and never a client-supplied uid.
   */
  async handleConnection(client: AuthedSocket): Promise<void> {
    try {
      client.data.user = await this.wsAuth.authenticate(client);
    } catch {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ): Promise<void> {
    const user = this.requireUser(client);

    // Only actual room participants (they joined via REST) may subscribe.
    const room = await this.roomsService.getRoom(payload.roomId);
    if (!room.participantIds.includes(user.uid)) {
      client.emit('error', {
        message: 'You are not a participant of this room',
      });
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
    const segment = await this.roomsService.addTranscriptSegment(
      payload.roomId,
      { uid: user.uid, name: user.name },
      payload.text,
    );
    this.server.to(payload.roomId).emit('transcript', segment);

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
    this.server.to(roomId).emit('sessionEnded', { roomId, report });
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

  private requireUser(client: AuthedSocket): AuthenticatedPrincipal {
    const user = client.data.user;
    if (!user) {
      // Should not happen — handleConnection drops unauthenticated sockets.
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
