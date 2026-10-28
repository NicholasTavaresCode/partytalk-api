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
import { User } from '../users/entities/user.entity';
import { UsersRepository } from '../users/users.repository';
import { RoomCaller } from './room-access';
import { RoomInvitations } from './room-invitations';
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
  async listOpenForMember(
    uid: string,
    email: string | undefined,
    limit: number,
  ) {
    return [...this.rooms.values()]
      .filter((r) => r.status !== 'ended')
      .filter(
        (r) =>
          r.ownerId === uid || (!!email && !!r.invitedEmails?.includes(email)),
      )
      .slice(0, limit);
  }
  async addSegment(segment: TranscriptSegment) {
    this.segments.push(segment);
    return segment;
  }
  // Same contract as Firestore: the most recent `limit`, oldest first.
  async listSegments(roomId: string, limit: number) {
    return this.segments.filter((s) => s.roomId === roomId).slice(-limit);
  }
  async countSegments(roomId: string) {
    return this.segments.filter((s) => s.roomId === roomId).length;
  }
  async addSuggestion(suggestion: TopicSuggestion) {
    this.suggestions.push(suggestion);
    return suggestion;
  }
  async listSuggestions(roomId: string, limit: number) {
    return this.suggestions.filter((s) => s.roomId === roomId).slice(-limit);
  }
}

/** Users keyed by uid — just enough for revokeInvite's uid → email lookup. */
class InMemoryUsersRepository extends UsersRepository {
  users = new Map<string, User>();
  async findById(id: string) {
    return this.users.get(id) ?? null;
  }
  async create(user: User) {
    this.users.set(user.id, user);
    return user;
  }
  async update() {
    return null;
  }
  async delete() {}
}

