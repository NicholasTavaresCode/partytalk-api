import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { getFirebaseApp } from '../firestore/firebase-app';
import { TokenVerifier, VerifiedToken } from './token-verifier';

/**
 * Firebase-backed implementation of TokenVerifier. Delegates to the Firebase
 * Admin SDK, which validates the token signature, issuer, audience and
 * expiry against Google's public keys.
 */
@Injectable()
export class FirebaseTokenVerifier extends TokenVerifier {
  constructor(private readonly config: ConfigService<AppConfig, true>) {
    super();
  }

  async verify(idToken: string): Promise<VerifiedToken> {
    const app = getFirebaseApp(this.config.get('gcp', { infer: true }));
    const decoded = await app.auth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified,
      name: decoded.name as string | undefined,
      picture: decoded.picture,
    };
  }
}
