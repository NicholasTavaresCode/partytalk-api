import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Room } from './entities/room.entity';

/** Upper bound on a room's invite list (link joins count toward it). */
export const MAX_INVITES = 50;

/**
 * The part of the verified principal that room access depends on. `email` is
 * Google-verified — AuthService rejects unverified addresses before any route
 * runs — so matching on it cannot be spoofed by typing someone else's address.
 */
export interface RoomCaller {
  uid: string;
  email?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The single room-access rule, shared by REST and the socket gateway: the owner
 * plus the Google accounts whose email the owner invited (directly, or by them
 * redeeming the invite link). Everyone else is a stranger to the room.
 */
export function canAccessRoom(
  room: Pick<Room, 'ownerId' | 'invitedEmails'>,
  caller: RoomCaller,
): boolean {
  if (room.ownerId === caller.uid) {
    return true;
  }
  return (
    !!caller.email &&
    (room.invitedEmails ?? []).includes(normalizeEmail(caller.email))
  );
}

/** Normalize and dedupe an invite list, dropping the owner's own address. */
export function normalizeInvites(
  emails: string[],
  ownerEmail?: string,
): string[] {
  const owner = ownerEmail ? normalizeEmail(ownerEmail) : undefined;
  return [...new Set(emails.map(normalizeEmail))].filter(
    (email) => email && email !== owner,
  );
}

/** A fresh unguessable invite-link secret (128 bits, URL-safe). */
export function newInviteCode(): string {
  return randomBytes(16).toString('base64url');
}

/** Constant-time check of a presented invite code against the room's. */
export function inviteCodeMatches(
  expected: string | null | undefined,
  given: string | undefined,
): boolean {
  if (!expected || !given) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
