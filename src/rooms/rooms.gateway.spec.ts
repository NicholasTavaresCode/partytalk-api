import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { WsAuthenticator } from '../auth/ws-authenticator';
import { HostMessage } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

describe('RoomsGateway', () => {
  let emit: jest.Mock;
  let server: Pick<Server, 'to'>;
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
      config,
    );
    gateway.server = server as Server;
    return gateway;
  };

  /** A fake authenticated socket. */
  const socket = (uid = 'u1', name = 'Ada') =>
    ({
      data: { user: { uid, name } },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }) as unknown as Socket & {
      data: { user?: { uid: string; name?: string } };
    };

  beforeEach(() => {
    emit = jest.fn();
    server = { to: jest.fn(() => ({ emit })) as unknown as Server['to'] };
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

  describe('handleConnection', () => {
    it('pins the authenticated user onto the socket', async () => {
      const gateway = buildGateway(8);
      wsAuth.authenticate.mockResolvedValue({ uid: 'u9' });
      const client = {
        data: {},
        emit: jest.fn(),
        disconnect: jest.fn(),
      } as never;

      await gateway.handleConnection(client);

      expect((client as { data: { user?: unknown } }).data.user).toEqual({
        uid: 'u9',
      });
    });

    it('drops an unauthenticated socket', async () => {
      const gateway = buildGateway(8);
      wsAuth.authenticate.mockRejectedValue(new Error('bad token'));
      const disconnect = jest.fn();
      const client = { data: {}, emit: jest.fn(), disconnect } as never;

      await gateway.handleConnection(client);

      expect(disconnect).toHaveBeenCalledWith(true);
    });
  });

  it('is defined', () => {
    expect(buildGateway(8)).toBeDefined();
  });

  it('lets a participant join and broadcasts presence', async () => {
    const gateway = buildGateway(8);
    const client = socket('u1');
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

      await jest.advanceTimersByTimeAsync(25_000);

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
  });
});
