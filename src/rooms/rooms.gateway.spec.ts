import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { WsAuthenticator } from '../auth/ws-authenticator';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

type FakeSocket = Socket & {
  data: {
    user?: { uid: string; name?: string; email?: string };
    rooms?: Set<string>;
    voice?: Set<string>;
  };
};

describe('RoomsGateway', () => {
  /** Socket.IO room → member sockets: what the (Pub/Sub-backed) adapter tracks. */
  let members: Map<string, Set<FakeSocket>>;
  /** Every broadcast's (event, payload), regardless of target rooms. */
  let emit: jest.Mock;
  let server: {
    to: jest.Mock;
    in: jest.Mock;
    local: { in: jest.Mock };
  };
  let service: {
    buildTranscriptSegment: jest.Mock;
    saveTranscriptSegment: jest.Mock;
    generateTopicSuggestion: jest.Mock;
    getRoom: jest.Mock;
  };
  let wsAuth: { authenticate: jest.Mock };

  /** A broadcast operator over some rooms, like `server.to(...)` / `server.in(...)`. */
  const operator = (rooms: string[], except: string[] = []) => {
    const targets = () =>
      [...new Set(rooms.flatMap((r) => [...(members.get(r) ?? [])]))].filter(
        (s) => !except.includes(s.id),
      );
    return {
      emit: (event: string, payload: unknown) => emit(event, payload),
      except: (room: string) => operator(rooms, [...except, room]),
      fetchSockets: () => Promise.resolve(targets()),
      socketsLeave: (leave: string | string[]) => {
        for (const s of targets()) [leave].flat().forEach((r) => s.leave(r));
      },
    };
  };

  const buildGateway = (everySegments: number, silenceMs = 25_000) => {
    const config = {
      get: () => ({
        suggestEverySegments: everySegments,
        silenceMs,
        contextSegments: 25,
      }),
    } as unknown as ConfigService;
    const gateway = new RoomsGateway(
      service as unknown as RoomsService,
      wsAuth as unknown as WsAuthenticator,
      config as never,
    );
    gateway.server = server as unknown as Server;
    return gateway;
  };

  /** A fake authenticated socket, already subscribed to `rooms` (no join() call recorded). */
  const socket = (
    uid = 'u1',
    name = 'Ada',
    rooms: string[] = ['r1'],
    id = `sock-${uid}`,
  ): FakeSocket => {
    const s = {
      id,
      rooms: new Set<string>(),
      data: { user: { uid, name, email: `${uid}@example.com` } },
      emit: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as FakeSocket & { add: (room: string) => void };
    s.add = (room: string) => {
      s.rooms.add(room);
      if (!members.has(room)) members.set(room, new Set());
      members.get(room)!.add(s);
    };
    s.join = jest.fn((r: string | string[]) =>
      [r].flat().forEach(s.add),
    ) as never;
    s.leave = jest.fn((room: string) => {
      s.rooms.delete(room);
      members.get(room)?.delete(s);
    }) as never;
    rooms.forEach(s.add);
    return s;
  };

  /** What Socket.IO does before handleDisconnect: the socket leaves every room. */
  const dropConnection = (s: FakeSocket) =>
    [...s.rooms].forEach((room) => members.get(room)?.delete(s));

  const segment = {
    id: 's1',
    roomId: 'r1',
    speakerId: 'u1',
    text: 'hi',
    at: 't',
  };

  beforeEach(() => {
    members = new Map();
    emit = jest.fn();
    server = {
      to: jest.fn((r: string | string[]) => operator([r].flat())),
      in: jest.fn((r: string | string[]) => operator([r].flat())),
      local: { in: jest.fn((r: string | string[]) => operator([r].flat())) },
    };
    service = {
      buildTranscriptSegment: jest.fn().mockReturnValue(segment),
      saveTranscriptSegment: jest.fn().mockResolvedValue(segment),
      generateTopicSuggestion: jest.fn().mockResolvedValue({
        id: 'sug1',
        roomId: 'r1',
        topic: 'New?',
        rationale: 'why',
        trigger: 'volume',
        at: 't',
      }),
      getRoom: jest.fn().mockResolvedValue({
        id: 'r1',
        ownerId: 'u1',
        participantIds: ['u1'],
        invitedEmails: [],
      }),
    };
    wsAuth = { authenticate: jest.fn() };
  });

  describe('handshake authentication', () => {
    it('registers itself as Socket.IO middleware', () => {
      const gateway = buildGateway(8);
      const use = jest.fn();

      gateway.afterInit({ use } as unknown as Server);

      expect(use).toHaveBeenCalledWith(expect.any(Function));
    });

    it('pins the authenticated user onto the socket and lets it connect', async () => {
      const gateway = buildGateway(8);
      wsAuth.authenticate.mockResolvedValue({ uid: 'u9' });
      const client = { data: {} } as never;
      const next = jest.fn();

      await gateway.authenticateSocket(client, next);

      expect((client as { data: { user?: unknown } }).data.user).toEqual({
        uid: 'u9',
      });
      expect(next).toHaveBeenCalledWith();
    });

    it('refuses the handshake for an invalid or expired token', async () => {
      const gateway = buildGateway(8);
      wsAuth.authenticate.mockRejectedValue(new Error('expired'));
      const client = { data: {} } as never;
      const next = jest.fn();

      await gateway.authenticateSocket(client, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(
        (client as { data: { user?: unknown } }).data.user,
      ).toBeUndefined();
    });
  });

  it('lets a participant join and broadcasts presence', async () => {
    const gateway = buildGateway(8);
    const client = socket('u1', 'Ada', []);
    await gateway.handleJoinRoom(client, { roomId: 'r1' });

    expect(client.join).toHaveBeenCalledWith('r1');
    expect(emit).toHaveBeenCalledWith(
      'presence',
      expect.objectContaining({ uid: 'u1', event: 'joined' }),
    );
  });

  it('refuses to join a room the user is not a participant of', async () => {
    const gateway = buildGateway(8);
    service.getRoom.mockResolvedValue({
      id: 'r1',
      participantIds: ['someone-else'],
    });
    const client = socket('u1', 'Ada', []);

    await gateway.handleJoinRoom(client, { roomId: 'r1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        message: expect.stringContaining('not a participant'),
      }),
    );
  });

  it('refuses a seated participant whose invite was revoked', async () => {
    const gateway = buildGateway(8);
    service.getRoom.mockResolvedValue({
      id: 'r1',
      ownerId: 'owner',
      participantIds: ['owner', 'u1'],
      invitedEmails: [],
    });
    const client = socket('u1', 'Ada', []);

    await gateway.handleJoinRoom(client, { roomId: 'r1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', expect.anything());
  });

  describe('transcript', () => {
    it('broadcasts a segment (uid from the socket) before persisting it', async () => {
      let persist!: () => void;
      service.saveTranscriptSegment.mockReturnValue(
        new Promise((resolve) => (persist = () => resolve(segment))),
      );
      const gateway = buildGateway(8); // high threshold: no auto-suggest yet

      const pending = gateway.handleTranscript(socket('u1', 'Ada'), {
        roomId: 'r1',
        text: ' hello ',
      });

      expect(service.buildTranscriptSegment).toHaveBeenCalledWith(
        'r1',
        { uid: 'u1', name: 'Ada' },
        'hello',
      );
      expect(emit).toHaveBeenCalledWith('transcript', segment);
      expect(service.saveTranscriptSegment).toHaveBeenCalledWith(segment);
      persist();
      await pending;
    });

    it('rejects transcript from a socket that has not joined the room', async () => {
      const gateway = buildGateway(8);
      const client = socket('u1', 'Ada', []);

      await gateway.handleTranscript(client, { roomId: 'r1', text: 'hello' });

      expect(emit).not.toHaveBeenCalledWith('transcript', expect.anything());
      expect(service.saveTranscriptSegment).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', expect.anything());
    });

    it('survives a failed write without auto-suggesting', async () => {
      service.saveTranscriptSegment.mockRejectedValue(
        new Error('firestore down'),
      );
      const gateway = buildGateway(1);

      await gateway.handleTranscript(socket('u1'), {
        roomId: 'r1',
        text: 'hello',
      });

      expect(emit).toHaveBeenCalledWith('transcript', segment);
      expect(service.generateTopicSuggestion).not.toHaveBeenCalled();
    });

    it('auto-suggests a topic on the volume trigger', async () => {
      const gateway = buildGateway(1); // suggest after every segment
      await gateway.handleTranscript(socket('u1'), {
        roomId: 'r1',
        text: 'hello',
      });

      expect(service.generateTopicSuggestion).toHaveBeenCalledWith(
        'r1',
        'volume',
      );
      expect(emit).toHaveBeenCalledWith(
        'topicSuggested',
        expect.objectContaining({ topic: 'New?' }),
      );
    });

    it('auto-suggests a topic after a silence', async () => {
      jest.useFakeTimers();
      try {
        const gateway = buildGateway(100, 25_000); // volume won't fire
        await gateway.handleTranscript(socket('u1'), {
          roomId: 'r1',
          text: 'hello',
        });
        expect(service.generateTopicSuggestion).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(25_000);

        expect(service.generateTopicSuggestion).toHaveBeenCalledWith(
          'r1',
          'silence',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it("broadcasts the host's manual topic and restarts the auto-triggers", async () => {
      jest.useFakeTimers();
      try {
        const gateway = buildGateway(2, 25_000);
        await gateway.handleTranscript(socket('u1'), {
          roomId: 'r1',
          text: 'one',
        });
        const manual = {
          id: 'sug-m',
          roomId: 'r1',
          topic: 'Hidden talents',
          rationale: 'why',
          trigger: 'manual' as const,
          at: 't',
        };

        gateway.announceSuggestion('r1', manual);

        expect(server.to).toHaveBeenCalledWith('r1');
        expect(emit).toHaveBeenCalledWith('topicSuggested', manual);
        // Neither the pending silence nudge nor the next segment fires on top of it.
        await jest.advanceTimersByTimeAsync(25_000);
        await gateway.handleTranscript(socket('u1'), {
          roomId: 'r1',
          text: 'two',
        });
        expect(service.generateTopicSuggestion).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('broadcasts the end-of-session report and closes the voice mesh', async () => {
    const gateway = buildGateway(8);
    const ada = socket('u1');
    await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });
    const report = {
      summary: 's',
      highlights: [],
      suggestions: [],
      topicsExplored: [],
      generatedAt: 't',
    };

    gateway.broadcastSessionEnded('r1', report);

    expect(server.to).toHaveBeenCalledWith('r1');
    expect(emit).toHaveBeenCalledWith('sessionEnded', { roomId: 'r1', report });
    expect(ada.rooms.has('voice:r1')).toBe(false);
  });

  describe('WebRTC signaling (shared across instances via Socket.IO rooms)', () => {
    beforeEach(() => {
      service.getRoom.mockResolvedValue({
        id: 'r1',
        ownerId: 'u1',
        participantIds: ['u1', 'u2'],
        invitedEmails: ['u2@example.com'],
      });
    });

    it('replies to a joiner with the peers already in the mesh', async () => {
      const gateway = buildGateway(8);
      const ada = socket('u1');
      const bo = socket('u2');

      await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(bo, { roomId: 'r1' });

      expect(ada.emit).toHaveBeenCalledWith('webrtc:peers', { uids: [] });
      expect(bo.emit).toHaveBeenCalledWith('webrtc:peers', { uids: ['u1'] });
      expect(bo.join).toHaveBeenCalledWith(['voice:r1', 'voice:r1:u2']);
    });

    it('never lets two simultaneous joiners both miss each other', async () => {
      const gateway = buildGateway(8);
      const ada = socket('u1');
      const bo = socket('u2');

      await Promise.all([
        gateway.handleWebrtcJoin(ada, { roomId: 'r1' }),
        gateway.handleWebrtcJoin(bo, { roomId: 'r1' }),
      ]);

      const peersOf = (s: FakeSocket) =>
        (s.emit as jest.Mock).mock.calls.find(
          (c) => c[0] === 'webrtc:peers',
        )![1].uids as string[];
      // At least one side sees the other and offers; if both do, the client
      // settles the glare (lower uid's offer wins).
      expect(peersOf(ada).includes('u2') || peersOf(bo).includes('u1')).toBe(
        true,
      );
    });

    it('refuses a non-participant', async () => {
      const gateway = buildGateway(8);
      const intruder = socket('u3');

      await gateway.handleWebrtcJoin(intruder, { roomId: 'r1' });

      expect(intruder.emit).not.toHaveBeenCalledWith(
        'webrtc:peers',
        expect.anything(),
      );
      expect(intruder.emit).toHaveBeenCalledWith('error', expect.anything());
    });

    it("relays an offer to the target's seat, stamped with the verified sender", async () => {
      const gateway = buildGateway(8);
      const ada = socket('u1');
      await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(socket('u2'), { roomId: 'r1' });

      gateway.handleWebrtcOffer(ada, {
        roomId: 'r1',
        toUid: 'u2',
        sdp: { type: 'offer' },
      });

      expect(server.to).toHaveBeenCalledWith('voice:r1:u2');
      expect(emit).toHaveBeenCalledWith('webrtc:peer-offer', {
        fromUid: 'u1',
        sdp: { type: 'offer' },
      });
    });

    it('does not relay from a socket outside the mesh', async () => {
      const gateway = buildGateway(8);
      await gateway.handleWebrtcJoin(socket('u2'), { roomId: 'r1' });

      gateway.handleWebrtcIce(socket('u1'), {
        roomId: 'r1',
        toUid: 'u2',
        candidate: {},
      });

      expect(emit).not.toHaveBeenCalledWith(
        'webrtc:peer-ice',
        expect.anything(),
      );
    });

    it('a newer tab takes the seat over; the old one can no longer relay', async () => {
      const gateway = buildGateway(8);
      const oldTab = socket('u1', 'Ada', ['r1'], 'sock-u1-old');
      const newTab = socket('u1', 'Ada', ['r1'], 'sock-u1-new');
      await gateway.handleWebrtcJoin(oldTab, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(newTab, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(socket('u2'), { roomId: 'r1' });

      expect(oldTab.rooms.has('voice:r1:u1')).toBe(false);
      gateway.handleWebrtcOffer(oldTab, { roomId: 'r1', toUid: 'u2', sdp: {} });
      expect(emit).not.toHaveBeenCalledWith(
        'webrtc:peer-offer',
        expect.anything(),
      );
    });

    it('tells the room when a voice member disconnects', async () => {
      const gateway = buildGateway(8);
      const ada = socket('u1');
      await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });

      dropConnection(ada);
      await gateway.handleDisconnect(ada);

      expect(server.to).toHaveBeenCalledWith(['r1', 'voice:r1']);
      expect(emit).toHaveBeenCalledWith('webrtc:peer-left', { uid: 'u1' });
    });

    it('ignores a stale socket disconnecting after its uid rejoined', async () => {
      const gateway = buildGateway(8);
      const oldTab = socket('u1', 'Ada', ['r1'], 'sock-u1-old');
      const newTab = socket('u1', 'Ada', ['r1'], 'sock-u1-new');
      await gateway.handleWebrtcJoin(oldTab, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(newTab, { roomId: 'r1' });

      dropConnection(oldTab);
      await gateway.handleDisconnect(oldTab);

      expect(emit).not.toHaveBeenCalledWith(
        'webrtc:peer-left',
        expect.anything(),
      );
    });
  });

  describe('keeping everyone’s view of the room current', () => {
    it('tells the room its REST state changed, without leaking any room data', () => {
      const gateway = buildGateway(8);

      gateway.notifyRoomUpdated('r1');

      expect(server.to).toHaveBeenCalledWith('r1');
      expect(emit).toHaveBeenCalledWith('roomUpdated', { roomId: 'r1' });
    });

    it('hands a newcomer everyone already connected, one entry per person', async () => {
      const gateway = buildGateway(8);
      socket('owner', 'Hana');
      socket('owner', 'Hana', ['r1'], 'sock-owner-2');
      const bo = socket('u1', 'Bo', []);
      service.getRoom.mockResolvedValue({
        id: 'r1',
        ownerId: 'owner',
        participantIds: ['owner', 'u1'],
        invitedEmails: ['u1@example.com'],
      });

      await gateway.handleJoinRoom(bo, { roomId: 'r1' });

      expect(bo.emit).toHaveBeenCalledWith('roster', {
        roomId: 'r1',
        members: [
          { uid: 'owner', name: 'Hana' },
          { uid: 'u1', name: 'Bo' },
        ],
      });
      expect(emit).toHaveBeenCalledWith(
        'presence',
        expect.objectContaining({ uid: 'u1', event: 'joined' }),
      );
    });

    it("falls back to this instance's sockets when another instance doesn't answer", async () => {
      const gateway = buildGateway(8);
      socket('owner', 'Hana');
      const bo = socket('u1', 'Bo', []);
      service.getRoom.mockResolvedValue({
        id: 'r1',
        ownerId: 'owner',
        participantIds: ['owner', 'u1'],
        invitedEmails: ['u1@example.com'],
      });
      server.in.mockImplementation((r: string | string[]) => ({
        ...operator([r].flat()),
        fetchSockets: () => Promise.reject(new Error('timeout reached')),
      }));

      await gateway.handleJoinRoom(bo, { roomId: 'r1' });

      expect(server.local.in).toHaveBeenCalledWith('r1');
      expect(bo.emit).toHaveBeenCalledWith(
        'roster',
        expect.objectContaining({
          members: expect.arrayContaining([{ uid: 'owner', name: 'Hana' }]),
        }),
      );
    });

    it('announces "left" when a closed tab was the person’s last socket', async () => {
      const gateway = buildGateway(8);
      const bo = socket('u1', 'Bo', []);
      bo.data.rooms = new Set(['r1']); // it had joined r1; the drop emptied its rooms

      await gateway.handleDisconnect(bo);

      expect(emit).toHaveBeenCalledWith('presence', {
        roomId: 'r1',
        uid: 'u1',
        event: 'left',
      });
    });

    it('stays quiet while the person is still there in another tab', async () => {
      const gateway = buildGateway(8);
      const closedTab = socket('u1', 'Bo', []);
      closedTab.data.rooms = new Set(['r1']);
      socket('u1', 'Bo', ['r1'], 'sock-u1-2'); // the other tab

      await gateway.handleDisconnect(closedTab);

      expect(emit).not.toHaveBeenCalledWith(
        'presence',
        expect.objectContaining({ event: 'left' }),
      );
    });
  });

  describe('evictFromRoom', () => {
    it('kicks the revoked person out of the room and voice, and tells everyone', async () => {
      service.getRoom.mockResolvedValue({
        id: 'r1',
        ownerId: 'u1',
        participantIds: ['u1', 'u2'],
        invitedEmails: ['u2@example.com'],
      });
      const gateway = buildGateway(8);
      const ada = socket('u1');
      const bo = socket('u2');
      await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(bo, { roomId: 'r1' });

      await gateway.evictFromRoom('r1', ['u2'], 'U2@example.com');

      expect(bo.leave).toHaveBeenCalledWith('r1');
      expect(bo.leave).toHaveBeenCalledWith('voice:r1');
      expect(bo.leave).toHaveBeenCalledWith('voice:r1:u2');
      expect(bo.emit).toHaveBeenCalledWith('removedFromRoom', { roomId: 'r1' });
      expect(emit).toHaveBeenCalledWith('webrtc:peer-left', { uid: 'u2' });
      expect(emit).toHaveBeenCalledWith(
        'presence',
        expect.objectContaining({ uid: 'u2', event: 'left' }),
      );
      expect(ada.leave).not.toHaveBeenCalled();
      expect(ada.emit).not.toHaveBeenCalledWith(
        'removedFromRoom',
        expect.anything(),
      );
    });
  });
});
