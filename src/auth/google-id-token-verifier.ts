import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { AppConfig } from '../config/configuration';
import { IdTokenVerifier, VerifiedIdentity } from './id-token-verifier';

/**
 * Verifies Google Identity ("Sign in with Google") ID tokens with
 * google-auth-library. `verifyIdToken` checks the signature against Google's
 * public keys and asserts the issuer, expiry and — critically — that the token's
 * audience matches our OAuth client id, so a token minted for another app is
 * rejected. Deliberately not Firebase Auth: the frontend does the Google sign-in
 * and the API only verifies the resulting token (no sessions/cookies).
 */
@Injectable()
export class GoogleIdTokenVerifier extends IdTokenVerifier {
  private readonly clientId: string;
  private readonly client: OAuth2Client;

  constructor(config: ConfigService<AppConfig, true>) {
    super();
    this.clientId = config.get('auth', { infer: true }).googleOAuthClientId;
    this.client = new OAuth2Client(this.clientId);
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    const ticket = await this.client.verifyIdToken({
      idToken,
      audience: this.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      throw new UnauthorizedException('Token payload was empty');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified,
      name: payload.name,
      picture: payload.picture,
    };
  }
}
