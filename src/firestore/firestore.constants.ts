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
  /** Per-room subcollection of AI topic suggestions. */
  ROOM_SUGGESTIONS: 'suggestions',
  IELTS_EXAMS: 'ielts_exams',
  IELTS_ATTEMPTS: 'ielts_attempts',
} as const;
