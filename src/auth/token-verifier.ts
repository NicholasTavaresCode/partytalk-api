/**
 * Contract for verifying a bearer credential and returning the decoded claims.
 * Consumers (the guard) depend on this abstract class as an injection token so
 * the Firebase implementation can be swapped for a fake in tests
 * (di-use-interfaces-tokens, test-mock-external-services).
 */
export interface VerifiedToken {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

export abstract class TokenVerifier {
  abstract verify(idToken: string): Promise<VerifiedToken>;
}
