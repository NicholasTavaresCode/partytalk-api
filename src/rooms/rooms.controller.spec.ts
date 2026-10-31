import { HostMessage } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

/**
 * The controller is thin, but it is the only place REST changes are fanned out
 * to the socket room — so this spec pins that wiring: every membership or
 * lifecycle change made over REST must reach the people already in the room.
 */
describe('RoomsController', () => {
  let service: {
    joinRoom: jest.Mock;
    leaveRoom: jest.Mock;
    startRoom: jest.Mock;
    endRoom: jest.Mock;
    forceTopicChange: jest.Mock;
  };
  let gateway: {
    broadcastRoomUpdated: jest.Mock;
    scheduleSessionEnd: jest.Mock;
    broadcastSessionEnded: jest.Mock;
    broadcastHostMessage: jest.Mock;
  };
  let controller: RoomsController;

  const room = { id: 'r1', participantIds: ['owner', 'u2'] } as Room;

  beforeEach(() => {
    service = {
      joinRoom: jest.fn().mockResolvedValue(room),
      leaveRoom: jest.fn().mockResolvedValue(room),
      startRoom: jest.fn().mockResolvedValue(room),
      endRoom: jest.fn().mockResolvedValue(room),
      forceTopicChange: jest.fn(),
    };
    gateway = {
      broadcastRoomUpdated: jest.fn(),
      scheduleSessionEnd: jest.fn(),
      broadcastSessionEnded: jest.fn(),
      broadcastHostMessage: jest.fn(),
    };
    controller = new RoomsController(
      service as unknown as RoomsService,
      gateway as unknown as RoomsGateway,
    );
  });

  it('join: persists, then pushes the updated room to the socket room', async () => {
    await expect(controller.join('r1', 'u2')).resolves.toBe(room);

    expect(service.joinRoom).toHaveBeenCalledWith('r1', 'u2');
    expect(gateway.broadcastRoomUpdated).toHaveBeenCalledWith(room);
  });

  it('leave: persists, then pushes the updated room to the socket room', async () => {
    await expect(controller.leave('r1', 'u2')).resolves.toBe(room);

    expect(service.leaveRoom).toHaveBeenCalledWith('r1', 'u2');
    expect(gateway.broadcastRoomUpdated).toHaveBeenCalledWith(room);
  });

  it('start: arms the session clock and pushes the now-live room', async () => {
    await expect(controller.start('r1', 'owner')).resolves.toBe(room);

    expect(service.startRoom).toHaveBeenCalledWith('r1', 'owner');
    expect(gateway.scheduleSessionEnd).toHaveBeenCalledWith(room);
    expect(gateway.broadcastRoomUpdated).toHaveBeenCalledWith(room);
  });

  it('end: broadcasts the session end with the report', async () => {
    const ended = { ...room, status: 'ended', report: { summary: 's' } };
    service.endRoom.mockResolvedValue(ended);

    await expect(controller.end('r1', 'owner')).resolves.toBe(ended);

    expect(gateway.broadcastSessionEnded).toHaveBeenCalledWith(
      'r1',
      ended.report,
    );
  });

  it('change-topic: broadcasts what the host said', async () => {
    const said = { id: 'h1', roomId: 'r1', message: 'Ok.' } as HostMessage;
    service.forceTopicChange.mockResolvedValue(said);

    await expect(controller.changeTopic('r1')).resolves.toBe(said);

    expect(gateway.broadcastHostMessage).toHaveBeenCalledWith(said);
  });
});
