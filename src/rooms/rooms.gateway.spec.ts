import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { WsAuthenticator } from '../auth/ws-authenticator';
import { HostMessage } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
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
    addTranscriptSegment: jest.Mock;
    consultHost: jest.Mock;
    expireRoom: jest.Mock;
    getRoom: jest.Mock;
  };
  let wsAuth: { authenticate: jest.Mock };

  const hostLine: HostMessage = {
    id: 'h1',
    roomId: 'r1',
    message: "Ok. Now let's talk about the Usain Bolt record.",
    topic: 'The Usain Bolt record',
    reason: 'why',
    trigger: 'volume',
    at: 't',
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
    }) as unknown as Socket & {
      data: { user?: { uid: string; name?: string } };
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
      addTranscriptSegment: jest.fn().mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        speakerId: 'u1',
        text: 'hi',
        at: 't',
      }),
      consultHost: jest.fn().mockResolvedValue(hostLine),
      expireRoom: jest.fn(),
      getRoom: jest
        .fn()
        .mockResolvedValue({ id: 'r1', participantIds: ['u1'] }),
    };
    wsAuth = { authenticate: jest.fn() };
  });

  describe('handshake authentication', () => {
    it('registers itself as Socket.IO middleware', () => {
      const gateway = buildGateway(8);
      wsAuth.authenticate.mockResolvedValue({ uid: 'u9' });
      const client = {
        data: {},
        emit: jest.fn(),
        disconnect: jest.fn(),
      } as never;

      gateway.afterInit({ use } as unknown as Server);

      expect((client as { data: { user?: unknown } }).data.user).toEqual({
        uid: 'u9',
      });
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
    const client = socket('u1');

    await gateway.handleJoinRoom(client, { roomId: 'r1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        message: expect.stringContaining('not a participant'),
      }),
    );
  });

  it('persists a transcript segment (uid from the socket) and broadcasts it', async () => {
    const gateway = buildGateway(8); // high threshold: the host is not consulted yet
    await gateway.handleTranscript(socket('u1', 'Ada'), {
      roomId: 'r1',
      text: 'hello',
    });

    expect(service.addTranscriptSegment).toHaveBeenCalledWith(
      'r1',
      { uid: 'u1', name: 'Ada' },
      'hello',
    );
    expect(emit).toHaveBeenCalledWith(
      'transcript',
      expect.objectContaining({ id: 's1' }),
    );
    expect(service.consultHost).not.toHaveBeenCalled();
  });

  it('consults the host on the volume trigger and broadcasts what it says', async () => {
    const gateway = buildGateway(1); // consult after every segment
    await gateway.handleTranscript(socket('u1'), {
      roomId: 'r1',
      text: 'hello',
    });

    expect(service.consultHost).toHaveBeenCalledWith('r1', 'volume');
    expect(emit).toHaveBeenCalledWith('hostMessage', hostLine);
  });

  it('broadcasts nothing when the host chooses to stay quiet', async () => {
    const gateway = buildGateway(1);
    service.consultHost.mockResolvedValue(null);
    await gateway.handleTranscript(socket('u1'), {
      roomId: 'r1',
      text: 'hello',
    });

    expect(service.consultHost).toHaveBeenCalledWith('r1', 'volume');
    expect(emit).not.toHaveBeenCalledWith('hostMessage', expect.anything());
  });

  it('consults the host after a silence', async () => {
    jest.useFakeTimers();
    try {
      const gateway = buildGateway(100, 25_000); // volume won't fire
      await gateway.handleTranscript(socket('u1'), {
        roomId: 'r1',
        text: 'hello',
      });
      expect(service.consultHost).not.toHaveBeenCalled();

        gateway.announceSuggestion('r1', manual);

      expect(service.consultHost).toHaveBeenCalledWith('r1', 'silence');
      expect(emit).toHaveBeenCalledWith('hostMessage', hostLine);
    } finally {
      jest.useRealTimers();
    }
  });

  it('pushes the authoritative room to everyone in it after a membership change', () => {
    const gateway = buildGateway(8);
    const room = { id: 'r1', participantIds: ['u1', 'u2'] } as Room;
    gateway.broadcastRoomUpdated(room);

    expect(server.to).toHaveBeenCalledWith('r1');
    expect(emit).toHaveBeenCalledWith('roomUpdated', room);
  });

  it('pushes a manually forced host line to the room', () => {
    const gateway = buildGateway(8);
    gateway.broadcastHostMessage(hostLine);

    expect(server.to).toHaveBeenCalledWith('r1');
    expect(emit).toHaveBeenCalledWith('hostMessage', hostLine);
  });

  describe('session clock', () => {
    const report = {
      summary: 's',
      highlights: [],
      suggestions: [],
      topicsExplored: [],
      generatedAt: 't',
    };
    /** A live room whose scheduled end is `inMs` from (fake) now. */
    const liveRoom = (inMs: number): Room =>
      ({
        id: 'r1',
        status: 'live',
        scheduledEndAt: new Date(Date.now() + inMs).toISOString(),
      }) as Room;

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('ends the session server-side when the time is up', async () => {
      const gateway = buildGateway(100);
      service.expireRoom.mockResolvedValue({
        id: 'r1',
        status: 'ended',
        report,
      });
      gateway.scheduleSessionEnd(liveRoom(10 * 60_000));

      await jest.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(service.expireRoom).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(service.expireRoom).toHaveBeenCalledWith('r1');
      expect(emit).toHaveBeenCalledWith('sessionEnded', {
        roomId: 'r1',
        report,
      });
    });

    it('stands down when the owner ends the room first', async () => {
      const gateway = buildGateway(100);
      gateway.scheduleSessionEnd(liveRoom(10 * 60_000));
      gateway.broadcastSessionEnded('r1', report); // manual end via REST

      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(service.expireRoom).not.toHaveBeenCalled();
    });

    it('broadcasts nothing when the room had already ended by the time it fired', async () => {
      const gateway = buildGateway(100);
      service.expireRoom.mockResolvedValue(null);
      gateway.scheduleSessionEnd(liveRoom(1_000));

      await jest.advanceTimersByTimeAsync(1_000);
      expect(service.expireRoom).toHaveBeenCalledWith('r1');
      expect(emit).not.toHaveBeenCalledWith('sessionEnded', expect.anything());
    });

    it('does nothing for a room without a scheduled end', async () => {
      const gateway = buildGateway(100);
      gateway.scheduleSessionEnd({ id: 'r1', status: 'live' } as Room);

      await jest.advanceTimersByTimeAsync(60 * 60_000);
      expect(service.expireRoom).not.toHaveBeenCalled();
    });
  });

  it('broadcasts the end-of-session report', () => {
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
