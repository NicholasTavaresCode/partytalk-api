/**
 * The identity attached to a request after a Firebase ID token is verified.
 * This is what `@CurrentUser()` returns and what guards populate on `req.user`.
 */
export interface AuthenticatedUser {
  /** Firebase Auth UID — the stable primary key for a user across the system. */
  uid: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}
