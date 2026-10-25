import { createHmac } from 'node:crypto';
import { buildIceServers } from './ice-servers';

describe('buildIceServers', () => {
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
  const base = {
    stunUrls: ['stun:stun.l.google.com:19302'],
    turnUrls: [] as string[],
    turnSecret: undefined as string | undefined,
    turnCredentialTtlSeconds: 3600,
  };

  it('offers STUN only when no relay is configured', () => {
    expect(buildIceServers(base, 'u1', NOW)).toEqual([
      { urls: ['stun:stun.l.google.com:19302'] },
    ]);
  });

  it('omits TURN when the URLs are set but the secret is missing', () => {
    const servers = buildIceServers(
      { ...base, turnUrls: ['turn:203.0.113.7:3478'] },
      'u1',
      NOW,
    );
    expect(servers).toHaveLength(1);
  });

  it('mints a coturn use-auth-secret credential that expires after the TTL', () => {
    const turnUrls = [
      'turn:203.0.113.7:3478?transport=udp',
      'turn:203.0.113.7:3478?transport=tcp',
    ];
    const [, turn] = buildIceServers(
      { ...base, turnUrls, turnSecret: 's3cret' },
      'u1',
      NOW,
    );

    const expiry = NOW / 1000 + 3600;
    expect(turn.urls).toEqual(turnUrls);
    expect(turn.username).toBe(`${expiry}:u1`);
    // What coturn computes on its side to accept the allocation.
    expect(turn.credential).toBe(
      createHmac('sha1', 's3cret').update(`${expiry}:u1`).digest('base64'),
    );
  });
});
