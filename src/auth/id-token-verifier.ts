/**
 * Contract for verifying a Google Identity ID token and returning its claims.
 * Consumers (AuthService) depend on this abstract class as an injection token so
 * the Google implementation can be swapped for a fake in tests — no network
 * (di-use-interfaces-tokens, test-mock-external-services).
 *
 * This is pure *authentication* (who is this token holder?). Authorization and
 * account resolution (domain policy, provisioning, roles) live in AuthService.
 */
export interface VerifiedIdentity {
  /** Google account subject — globally unique and stable; used as the user id. */
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

export abstract class IdTokenVerifier {
  abstract verify(idToken: string): Promise<VerifiedIdentity>;
}
