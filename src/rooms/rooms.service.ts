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
 * The AI is reached only through the provider-agnostic LlmProvider, and all
 * persistence goes through RoomsRepository — this service never touches
 * Firestore (arch-single-responsibility, arch-use-repository-pattern).
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly facilitator: AppConfig['facilitator'];

  constructor(
    private readonly roomsRepository: RoomsRepository,
    private readonly llm: LlmProvider,
    config: ConfigService<AppConfig, true>,
  ) {
    this.facilitator = config.get('facilitator', { infer: true });
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
      ownerId,
      participantIds: [ownerId],
      maxParticipants: dto.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      durationMinutes: dto.durationMinutes ?? DEFAULT_ROOM_DURATION_MINUTES,
      createdAt: now,
      updatedAt: now,
    };
    return this.roomsRepository.create(room);
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

  async getRoom(id: string): Promise<Room> {
    const room = await this.roomsRepository.findById(id);
    if (!room) {
      throw new NotFoundException(`Room ${id} not found`);
    }
    return room;
  }

  async joinRoom(id: string, uid: string): Promise<Room> {
    const room = await this.getRoom(id);

    if (room.status === 'ended') {
      throw new ConflictException('Room has ended');
    }
    // Idempotent: re-joining is a no-op rather than an error.
    if (room.participantIds.includes(uid)) {
      return room;
    }
    if (room.participantIds.length >= room.maxParticipants) {
      throw new ConflictException('Room is full');
    }

    return this.persistUpdate(id, {
      participantIds: [...room.participantIds, uid],
    });
  }

  async leaveRoom(id: string, uid: string): Promise<Room> {
    const room = await this.getRoom(id);
    return this.persistUpdate(id, {
      participantIds: room.participantIds.filter((p) => p !== uid),
    });
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
    speaker: Speaker,
    text: string,
  ): Promise<TranscriptSegment> {
    // Ensure the room exists before persisting.
    await this.getRoom(id);
    return this.roomsRepository.addSegment({
      id: crypto.randomUUID(),
      roomId: id,
      speakerId: speaker.uid,
      speakerName: speaker.name,
      text,
      at: new Date().toISOString(),
    });
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

  listTranscript(id: string, limit: number): Promise<TranscriptSegment[]> {
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
