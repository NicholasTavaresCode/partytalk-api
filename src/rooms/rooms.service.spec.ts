import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LlmProvider } from '../ai/llm-provider';
import { Room } from './entities/room.entity';
import { TopicSuggestion } from './entities/topic-suggestion.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { RoomsRepository } from './rooms.repository';
import { RoomsService } from './rooms.service';

class InMemoryRoomsRepository extends RoomsRepository {
  rooms = new Map<string, Room>();
  segments: TranscriptSegment[] = [];
  suggestions: TopicSuggestion[] = [];

  async findById(id: string) {
    return this.rooms.get(id) ?? null;
  }
  async create(room: Room) {
    this.rooms.set(room.id, room);
    return room;
  }
  async update(id: string, changes: Partial<Omit<Room, 'id' | 'createdAt'>>) {
    const existing = this.rooms.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...changes } as Room;
    this.rooms.set(id, updated);
    return updated;
  }
  async delete(id: string) {
    this.rooms.delete(id);
  }
  async listOpen(limit: number) {
    return [...this.rooms.values()]
      .filter((r) => r.status !== 'ended')
      .slice(0, limit);
  }
  async addSegment(segment: TranscriptSegment) {
    this.segments.push(segment);
    return segment;
  }
  async listSegments(roomId: string, limit: number) {
    return this.segments.filter((s) => s.roomId === roomId).slice(0, limit);
  }
  async countSegments(roomId: string) {
    return this.segments.filter((s) => s.roomId === roomId).length;
  }
  async addSuggestion(suggestion: TopicSuggestion) {
    this.suggestions.push(suggestion);
    return suggestion;
  }
  async listSuggestions(roomId: string, limit: number) {
    return this.suggestions.filter((s) => s.roomId === roomId).slice(0, limit);
  }
}

describe('RoomsService', () => {
  let service: RoomsService;
  let repo: InMemoryRoomsRepository;
  let llm: { generate: jest.Mock };

  const OWNER = 'owner-1';

  beforeEach(async () => {
    llm = { generate: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoomsService,
        { provide: RoomsRepository, useClass: InMemoryRoomsRepository },
        { provide: LlmProvider, useValue: llm },
        {
          provide: ConfigService,
          useValue: {
            get: () => ({
              suggestEverySegments: 8,
              silenceMs: 25_000,
              contextSegments: 25,
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(RoomsService);
    repo = moduleRef.get(RoomsRepository);
  });

  const createLiveRoom = async (): Promise<Room> => {
    const room = await service.createRoom(OWNER, { topic: 'Weekend plans' });
    return service.startRoom(room.id, OWNER);
  };

  describe('createRoom', () => {
    it('creates a waiting room owned by the caller with a default persona', async () => {
      const room = await service.createRoom(OWNER, { topic: 'Weekend plans' });
      expect(room.status).toBe('waiting');
      expect(room.ownerId).toBe(OWNER);
      expect(room.participantIds).toEqual([OWNER]);
      expect(room.facilitatorPersona).toBeTruthy();
      expect(room.createdAt).toEqual(room.updatedAt);
    });
  });

  describe('joinRoom', () => {
    it('is idempotent and rejects joining a full room', async () => {
      const room = await service.createRoom(OWNER, {
        topic: 'Weekend plans',
        maxParticipants: 2,
      });
      await service.joinRoom(room.id, OWNER); // already in — no dup
      const joined = await service.joinRoom(room.id, 'user-2');
      expect(joined.participantIds).toEqual([OWNER, 'user-2']);
      await expect(service.joinRoom(room.id, 'user-3')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('startRoom', () => {
    it('only the owner may start the room', async () => {
      const room = await service.createRoom(OWNER, { topic: 'Weekend plans' });
      await expect(service.startRoom(room.id, 'intruder')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('transitions to live without calling the LLM', async () => {
      const room = await createLiveRoom();
      expect(room.status).toBe('live');
      expect(llm.generate).not.toHaveBeenCalled();
    });
  });

  describe('addTranscriptSegment', () => {
    it('persists a segment attributed to the speaker', async () => {
      const room = await createLiveRoom();
      const seg = await service.addTranscriptSegment(
        room.id,
        { uid: 'user-2', name: 'Bo' },
        'I want to visit the coast.',
      );
      expect(seg.roomId).toBe(room.id);
      expect(seg.speakerId).toBe('user-2');
      expect(seg.speakerName).toBe('Bo');
      expect(seg.text).toBe('I want to visit the coast.');
      expect(seg.id).toBeTruthy();
      expect(await repo.countSegments(room.id)).toBe(1);
    });

    it('rejects segments for a missing room', async () => {
      await expect(
        service.addTranscriptSegment('nope', { uid: 'u' }, 'hi'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('generateTopicSuggestion', () => {
    it('asks the model for JSON, parses it, and persists the suggestion', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(room.id, { uid: 'u2' }, 'I love surfing.');
      llm.generate.mockResolvedValue({
        text: '{"topic":"Dream coastlines","rationale":"builds on surfing"}',
      });

      const suggestion = await service.generateTopicSuggestion(room.id, 'volume');

      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ json: true }),
      );
      expect(suggestion.topic).toBe('Dream coastlines');
      expect(suggestion.rationale).toBe('builds on surfing');
      expect(suggestion.trigger).toBe('volume');
      expect(await repo.listSuggestions(room.id, 10)).toHaveLength(1);
    });
  });

  describe('endRoom', () => {
    it('only the owner may end the room', async () => {
      const room = await createLiveRoom();
      await expect(service.endRoom(room.id, 'intruder')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('generates a room-level report and marks the room ended', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(room.id, { uid: 'u2' }, 'I love surfing.');
      llm.generate.mockResolvedValue({
        text: '{"summary":"Lively chat","highlights":["good vocab"],"suggestions":["past tense"],"topicsExplored":["travel"]}',
      });

      const ended = await service.endRoom(room.id, OWNER);

      expect(ended.status).toBe('ended');
      expect(ended.endedAt).toBeTruthy();
      expect(ended.report?.summary).toBe('Lively chat');
      expect(ended.report?.highlights).toEqual(['good vocab']);
      expect(ended.report?.generatedAt).toBeTruthy();
    });

    it('still ends the room if report generation fails', async () => {
      const room = await createLiveRoom();
      llm.generate.mockRejectedValue(new Error('LLM down'));

      const ended = await service.endRoom(room.id, OWNER);

      expect(ended.status).toBe('ended');
      expect(ended.report).toBeUndefined();
    });
  });

  describe('getRoom', () => {
    it('throws NotFound for an unknown room', async () => {
      await expect(service.getRoom('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
