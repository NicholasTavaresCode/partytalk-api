import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '../ai/llm-provider';
import { AppConfig } from '../config/configuration';
import { CreateRoomDto } from './dto/create-room.dto';
import { HostMessage, HostTrigger } from './entities/host-message.entity';
import { DEFAULT_ROOM_DURATION_MINUTES, Room } from './entities/room.entity';
import { RoomReport } from './entities/room-report.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import {
  buildHostPrompt,
  buildOpeningTopicPrompt,
  buildReportPrompt,
  HostTurn,
  OPENING_TOPIC_AREAS,
  parseHostTurn,
  parseOpeningTopic,
  parseReport,
} from './facilitator/facilitator-prompts';
import { User } from '../users/entities/user.entity';
import { UsersRepository } from '../users/users.repository';
import {
  canAccessRoom,
  inviteCodeMatches,
  MAX_INVITES,
  newInviteCode,
  normalizeEmail,
  normalizeInvites,
  RoomCaller,
} from './room-access';
import { buildIceServers } from './ice-servers';
import { RoomInvitations } from './room-invitations';
import { RoomsRepository } from './rooms.repository';

const DEFAULT_MAX_PARTICIPANTS = 5;
/** Hard cap on transcript pulled for the end-of-session report. */
const REPORT_TRANSCRIPT_LIMIT = 500;
/** Hard cap on host lines pulled per turn (a session has a handful, not hundreds). */
const HOST_HISTORY_LIMIT = 100;

export interface Speaker {
  uid: string;
  name?: string;
}