describe('RoomsService', () => {
  let service: RoomsService;
  let repo: InMemoryRoomsRepository;
  let users: InMemoryUsersRepository;
  let llm: { generate: jest.Mock };
  let invitations: { send: jest.Mock };

  const OWNER = 'owner-1';
  const OWNER_CALLER: RoomCaller = { uid: OWNER, email: 'owner@example.com' };
  const BO: RoomCaller = { uid: 'user-2', email: 'bo@example.com' };
  const CY: RoomCaller = { uid: 'user-3', email: 'cy@example.com' };

  beforeEach(async () => {
    llm = { generate: jest.fn() };
    invitations = { send: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoomsService,
        { provide: RoomsRepository, useClass: InMemoryRoomsRepository },
        { provide: UsersRepository, useClass: InMemoryUsersRepository },
        { provide: RoomInvitations, useValue: invitations },
        { provide: LlmProvider, useValue: llm },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'webrtc'
                ? {
                    stunUrls: ['stun:stun.example:3478'],
                    turnUrls: ['turn:203.0.113.7:3478'],
                    turnSecret: 's3cret',
                    turnCredentialTtlSeconds: 3600,
                  }
                : {
                    suggestEverySegments: 8,
                    silenceMs: 25_000,
                    contextSegments: 25,
                  },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(RoomsService);
    repo = moduleRef.get(RoomsRepository);
    users = moduleRef.get(UsersRepository);
  });

  const createLiveRoom = async (): Promise<Room> => {
    const room = await service.createRoom(OWNER_CALLER, {
      topic: 'Weekend plans',
    });
    return service.startRoom(room.id, OWNER);
  };

  describe('createRoom', () => {
    it('creates a waiting room owned by the caller with a default persona', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Weekend plans',
      });
      expect(room.status).toBe('waiting');
      expect(room.ownerId).toBe(OWNER);
      expect(room.participantIds).toEqual([OWNER]);
      expect(room.facilitatorPersona).toBeTruthy();
      expect(room.createdAt).toEqual(room.updatedAt);
      expect(room.invitedEmails).toEqual([]);
      expect(room.inviteCode).toBeNull();
    });

    it('normalizes the invite list and leaves the owner off it', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Weekend plans',
        invitedEmails: [
          'Bo@Example.com',
          'bo@example.com',
          'OWNER@example.com',
        ],
      });
      expect(room.invitedEmails).toEqual(['bo@example.com']);
    });
  });

  describe('joinRoom', () => {
    it('is idempotent and rejects joining a full room', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Weekend plans',
        maxParticipants: 2,
        invitedEmails: [BO.email!, CY.email!],
      });
      await service.joinRoom(room.id, OWNER_CALLER); // already in — no dup
      const joined = await service.joinRoom(room.id, BO);
      expect(joined.participantIds).toEqual([OWNER, BO.uid]);
      await expect(service.joinRoom(room.id, CY)).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses anyone not invited', async () => {
      const room = await service.createRoom(OWNER_CALLER, { topic: 'Plans' });
      await expect(service.joinRoom(room.id, BO)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('hides the invite list and link code from non-owners', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: [BO.email!],
      });
      await service.createInviteLink(room.id, OWNER);
      const joined = await service.joinRoom(room.id, BO);
      expect(joined).not.toHaveProperty('invitedEmails');
      expect(joined).not.toHaveProperty('inviteCode');
    });
  });

  describe('invite link', () => {
    it('admits a stranger holding the current code and invites their email', async () => {
      const room = await service.createRoom(OWNER_CALLER, { topic: 'Plans' });
      const { inviteCode } = await service.createInviteLink(room.id, OWNER);

      await service.joinRoom(room.id, CY, inviteCode!);

      const stored = await service.getRoomFor(room.id, OWNER_CALLER);
      expect(stored.participantIds).toContain(CY.uid);
      expect(stored.invitedEmails).toEqual([CY.email]);
    });

    it('rejects a wrong, rotated or disabled code', async () => {
      const room = await service.createRoom(OWNER_CALLER, { topic: 'Plans' });
      const first = (await service.createInviteLink(room.id, OWNER))
        .inviteCode!;
      await expect(service.joinRoom(room.id, CY, 'nope')).rejects.toThrow(
        ForbiddenException,
      );

      await service.createInviteLink(room.id, OWNER); // rotate
      await expect(service.joinRoom(room.id, CY, first)).rejects.toThrow(
        ForbiddenException,
      );

      const { inviteCode } = await service.createInviteLink(room.id, OWNER);
      await service.disableInviteLink(room.id, OWNER);
      await expect(service.joinRoom(room.id, CY, inviteCode!)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('only the owner may manage the link', async () => {
      const room = await service.createRoom(OWNER_CALLER, { topic: 'Plans' });
      await expect(service.createInviteLink(room.id, BO.uid)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('invites', () => {
    it('lets the owner add invitees, who can then see the room', async () => {
      const room = await service.createRoom(OWNER_CALLER, { topic: 'Plans' });
      await expect(service.getRoomFor(room.id, BO)).rejects.toThrow(
        ForbiddenException,
      );

      await service.addInvites(room.id, OWNER_CALLER, ['BO@example.com']);

      await expect(service.getRoomFor(room.id, BO)).resolves.toMatchObject({
        id: room.id,
      });
      await expect(
        service.addInvites(room.id, BO, ['cy@example.com']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('revoking an invite also takes away the person’s seat', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: [BO.email!],
      });
      await users.create({
        id: BO.uid,
        email: 'Bo@example.com',
        status: 'active',
        createdAt: 't',
        updatedAt: 't',
      });
      await service.joinRoom(room.id, BO);

      const { room: updated, removedUids } = await service.revokeInvite(
        room.id,
        OWNER,
        'bo@EXAMPLE.com',
      );

      expect(removedUids).toEqual([BO.uid]);
      expect(updated.participantIds).toEqual([OWNER]);
      expect(updated.invitedEmails).toEqual([]);
      await expect(service.getRoomFor(room.id, BO)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('iceServersFor', () => {
    it('hands STUN + a TURN credential to seated participants only', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: [BO.email!],
      });
      await expect(service.iceServersFor(room.id, CY)).rejects.toThrow(
        ForbiddenException,
      );
      // Invited but not seated yet: no relay credential.
      await expect(service.iceServersFor(room.id, BO)).rejects.toThrow(
        ForbiddenException,
      );

      await service.joinRoom(room.id, BO);
      const { iceServers, ttlSeconds } = await service.iceServersFor(
        room.id,
        BO,
      );

      expect(ttlSeconds).toBe(3600);
      expect(iceServers[0]).toEqual({ urls: ['stun:stun.example:3478'] });
      expect(iceServers[1]).toMatchObject({
        urls: ['turn:203.0.113.7:3478'],
        username: expect.stringMatching(new RegExp(`^\\d+:${BO.uid}$`)),
        credential: expect.any(String),
      });
    });
  });

  describe('invitation emails', () => {
    it('emails everyone invited when the room is created', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: ['Bo@example.com', 'cy@example.com'],
      });

      expect(invitations.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: room.id }),
        OWNER_CALLER,
        ['bo@example.com', 'cy@example.com'],
      );
    });

    it('emails only the newly added people', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: [BO.email!],
      });
      invitations.send.mockClear();

      await service.addInvites(room.id, OWNER_CALLER, [
        'BO@example.com',
        CY.email!,
      ]);

      expect(invitations.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: room.id }),
        OWNER_CALLER,
        [CY.email],
      );
    });

    it('sends nothing when someone joins through the invite link', async () => {
      const room = await service.createRoom(OWNER_CALLER, { topic: 'Plans' });
      const { inviteCode } = await service.createInviteLink(room.id, OWNER);
      invitations.send.mockClear();

      await service.joinRoom(room.id, CY, inviteCode!);

      expect(invitations.send).not.toHaveBeenCalled();
    });
  });

  describe('listRoomsFor', () => {
    it('lists only rooms the caller owns or is invited to', async () => {
      const mine = await service.createRoom(OWNER_CALLER, {
        topic: 'Mine',
        invitedEmails: [BO.email!],
      });
      await service.createRoom(CY, { topic: 'Someone else’s' });

      const forBo = await service.listRoomsFor(BO, 10);
      expect(forBo.map((r) => r.id)).toEqual([mine.id]);
      expect(forBo[0]).not.toHaveProperty('invitedEmails');
    });
  });

  describe('reads and writes', () => {
    it('blocks strangers from transcript and suggestions, and non-participants from writing', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: [BO.email!],
      });
      await expect(service.listTranscript(room.id, CY, 10)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.listSuggestions(room.id, CY, 10)).rejects.toThrow(
        ForbiddenException,
      );
      // Invited but not yet joined: may read, may not write.
      await expect(service.listTranscript(room.id, BO, 10)).resolves.toEqual(
        [],
      );
      await expect(
        service.addTranscriptSegment(room.id, BO, 'hi'),
      ).rejects.toThrow(ForbiddenException);
      await expect(service.suggestTopicFor(room.id, BO)).rejects.toThrow(
        ForbiddenException,
      );
      expect(llm.generate).not.toHaveBeenCalled();
    });
  });

  describe('startRoom', () => {
    it('only the owner may start the room', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Weekend plans',
      });
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
      await service.addInvites(room.id, OWNER_CALLER, [BO.email!]);
      await service.joinRoom(room.id, BO);
      const seg = await service.addTranscriptSegment(
        room.id,
        { ...BO, name: 'Bo' },
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
        service.addTranscriptSegment('nope', OWNER_CALLER, 'hi'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('buildTranscriptSegment / saveTranscriptSegment', () => {
    it('stamps a segment without persisting until saved', async () => {
      const seg = service.buildTranscriptSegment(
        'r1',
        { uid: 'user-2', name: 'Bo' },
        'hello',
      );
      expect(seg).toMatchObject({
        roomId: 'r1',
        speakerId: 'user-2',
        speakerName: 'Bo',
        text: 'hello',
      });
      expect(seg.id).toBeTruthy();
      expect(await repo.countSegments('r1')).toBe(0);

      await service.saveTranscriptSegment(seg);
      expect(await repo.countSegments('r1')).toBe(1);
    });
  });

  describe('generateTopicSuggestion', () => {
    it('feeds the model the most recent window, not the start of the conversation', async () => {
      const room = await createLiveRoom(); // contextSegments is 25 in this suite
      for (let i = 0; i < 30; i++) {
        await service.addTranscriptSegment(
          room.id,
          OWNER_CALLER,
          `utterance-${String(i).padStart(2, '0')}`,
        );
      }
      llm.generate.mockResolvedValue({
        text: '{"topic":"Next","rationale":"why"}',
      });

      await service.generateTopicSuggestion(room.id, 'volume');

      const prompt = JSON.stringify(llm.generate.mock.calls[0][0]);
      expect(prompt).toContain('utterance-29');
      expect(prompt).toContain('utterance-05');
      expect(prompt).not.toContain('utterance-04');
    });

    it('asks the model for JSON, parses it, and persists the suggestion', async () => {
      const room = await createLiveRoom();
      await service.addTranscriptSegment(
        room.id,
        OWNER_CALLER,
        'I love surfing.',
      );
      llm.generate.mockResolvedValue({
        text: '{"topic":"Dream coastlines","rationale":"builds on surfing"}',
      });

      const suggestion = await service.generateTopicSuggestion(
        room.id,
        'volume',
      );

      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ json: true }),
      );
      expect(suggestion.topic).toBe('Dream coastlines');
      expect(suggestion.rationale).toBe('builds on surfing');
      expect(suggestion.trigger).toBe('volume');
      expect(await repo.listSuggestions(room.id, 10)).toHaveLength(1);
    });
  });

  describe('suggestTopicFor (manual)', () => {
    it('lets the owner ask for a topic', async () => {
      const room = await createLiveRoom();
      llm.generate.mockResolvedValue({
        text: '{"topic":"Hidden talents","rationale":"fresh angle"}',
      });

      const suggestion = await service.suggestTopicFor(room.id, OWNER_CALLER);

      expect(suggestion.topic).toBe('Hidden talents');
      expect(suggestion.trigger).toBe('manual');
    });

    it('refuses a seated invitee — only the host steers', async () => {
      const room = await service.createRoom(OWNER_CALLER, {
        topic: 'Plans',
        invitedEmails: [BO.email!],
      });
      await service.joinRoom(room.id, BO);
      await service.startRoom(room.id, OWNER);

      await expect(service.suggestTopicFor(room.id, BO)).rejects.toThrow(
        ForbiddenException,
      );
      expect(llm.generate).not.toHaveBeenCalled();
    });

    it('refuses once the room has ended', async () => {
      const room = await createLiveRoom();
      llm.generate.mockRejectedValue(new Error('no report'));
      await service.endRoom(room.id, OWNER);
      llm.generate.mockClear();

      await expect(
        service.suggestTopicFor(room.id, OWNER_CALLER),
      ).rejects.toThrow(ConflictException);
      expect(llm.generate).not.toHaveBeenCalled();
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
        OWNER_CALLER,
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
      await expect(service.getRoom('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
