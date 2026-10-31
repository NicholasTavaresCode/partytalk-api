import {
  canAccessRoom,
  inviteCodeMatches,
  newInviteCode,
  normalizeInvites,
} from './room-access';

describe('room access', () => {
  const room = { ownerId: 'owner', invitedEmails: ['bo@example.com'] };

  describe('canAccessRoom', () => {
    it('admits the owner', () => {
      expect(canAccessRoom(room, { uid: 'owner' })).toBe(true);
    });

    it('admits an invitee by email, case-insensitively', () => {
      expect(
        canAccessRoom(room, { uid: 'u2', email: ' Bo@Example.COM ' }),
      ).toBe(true);
    });

    it('rejects anyone else', () => {
      expect(canAccessRoom(room, { uid: 'u3', email: 'cy@example.com' })).toBe(
        false,
      );
      expect(canAccessRoom(room, { uid: 'u3' })).toBe(false);
    });

    it('treats a legacy room without an invite list as owner-only', () => {
      expect(
        canAccessRoom(
          { ownerId: 'owner' },
          { uid: 'u2', email: 'bo@example.com' },
        ),
      ).toBe(false);
    });
  });

  describe('normalizeInvites', () => {
    it('lowercases, dedupes and drops the owner', () => {
      expect(
        normalizeInvites(
          ['Bo@example.com', 'bo@example.com ', 'me@example.com', 'cy@x.io'],
          'ME@example.com',
        ),
      ).toEqual(['bo@example.com', 'cy@x.io']);
    });
  });

  describe('invite codes', () => {
    it('mints unguessable, URL-safe codes', () => {
      const a = newInviteCode();
      expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(newInviteCode()).not.toBe(a);
    });

    it('matches only the exact current code', () => {
      const code = newInviteCode();
      expect(inviteCodeMatches(code, code)).toBe(true);
      expect(inviteCodeMatches(code, code.slice(1))).toBe(false);
      expect(inviteCodeMatches(code, undefined)).toBe(false);
      expect(inviteCodeMatches(null, code)).toBe(false);
    });
  });
});
