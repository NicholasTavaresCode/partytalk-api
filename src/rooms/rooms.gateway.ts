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
import { RoomReport } from './entities/room-report.entity';
import { SuggestionTrigger } from './entities/topic-suggestion.entity';
import { shouldSuggestByVolume } from './facilitator/facilitator-policy';
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

/** Per-room facilitator state kept in memory on this socket-server instance. */
interface RoomState {
  sinceLastSuggestion: number;
  silenceTimer?: ReturnType<typeof setTimeout>;
  suggesting: boolean;
}

/**
 * Realtime transport for rooms. Participants talk by voice; the client streams
 * speech-to-text as `transcript` events. This gateway persists each segment via
 * RoomsService, broadcasts it, and runs the AI facilitator's auto-triggers:
 * suggest a new topic every N segments (volume) or after X ms of silence.
 * Business logic (LLM, persistence) stays in the service — the gateway only
 * owns the clock and the fan-out.
 *
 * NOTE: facilitator state is in-process, so this assumes a single socket-server
 * instance (or sticky sessions). A multi-instance deployment would move
 * `RoomState` into a shared store (e.g. Redis).
 */
@WebSocketGateway({ namespace: 'rooms', cors: true })
export class RoomsGateway implements OnGatewayConnection {
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
    state.sinceLastSuggestion += 1;
    this.scheduleSilenceTrigger(payload.roomId);

    if (shouldSuggestByVolume(state.sinceLastSuggestion, this.everySegments)) {
      await this.suggestAndBroadcast(payload.roomId, 'volume');
    }
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
      // Should not happen — handleConnection drops unauthenticated sockets.
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
