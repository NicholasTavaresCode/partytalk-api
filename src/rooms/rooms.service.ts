import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '../ai/llm-provider';
import { AppConfig } from '../config/configuration';
import { CreateRoomDto } from './dto/create-room.dto';
import { IceServers } from './entities/ice-servers.entity';
import { Room } from './entities/room.entity';
import { RoomReport } from './entities/room-report.entity';
import {
  SuggestionTrigger,
  TopicSuggestion,
} from './entities/topic-suggestion.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import {
  buildReportPrompt,
  buildTopicSuggestionPrompt,
  parseReport,
  parseSuggestion,
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

const DEFAULT_FACILITATOR_PERSONA =
  'A warm, curious facilitator who nudges the group toward fresh, related topics';
const DEFAULT_MAX_PARTICIPANTS = 5;
/** Hard cap on transcript pulled for the end-of-session report. */
const REPORT_TRANSCRIPT_LIMIT = 500;
const NOT_INVITED = 'You are not invited to this room';

export interface Speaker {
  uid: string;
  name?: string;
}

/**
 * Owns room lifecycle and the AI-facilitator business rules. Participants talk
 * by voice; the frontend streams speech-to-text as transcript segments. This
 * service persists that transcript, generates topic-pivot suggestions from a
 * rolling window, and writes a single room-level report when the session ends.
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

  async createRoom(owner: RoomCaller, dto: CreateRoomDto): Promise<Room> {
    const now = new Date().toISOString();
    const room: Room = {
      id: crypto.randomUUID(),
      topic: dto.topic,
      facilitatorPersona: dto.facilitatorPersona ?? DEFAULT_FACILITATOR_PERSONA,
      status: 'waiting',
      ownerId: owner.uid,
      participantIds: [owner.uid],
      maxParticipants: dto.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      invitedEmails: normalizeInvites(dto.invitedEmails ?? [], owner.email),
      inviteCode: null,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.roomsRepository.create(room);
    this.invitations.send(created, owner, created.invitedEmails ?? []);
    return created;
  }

  /** Open rooms the caller owns or is invited to — strangers' rooms never list. */
  async listRoomsFor(caller: RoomCaller, limit: number): Promise<Room[]> {
    const rooms = await this.roomsRepository.listOpenForMember(
      caller.uid,
      caller.email ? normalizeEmail(caller.email) : undefined,
      limit,
    );
    return rooms.map((room) => this.viewFor(room, caller.uid));
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

  async startRoom(id: string, requesterUid: string): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, requesterUid);
    // The facilitator reacts to the conversation, so there is nothing to say
    // until people start talking — just open the room.
    return this.persistUpdate(id, { status: 'live' });
  }

  async endRoom(id: string, requesterUid: string): Promise<Room> {
    const room = await this.getRoom(id);
    this.assertOwner(room, requesterUid);

    // Best-effort report: ending the room must not fail if the LLM is down.
    let report: RoomReport | undefined;
    try {
      report = await this.generateReport(room);
    } catch (error) {
      this.logger.warn(
        `Report generation failed for room ${id}: ${(error as Error).message}`,
      );
    }

    return this.persistUpdate(id, {
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
   * Read the recent transcript window and ask the model for one new, related
   * topic that pushes the group's versatility; persist and return it.
   */
  async generateTopicSuggestion(
    id: string,
    trigger: SuggestionTrigger,
  ): Promise<TopicSuggestion> {
    const room = await this.getRoom(id);
    const transcript = await this.roomsRepository.listSegments(
      id,
      this.facilitator.contextSegments,
    );

    const { text } = await this.llm.generate(
      buildTopicSuggestionPrompt({
        persona: room.facilitatorPersona,
        seedTopic: room.topic,
        transcript,
      }),
    );
    const { topic, rationale } = parseSuggestion(text);

    return this.roomsRepository.addSuggestion({
      id: crypto.randomUUID(),
      roomId: id,
      topic,
      rationale,
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

  async listSuggestions(
    id: string,
    caller: RoomCaller,
    limit: number,
  ): Promise<TopicSuggestion[]> {
    await this.accessibleRoom(id, caller);
    return this.roomsRepository.listSuggestions(id, limit);
  }

  /** How many segments a room has — used by the gateway's volume trigger. */
  countSegments(id: string): Promise<number> {
    return this.roomsRepository.countSegments(id);
  }

  private async generateReport(room: Room): Promise<RoomReport> {
    const transcript = await this.roomsRepository.listSegments(
      room.id,
      REPORT_TRANSCRIPT_LIMIT,
    );
    const { text } = await this.llm.generate(
      buildReportPrompt({ seedTopic: room.topic, transcript }),
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