/**
 * Owns room lifecycle and the AI host's business rules. Participants talk by
 * voice; the frontend streams speech-to-text as transcript segments. The host
 * is always in the room: each time it is consulted it listens to the most
 * recent window of the conversation (plus what it already said), decides on
 * its own whether the current topic has been talked about enough and, if so,
 * says a line that moves the group onto a completely different topic. A room
 * has a fixed session length: the gateway's clock calls `expireRoom` when it
 * runs out, and either way the host writes a single room-level report on end.
 *
 * Rooms are invite-only: every caller-facing method enforces `canAccessRoom`
 * (owner + invited emails), writes additionally require having joined, and
 * the invite list / link secret are stripped from what non-owners see.
 *
 * The AI is reached only through the provider-agnostic LlmProvider, and all
 * persistence goes through RoomsRepository — this service never touches
 * Firestore (arch-single-responsibility, arch-use-repository-pattern).
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly facilitator: AppConfig['facilitator'];
  private readonly webrtc: AppConfig['webrtc'];

  constructor(
    private readonly roomsRepository: RoomsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly invitations: RoomInvitations,
    private readonly llm: LlmProvider,
    config: ConfigService<AppConfig, true>,
  ) {
    this.facilitator = config.get('facilitator', { infer: true });
    this.webrtc = config.get('webrtc', { infer: true });
  }

  /**
   * Open a new room. The opening topic comes from the creator or — with
   * `hostPicksTopic` — from the AI host, fetched before anything is persisted.
   */
  async createRoom(ownerId: string, dto: CreateRoomDto): Promise<Room> {
    const topicPickedByHost = dto.hostPicksTopic === true;
    const topic = topicPickedByHost ? await this.pickOpeningTopic() : dto.topic;
    if (!topic) {
      // Unreachable behind the ValidationPipe; keeps the entity invariant if not.
      throw new BadRequestException(
        'topic is required unless hostPicksTopic is true',
      );
    }
    const now = new Date().toISOString();
    const room: Room = {
      id: crypto.randomUUID(),
      topic,
      topicPickedByHost,
      status: 'waiting',
      ownerId: owner.uid,
      participantIds: [owner.uid],
      maxParticipants: dto.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      durationMinutes: dto.durationMinutes ?? DEFAULT_ROOM_DURATION_MINUTES,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.roomsRepository.create(room);
    this.invitations.send(created, owner, created.invitedEmails ?? []);
    return created;
  }

  /**
   * Ask the host for an opening topic. An area is drawn at random so rooms do
   * not all open on the same subject. Fails with 503 if the AI is unavailable
   * or replies unusably — the creator can retry or type a topic themselves;
   * we deliberately never substitute a canned topic for one they asked the
   * host to choose.
   */
  private async pickOpeningTopic(): Promise<string> {
    const area =
      OPENING_TOPIC_AREAS[
        Math.floor(Math.random() * OPENING_TOPIC_AREAS.length)
      ];
    try {
      const { text } = await this.llm.generate(
        buildOpeningTopicPrompt({ area }),
      );
      return parseOpeningTopic(text);
    } catch (error) {
      this.logger.warn(
        `Host could not pick an opening topic: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'The AI host could not pick a topic right now — try again or enter one yourself',
      );
    }
  }

  listOpenRooms(limit: number): Promise<Room[]> {
    return this.roomsRepository.listOpen(limit);
  }

  /**
   * Unfiltered lookup for trusted server-side callers (the gateway). Anything
   * answering a user goes through `getRoomFor` instead.
   */
  async getRoom(id: string): Promise<Room> {
    const room = await this.roomsRepository.findById(id);
    if (!room) {
      throw new NotFoundException(`Room ${id} not found`);
    }
    return room;
  }

  async getRoomFor(id: string, caller: RoomCaller): Promise<Room> {
    return this.viewFor(await this.accessibleRoom(id, caller), caller.uid);
  }

  /**
   * Take a seat. Invitees (and the owner) just join; anyone else must present
   * the room's current invite-link code, which adds their verified email to the
   * invite list so they keep access — and the owner can see and revoke them.
   */
  async joinRoom(
    id: string,
    caller: RoomCaller,
    inviteCode?: string,
  ): Promise<Room> {
    const room = await this.getRoom(id);
    const viaLink = !canAccessRoom(room, caller);
    if (
      viaLink &&
      !(caller.email && inviteCodeMatches(room.inviteCode, inviteCode))
    ) {
      throw new ForbiddenException(NOT_INVITED);
    }

    if (room.status === 'ended') {
      throw new ConflictException('Room has ended');
    }
    // Idempotent: re-joining is a no-op rather than an error.
    if (room.participantIds.includes(caller.uid)) {
      return this.viewFor(room, caller.uid);
    }
    if (room.participantIds.length >= room.maxParticipants) {
      throw new ConflictException('Room is full');
    }

    const changes: Partial<Room> = {
      participantIds: [...room.participantIds, caller.uid],
    };
    if (viaLink) {
      const invitedEmails = normalizeInvites([
        ...(room.invitedEmails ?? []),
        caller.email!,
      ]);
      if (invitedEmails.length > MAX_INVITES) {
        throw new ConflictException('This room’s invite list is full');
      }
      changes.invitedEmails = invitedEmails;
    }
    return this.viewFor(await this.persistUpdate(id, changes), caller.uid);
  }

  async leaveRoom(id: string, caller: RoomCaller): Promise<Room> {
    const room = await this.accessibleRoom(id, caller);
    const updated = await this.persistUpdate(id, {
      participantIds: room.participantIds.filter((p) => p !== caller.uid),
    });
    return this.viewFor(updated, caller.uid);
  }

  /** Owner adds people to the invite list (already-invited ones are ignored). */
  async addInvites(
    id: string,
    owner: RoomCaller,
    emails: string[],
  ): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, owner.uid);
    const invitedEmails = normalizeInvites(
      [...(room.invitedEmails ?? []), ...emails],
      owner.email,
    );
    if (invitedEmails.length > MAX_INVITES) {
      throw new BadRequestException(
        `A room can have at most ${MAX_INVITES} invites`,
      );
    }
    const updated = await this.persistUpdate(id, { invitedEmails });
    // Email only the people who weren't invited before.
    const previously = new Set(room.invitedEmails ?? []);
    this.invitations.send(
      updated,
      owner,
      invitedEmails.filter((email) => !previously.has(email)),
    );
    return updated;
  }

  /**
   * Owner revokes an invite. Whoever signed in with that address also loses
   * their seat, so a revoked person can't keep listening; `removedUids` lets
   * the caller evict their live sockets. Idempotent.
   */
  async revokeInvite(
    id: string,
    ownerUid: string,
    email: string,
  ): Promise<{ room: Room; removedUids: string[] }> {
    const room = await this.getRoom(id);
    this.assertOwner(room, ownerUid);
    const target = normalizeEmail(email);

    // participantIds are uids, so resolve them to emails to find the seat.
    const members = await Promise.all(
      room.participantIds
        .filter((uid) => uid !== room.ownerId)
        .map((uid) => this.usersRepository.findById(uid)),
    );
    const removedUids = members
      .filter(
        (user): user is User => !!user && normalizeEmail(user.email) === target,
      )
      .map((user) => user.id);

    const updated = await this.persistUpdate(id, {
      invitedEmails: (room.invitedEmails ?? []).filter((e) => e !== target),
      participantIds: room.participantIds.filter(
        (uid) => !removedUids.includes(uid),
      ),
    });
    return { room: updated, removedUids };
  }

  /** Mint (or rotate) the invite-link code; a rotation kills links already shared. */
  async createInviteLink(id: string, ownerUid: string): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, ownerUid);
    return this.persistUpdate(id, { inviteCode: newInviteCode() });
  }

  async disableInviteLink(id: string, ownerUid: string): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, ownerUid);
    return this.persistUpdate(id, { inviteCode: null });
  }

  /**
   * Open the session. Only a `waiting` room can start, so the clock can never
   * be restarted (which would extend the session). Stamps `startedAt` and
   * `scheduledEndAt`; the gateway arms the timer that ends the room on time.
   */
  async startRoom(id: string, requesterUid: string): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, requesterUid);
    if (room.status !== 'waiting') {
      throw new ConflictException(
        room.status === 'live' ? 'Room has already started' : 'Room has ended',
      );
    }
    // The host reacts to the conversation, so there is nothing to say until
    // people start talking — just open the room and start the clock.
    const startedAt = new Date();
    // Rooms created before session lengths existed carry no duration.
    const minutes = room.durationMinutes ?? DEFAULT_ROOM_DURATION_MINUTES;
    return this.persistUpdate(id, {
      status: 'live',
      startedAt: startedAt.toISOString(),
      scheduledEndAt: new Date(
        startedAt.getTime() + minutes * 60_000,
      ).toISOString(),
    });
  }

  /** The owner ends the session early (it otherwise ends at `scheduledEndAt`). */
  async endRoom(id: string, requesterUid: string): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, requesterUid);
    return this.finishRoom(room);
  }

  /**
   * Time is up: end a live room on behalf of the clock, with no owner check.
   * Idempotent — returns `null` when the room has already ended (the owner got
   * there first), so nothing is reported or broadcast twice.
   */
  async expireRoom(id: string): Promise<Room | null> {
    const room = await this.getRoom(id);
    if (room.status === 'ended') {
      return null;
    }
    return this.finishRoom(room);
  }

  /** Close the session: write the report (best-effort) and mark the room ended. */
  private async finishRoom(room: Room): Promise<Room> {
    // Best-effort report: ending the room must not fail if the LLM is down.
    let report: RoomReport | undefined;
    try {
      report = await this.generateReport(room);
    } catch (error) {
      this.logger.warn(
        `Report generation failed for room ${room.id}: ${(error as Error).message}`,
      );
    }

    return this.persistUpdate(room.id, {
      status: 'ended',
      endedAt: new Date().toISOString(),
      ...(report ? { report } : {}),
    });
  }

  /** Ingest one voice-transcript segment (from client-side speech-to-text). */
  async addTranscriptSegment(
    id: string,
    speaker: Speaker & RoomCaller,
    text: string,
  ): Promise<TranscriptSegment> {
    await this.participantRoom(id, speaker);
    return this.saveTranscriptSegment(
      this.buildTranscriptSegment(id, speaker, text),
    );
  }

  /**
   * Stamp a segment without touching storage, so the realtime gateway can fan
   * it out at socket latency and persist it afterwards via
   * `saveTranscriptSegment`. Callers are responsible for authorizing the room.
   */
  buildTranscriptSegment(
    roomId: string,
    speaker: Speaker,
    text: string,
  ): TranscriptSegment {
    return {
      id: crypto.randomUUID(),
      roomId,
      speakerId: speaker.uid,
      speakerName: speaker.name,
      text,
      at: new Date().toISOString(),
    };
  }

  saveTranscriptSegment(
    segment: TranscriptSegment,
  ): Promise<TranscriptSegment> {
    return this.roomsRepository.addSegment(segment);
  }

  /**
   * Manual override: the host speaks now regardless of its own judgement. Used
   * when a participant asks for a fresh topic (e.g. they did not like the
   * current one).
   */
  async forceTopicChange(id: string): Promise<HostMessage> {
    const turn = await this.hostTurn(id, 'manual');
    return this.persistHostMessage(id, 'manual', turn);
  }

  /**
   * Auto path: consult the host and let it judge, from the live conversation,
   * whether now is the moment to step in. Returns the persisted line only when
   * it speaks; otherwise `null` — it stays quiet while talk is flowing.
   */
  async consultHost(
    id: string,
    trigger: HostTrigger,
  ): Promise<HostMessage | null> {
    const turn = await this.hostTurn(id, trigger);
    if (!turn.shouldSpeak) {
      return null;
    }
    return this.persistHostMessage(id, trigger, turn);
  }

  /** One host turn: listen to the recent window (and its own past lines), then decide. */
  private async hostTurn(id: string, trigger: HostTrigger): Promise<HostTurn> {
    const room = await this.getRoom(id);
    const [transcript, hostMessages] = await Promise.all([
      this.roomsRepository.listRecentSegments(
        id,
        this.facilitator.contextSegments,
      ),
      this.roomsRepository.listHostMessages(id, HOST_HISTORY_LIMIT),
    ]);
    const { text } = await this.llm.generate(
      buildHostPrompt({
        seedTopic: room.topic,
        transcript,
        hostMessages,
        trigger,
      }),
    );
    return parseHostTurn(text);
  }

  private persistHostMessage(
    roomId: string,
    trigger: HostTrigger,
    turn: HostTurn,
  ): Promise<HostMessage> {
    return this.roomsRepository.addHostMessage({
      id: crypto.randomUUID(),
      roomId,
      message: turn.message,
      topic: turn.topic,
      reason: turn.reason,
      trigger,
      at: new Date().toISOString(),
    });
  }

  /**
   * ICE servers for the caller's voice mesh in this room. Seat holders only: the
   * TURN credential lets its holder relay traffic through our server.
   */
  async iceServersFor(id: string, caller: RoomCaller): Promise<IceServers> {
    await this.participantRoom(id, caller);
    return {
      iceServers: buildIceServers(this.webrtc, caller.uid, Date.now()),
      ttlSeconds: this.webrtc.turnCredentialTtlSeconds,
    };
  }

  /**
   * Manual "suggest a topic": the host steers the conversation, so only the
   * owner may ask (it also spends LLM budget). Everyone else gets the automatic
   * volume/silence nudges.
   */
  async suggestTopicFor(
    id: string,
    caller: RoomCaller,
  ): Promise<TopicSuggestion> {
    const room = await this.getRoom(id);
    this.assertOwner(room, caller.uid);
    if (room.status === 'ended') {
      throw new ConflictException('Room has ended');
    }
    return this.generateTopicSuggestion(id, 'manual');
  }

  async listTranscript(
    id: string,
    caller: RoomCaller,
    limit: number,
  ): Promise<TranscriptSegment[]> {
    await this.accessibleRoom(id, caller);
    return this.roomsRepository.listSegments(id, limit);
  }

  listHostMessages(id: string, limit: number): Promise<HostMessage[]> {
    return this.roomsRepository.listHostMessages(id, limit);
  }

  private async generateReport(room: Room): Promise<RoomReport> {
    const [transcript, hostMessages] = await Promise.all([
      this.roomsRepository.listSegments(room.id, REPORT_TRANSCRIPT_LIMIT),
      this.roomsRepository.listHostMessages(room.id, HOST_HISTORY_LIMIT),
    ]);
    const { text } = await this.llm.generate(
      buildReportPrompt({ seedTopic: room.topic, transcript, hostMessages }),
    );
    return { ...parseReport(text), generatedAt: new Date().toISOString() };
  }

  /** The room, if the caller may see it (owner or invitee); 403 otherwise. */
  private async accessibleRoom(id: string, caller: RoomCaller): Promise<Room> {
    const room = await this.getRoom(id);
    if (!canAccessRoom(room, caller)) {
      throw new ForbiddenException(NOT_INVITED);
    }
    return room;
  }

  /** The room, if the caller may see it *and* has taken a seat in it. */
  private async participantRoom(id: string, caller: RoomCaller): Promise<Room> {
    const room = await this.accessibleRoom(id, caller);
    if (!room.participantIds.includes(caller.uid)) {
      throw new ForbiddenException('Join the room first');
    }
    return room;
  }

  /** Owner-only fields (invite list, link secret) are hidden from everyone else. */
  private viewFor(room: Room, uid: string): Room {
    if (room.ownerId === uid) {
      return room;
    }
    const view = { ...room };
    delete view.invitedEmails;
    delete view.inviteCode;
    return view;
  }

  private assertOwner(room: Room, requesterUid: string): void {
    if (room.ownerId !== requesterUid) {
      throw new ForbiddenException(
        'Only the room owner may perform this action',
      );
    }
  }

  private async persistUpdate(
    id: string,
    changes: Partial<Omit<Room, 'id' | 'createdAt'>>,
  ): Promise<Room> {
    const updated = await this.roomsRepository.update(id, {
      ...changes,
      updatedAt: new Date().toISOString(),
    });
    if (!updated) {
      throw new NotFoundException(`Room ${id} not found`);
    }
    return updated;
  }
}
