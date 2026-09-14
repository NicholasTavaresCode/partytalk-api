/**
 * Injection token for the Firestore instance. Depend on this token (not the
 * concrete SDK) so services and repositories can be given a fake in tests
 * (see di-use-interfaces-tokens, test-mock-external-services).
 */
export const FIRESTORE = Symbol('FIRESTORE');

/** Canonical Firestore collection names, kept in one place to avoid typos. */
export const COLLECTIONS = {
  USERS: 'users',
  ROOMS: 'rooms',
  /** Per-room subcollection of voice-transcript segments (STT output). */
  ROOM_SEGMENTS: 'segments',
  /** Per-room subcollection of the lines the AI host said (topic changes). */
  ROOM_HOST_MESSAGES: 'hostMessages',
} as const;
