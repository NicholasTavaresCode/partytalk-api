import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { WsAuthenticator } from '../auth/ws-authenticator';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

describe('RoomsGateway', () => {
  let emit: jest.Mock;
  let server: Pick<Server, 'to'>;
  let service: {
    addTranscriptSegment: jest.Mock;
    generateTopicSuggestion: jest.Mock;
    getRoom: jest.Mock;
  };
  let wsAuth: { authenticate: jest.Mock };

  const buildGateway = (everySegments: number, silenceMs = 25_000) => {
    const config = {
      get: () => ({ suggestEverySegments: everySegments, silenceMs, contextSegments: 25 }),
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
    }) as unknown as Socket & { data: { user?: { uid: string; name?: string } } };

  beforeEach(() => {
    emit = jest.fn();
    server = { to: jest.fn(() => ({ emit })) as unknown as Server['to'] };
    service = {
      addTranscriptSegment: jest
        .fn()
        .mockResolvedValue({ id: 's1', roomId: 'r1', speakerId: 'u1', text: 'hi', at: 't' }),
      generateTopicSuggestion: jest
        .fn()
        .mockResolvedValue({ id: 'sug1', roomId: 'r1', topic: 'New?', rationale: 'why', trigger: 'volume', at: 't' }),
      getRoom: jest.fn().mockResolvedValue({ id: 'r1', participantIds: ['u1'] }),
    };
    wsAuth = { authenticate: jest.fn() };
  });

  describe('handleConnection', () => {
    it('pins the authenticated user onto the socket', async () => {
      const gateway = buildGateway(8);
      wsAuth.authenticate.mockResolvedValue({ uid: 'u9' });
      const client = { data: {}, emit: jest.fn(), disconnect: jest.fn() } as never;

      await gateway.handleConnection(client);

      expect((client as { data: { user?: unknown } }).data.user).toEqual({ uid: 'u9' });
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
    service.getRoom.mockResolvedValue({ id: 'r1', participantIds: ['someone-else'] });
    const client = socket('u1');

    await gateway.handleJoinRoom(client, { roomId: 'r1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ message: expect.stringContaining('not a participant') }),
    );
  });

  it('persists a transcript segment (uid from the socket) and broadcasts it', async () => {
    const gateway = buildGateway(8); // high threshold: no auto-suggest yet
    await gateway.handleTranscript(socket('u1', 'Ada'), { roomId: 'r1', text: 'hello' });

    expect(service.addTranscriptSegment).toHaveBeenCalledWith(
      'r1',
      { uid: 'u1', name: 'Ada' },
      'hello',
    );
    expect(emit).toHaveBeenCalledWith('transcript', expect.objectContaining({ id: 's1' }));
  });

  it('auto-suggests a topic on the volume trigger', async () => {
    const gateway = buildGateway(1); // suggest after every segment
    await gateway.handleTranscript(socket('u1'), { roomId: 'r1', text: 'hello' });

    expect(service.generateTopicSuggestion).toHaveBeenCalledWith('r1', 'volume');
    expect(emit).toHaveBeenCalledWith(
      'topicSuggested',
      expect.objectContaining({ topic: 'New?' }),
    );
  });

  it('auto-suggests a topic after a silence', async () => {
    jest.useFakeTimers();
    try {
      const gateway = buildGateway(100, 25_000); // volume won't fire
      await gateway.handleTranscript(socket('u1'), { roomId: 'r1', text: 'hello' });
      expect(service.generateTopicSuggestion).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(25_000);

      expect(service.generateTopicSuggestion).toHaveBeenCalledWith('r1', 'silence');
    } finally {
      jest.useRealTimers();
    }
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
