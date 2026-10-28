import { ConfigService } from '@nestjs/config';
import { Mailer } from '../mail/mailer';
import { Room } from './entities/room.entity';
import { RoomInvitations } from './room-invitations';

describe('RoomInvitations', () => {
  const room = {
    id: 'room-1',
    topic: 'Books <b>& films</b>',
  } as Room;
  let mailer: { enabled: boolean; send: jest.Mock };
  let invitations: RoomInvitations;

  beforeEach(() => {
    mailer = { enabled: true, send: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: () => ({ webAppUrl: 'https://web.example' }),
    } as unknown as ConfigService;
    invitations = new RoomInvitations(
      mailer as unknown as Mailer,
      config as never,
    );
  });

  it('writes who invited them, the topic, and a link to the room', () => {
    const mail = invitations.compose(room, { name: 'Hana' }, 'bo@example.com');

    expect(mail.to).toBe('bo@example.com');
    expect(mail.subject).toContain('Hana invited you');
    expect(mail.subject).toContain('Books <b>& films</b>');
    expect(mail.text).toContain('https://web.example/practice/room-1');
    expect(mail.text).toContain('Google account for bo@example.com');
    expect(mail.html).toContain('href="https://web.example/practice/room-1"');
  });

  it('escapes the topic and names in the HTML body', () => {
    const mail = invitations.compose(
      room,
      { name: '<img src=x onerror=alert(1)>' },
      'bo@example.com',
    );

    expect(mail.html).not.toContain('<b>& films</b>');
    expect(mail.html).toContain('Books &lt;b&gt;&amp; films&lt;/b&gt;');
    expect(mail.html).not.toContain('<img src=x');
  });

  it('falls back to the host email when there is no name', () => {
    expect(
      invitations.compose(room, { email: 'hana@example.com' }, 'bo@example.com')
        .subject,
    ).toContain('hana@example.com invited you');
  });

  it('sends one email per address without blocking, and survives failures', async () => {
    mailer.send
      .mockRejectedValueOnce(new Error('SMTP down'))
      .mockResolvedValueOnce(undefined);

    expect(() =>
      invitations.send(room, { name: 'Hana' }, [
        'a@example.com',
        'b@example.com',
      ]),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r)); // let the rejection be handled

    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect(mailer.send.mock.calls.map((c) => c[0].to)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });
});
