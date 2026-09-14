import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LlmProvider } from '../ai/llm-provider';
import { HostMessage } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { OPENING_TOPIC_AREAS } from './facilitator/facilitator-prompts';
import { RoomsRepository } from './rooms.repository';
import { RoomsService } from './rooms.service';

class InMemoryRoomsRepository extends RoomsRepository {
  rooms = new Map<string, Room>();
  segments: TranscriptSegment[] = [];
  hostMessages: HostMessage[] = [];

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
  async listRecentSegments(roomId: string, limit: number) {
    const all = this.segments.filter((s) => s.roomId === roomId);
    return all.slice(Math.max(0, all.length - limit));
  }
  async addHostMessage(message: HostMessage) {
    this.hostMessages.push(message);
    return message;
  }
  async listHostMessages(roomId: string, limit: number) {
    return this.hostMessages.filter((m) => m.roomId === roomId).slice(0, limit);
  }
}

const SPEAK = (message: string, topic: string) =>
  JSON.stringify({ shouldSpeak: true, message, topic, reason: 'time to move' });
const STAY_QUIET = JSON.stringify({
  shouldSpeak: false,
  message: 'unused',
  topic: 'unused',
  reason: 'talk is flowing',
});

describe('RoomsService', () => {
  let service: RoomsService;
  let repo: InMemoryRoomsRepository;
  let llm: { generate: jest.Mock };

  const OWNER = 'owner-1';

  const build = async (contextSegments = 25): Promise<void> => {
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
              contextSegments,
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(RoomsService);
    repo = moduleRef.get(RoomsRepository);
  };

  beforeEach(() => build());

  const createLiveRoom = async (): Promise<Room> => {
    const room = await service.createRoom(OWNER, { topic: 'Weekend plans' });
    return service.startRoom(room.id, OWNER);
  };

  /** The user-message content of the last prompt sent to the model. */
  const lastPromptContent = (): string =>
    llm.generate.mock.calls.at(-1)?.[0].messages[0].content;

  describe('createRoom', () => {
    it('creates a waiting room owned by the caller', async () => {
      const room = await service.createRoom(OWNER, { topic: 'Weekend plans' });
      expect(room.status).toBe('waiting');
      expect(room.ownerId).toBe(OWNER);
      expect(room.participantIds).toEqual([OWNER]);
      expect(room.durationMinutes).toBe(30);
      expect(room.createdAt).toEqual(room.updatedAt);
    });

    it('stores the chosen session length', async () => {
      const room = await service.createRoom(OWNER, {
        topic: 'Weekend plans',
        durationMinutes: 15,
      });
      expect(room.durationMinutes).toBe(15);
    });

    it('does not consult the host when the creator picks the topic', async () => {
      const room = await service.createRoom(OWNER, { topic: 'Weekend plans' });
      expect(room.topicPickedByHost).toBe(false);
      expect(llm.generate).not.toHaveBeenCalled();
    });

    it('lets the AI host pick the opening topic when asked', async () => {
      llm.generate.mockResolvedValue({
        text: '{"topic":"The Usain Bolt 100m record"}',
      });

      const room = await service.createRoom(OWNER, { hostPicksTopic: true });

      expect(room.topic).toBe('The Usain Bolt 100m record');
      expect(room.topicPickedByHost).toBe(true);
      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ json: true }),
      );
      const content = lastPromptContent();
      expect(OPENING_TOPIC_AREAS.some((area) => content.includes(area))).toBe(
        true,
      );
      expect(await repo.findById(room.id)).not.toBeNull();
    });

    it('ignores a creator topic when the host picks', async () => {
      llm.generate.mockResolvedValue({ text: '{"topic":"The movie Titanic"}' });

      const room = await service.createRoom(OWNER, {
        hostPicksTopic: true,
        topic: 'Weekend plans',
      });

      expect(room.topic).toBe('The movie Titanic');
    });

    it('fails with 503 and creates nothing when the host cannot pick', async () => {
      llm.generate.mockRejectedValue(new Error('LLM down'));

      await expect(
        service.createRoom(OWNER, { hostPicksTopic: true }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(repo.rooms.size).toBe(0);
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

    it('starts the clock: stamps startedAt and scheduledEndAt from the session length', async () => {
      const room = await service.createRoom(OWNER, {
        topic: 'Weekend plans',
        durationMinutes: 45,
      });

      const live = await service.startRoom(room.id, OWNER);

      expect(live.startedAt).toBeTruthy();
      expect(
        new Date(live.scheduledEndAt ?? '').getTime() -
          new Date(live.startedAt ?? '').getTime(),
      ).toBe(45 * 60_000);
    });

    it('refuses to start a room twice (that would extend the session)', async () => {
      const room = await createLiveRoom();
      await expect(service.startRoom(room.id, OWNER)).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses to start an ended room', async () => {
      const room = await createLiveRoom();
      llm.generate.mockResolvedValue({ text: '{"summary":"ok"}' });
      await service.endRoom(room.id, OWNER);
      await expect(service.startRoom(room.id, OWNER)).rejects.toThrow(
        ConflictException,
      );
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
      expect(await repo.listSegments(room.id, 10)).toHaveLength(1);
    });

    it('rejects segments for a missing room', async () => {
      await expect(
        service.addTranscriptSegment('nope', { uid: 'u' }, 'hi'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('forceTopicChange (manual override)', () => {
    it('makes the host speak even when it would have stayed quiet', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(
        room.id,
        { uid: 'u2' },
        'I love surfing.',
      );
      llm.generate.mockResolvedValue({
        text: JSON.stringify({
          shouldSpeak: false,
          message: "Ok. Now let's talk about the Usain Bolt record.",
          topic: 'The Usain Bolt record',
          reason: 'asked for a change',
        }),
      });

      const said = await service.forceTopicChange(room.id);

      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ json: true }),
      );
      expect(lastPromptContent()).toContain('asked you to change the topic');
      expect(said.message).toBe(
        "Ok. Now let's talk about the Usain Bolt record.",
      );
      expect(said.topic).toBe('The Usain Bolt record');
      expect(said.reason).toBe('asked for a change');
      expect(said.trigger).toBe('manual');
      expect(said.roomId).toBe(room.id);
      expect(await repo.listHostMessages(room.id, 10)).toHaveLength(1);
    });
  });

  describe('consultHost (auto)', () => {
    it('persists and returns the line when the host decides to step in', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(room.id, { uid: 'u2' }, '...');
      llm.generate.mockResolvedValue({
        text: SPEAK(
          "All right. Let's talk about the incredible movie Titanic.",
          'The movie Titanic',
        ),
      });

      const said = await service.consultHost(room.id, 'silence');

      expect(said).not.toBeNull();
      expect(said?.message).toBe(
        "All right. Let's talk about the incredible movie Titanic.",
      );
      expect(said?.topic).toBe('The movie Titanic');
      expect(said?.trigger).toBe('silence');
      expect(await repo.listHostMessages(room.id, 10)).toHaveLength(1);
    });

    it('returns null and persists nothing when the host stays quiet', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(
        room.id,
        { uid: 'u2' },
        'Great point!',
      );
      llm.generate.mockResolvedValue({ text: STAY_QUIET });

      const said = await service.consultHost(room.id, 'volume');

      expect(said).toBeNull();
      expect(await repo.listHostMessages(room.id, 10)).toHaveLength(0);
    });

    it('listens to the MOST RECENT segments, not the first ones', async () => {
      await build(2); // the host only hears the last two utterances
      const room = await createLiveRoom();
      for (const text of ['first thing', 'second thing', 'third thing']) {
        await service.addTranscriptSegment(room.id, { uid: 'u2' }, text);
      }
      llm.generate.mockResolvedValue({ text: STAY_QUIET });

      await service.consultHost(room.id, 'volume');

      const content = lastPromptContent();
      expect(content).toContain('second thing');
      expect(content).toContain('third thing');
      expect(content).not.toContain('first thing');
    });

    it('reminds the host what it already said so it never reuses a topic', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(room.id, { uid: 'u2' }, 'Hi all.');
      llm.generate.mockResolvedValue({
        text: SPEAK(
          "Ok. Now let's talk about the Usain Bolt record.",
          'The Usain Bolt record',
        ),
      });
      await service.consultHost(room.id, 'volume');
      await service.addTranscriptSegment(
        room.id,
        { uid: 'u2' },
        'He ran 9.58!',
      );
      llm.generate.mockResolvedValue({ text: STAY_QUIET });

      await service.consultHost(room.id, 'volume');

      const content = lastPromptContent();
      expect(content).toContain(
        "Host (you): Ok. Now let's talk about the Usain Bolt record.",
      );
      expect(content).toContain('Current topic: "The Usain Bolt record"');
      expect(content).toContain('"Weekend plans", "The Usain Bolt record"');
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
      await service.addTranscriptSegment(
        room.id,
        { uid: 'u2' },
        'I love surfing.',
      );
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

    it("feeds the host's topic changes into the report", async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(room.id, { uid: 'u2' }, 'Hi all.');
      llm.generate.mockResolvedValue({
        text: SPEAK("Ok. Now let's talk about Titanic.", 'Titanic'),
      });
      await service.consultHost(room.id, 'volume');
      llm.generate.mockResolvedValue({ text: '{"summary":"ok"}' });

      await service.endRoom(room.id, OWNER);

      expect(lastPromptContent()).toContain(
        "Host: Ok. Now let's talk about Titanic.",
      );
    });

    it('still ends the room if report generation fails', async () => {
      const room = await createLiveRoom();
      llm.generate.mockRejectedValue(new Error('LLM down'));

      const ended = await service.endRoom(room.id, OWNER);

      expect(ended.status).toBe('ended');
      expect(ended.report).toBeUndefined();
    });
  });

  describe('expireRoom (time is up)', () => {
    it('ends a live room with a report, with no owner involved', async () => {
      const room = await createLiveRoom();
      llm.generate.mockResolvedValue({ text: '{"summary":"Time flew"}' });

      const ended = await service.expireRoom(room.id);

      expect(ended?.status).toBe('ended');
      expect(ended?.endedAt).toBeTruthy();
      expect(ended?.report?.summary).toBe('Time flew');
    });

    it('is a no-op when the owner already ended the room', async () => {
      const room = await createLiveRoom();
      llm.generate.mockResolvedValue({ text: '{"summary":"ok"}' });
      await service.endRoom(room.id, OWNER);
      llm.generate.mockClear();

      expect(await service.expireRoom(room.id)).toBeNull();
      expect(llm.generate).not.toHaveBeenCalled();
    });
  });

  describe('getRoom', () => {
    it('throws NotFound for an unknown room', async () => {
      await expect(service.getRoom('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
