import {
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
import { RoomsRepository } from './rooms.repository';

const DEFAULT_FACILITATOR_PERSONA =
  'A warm, curious facilitator who nudges the group toward fresh, related topics';
const DEFAULT_MAX_PARTICIPANTS = 5;
/** Hard cap on transcript pulled for the end-of-session report. */
const REPORT_TRANSCRIPT_LIMIT = 500;

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

  async createRoom(ownerId: string, dto: CreateRoomDto): Promise<Room> {
    const now = new Date().toISOString();
    const room: Room = {
      id: crypto.randomUUID(),
      topic: dto.topic,
      facilitatorPersona: dto.facilitatorPersona ?? DEFAULT_FACILITATOR_PERSONA,
      status: 'waiting',
      ownerId,
      participantIds: [ownerId],
      maxParticipants: dto.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      createdAt: now,
      updatedAt: now,
    };
    return this.roomsRepository.create(room);
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

  listTranscript(id: string, limit: number): Promise<TranscriptSegment[]> {
    return this.roomsRepository.listSegments(id, limit);
  }

  listSuggestions(id: string, limit: number): Promise<TopicSuggestion[]> {
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
