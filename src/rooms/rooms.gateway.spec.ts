import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { WsAuthenticator } from '../auth/ws-authenticator';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

describe('RoomsGateway', () => {
  let emit: jest.Mock;
  let fetchSockets: jest.Mock;
  let server: Pick<Server, 'to' | 'in'>;
  let service: {
    buildTranscriptSegment: jest.Mock;
    saveTranscriptSegment: jest.Mock;
    generateTopicSuggestion: jest.Mock;
    getRoom: jest.Mock;
  };
  let wsAuth: { authenticate: jest.Mock };

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

  /** A fake authenticated socket, already subscribed to the given rooms. */
  const socket = (uid = 'u1', name = 'Ada', rooms: string[] = ['r1']) =>
    ({
      id: `sock-${uid}`,
      rooms: new Set(rooms),
      data: { user: { uid, name, email: `${uid}@example.com` } },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }) as unknown as Socket & {
      data: { user?: { uid: string; name?: string; email?: string } };
    };

  const segment = {
    id: 's1',
    roomId: 'r1',
    speakerId: 'u1',
    text: 'hi',
    at: 't',
  };

  beforeEach(() => {
    emit = jest.fn();
    fetchSockets = jest.fn().mockResolvedValue([]);
    server = {
      to: jest.fn(() => ({ emit })) as unknown as Server['to'],
      in: jest.fn(() => ({ fetchSockets })) as unknown as Server['in'],
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

  it('refuses a seated participant whose invite was revoked', async () => {
    const gateway = buildGateway(8);
    service.getRoom.mockResolvedValue({
      id: 'r1',
      ownerId: 'owner',
      participantIds: ['owner', 'u1'],
      invitedEmails: [],
    });
    const client = socket('u1');

    await gateway.handleJoinRoom(client, { roomId: 'r1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', expect.anything());
  });

  it('broadcasts a transcript segment (uid from the socket) before persisting it', async () => {
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

  describe('WebRTC signaling', () => {
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

    it('relays an offer to the target socket, stamped with the verified sender', async () => {
      const gateway = buildGateway(8);
      const ada = socket('u1');
      await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(socket('u2'), { roomId: 'r1' });

      gateway.handleWebrtcOffer(ada, {
        roomId: 'r1',
        toUid: 'u2',
        sdp: { type: 'offer' },
      });

      expect(server.to).toHaveBeenCalledWith('sock-u2');
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

      expect(emit).not.toHaveBeenCalled();
    });

    it('tells the room when a voice member disconnects', async () => {
      const gateway = buildGateway(8);
      const ada = socket('u1');
      await gateway.handleWebrtcJoin(ada, { roomId: 'r1' });

      gateway.handleDisconnect(ada);

      expect(server.to).toHaveBeenCalledWith('r1');
      expect(emit).toHaveBeenCalledWith('webrtc:peer-left', { uid: 'u1' });
    });

    it('ignores a stale socket disconnecting after its uid rejoined', async () => {
      const gateway = buildGateway(8);
      const oldTab = socket('u1');
      const newTab = { ...socket('u1'), id: 'sock-u1-new' } as typeof oldTab;
      await gateway.handleWebrtcJoin(oldTab, { roomId: 'r1' });
      await gateway.handleWebrtcJoin(newTab, { roomId: 'r1' });

      gateway.handleDisconnect(oldTab);

      expect(emit).not.toHaveBeenCalledWith(
        'webrtc:peer-left',
        expect.anything(),
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
      fetchSockets.mockResolvedValue([ada, bo]);

      await gateway.evictFromRoom('r1', ['u2'], 'U2@example.com');

      expect(server.in).toHaveBeenCalledWith('r1');
      expect(bo.leave).toHaveBeenCalledWith('r1');
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
