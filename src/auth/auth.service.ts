import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { AppConfig } from '../config/configuration';
import { User } from '../users/entities/user.entity';
import { UsersRepository } from '../users/users.repository';
import { IdTokenVerifier, VerifiedIdentity } from './id-token-verifier';

/**
 * Turns a Google ID token into an AuthenticatedPrincipal. The IdTokenVerifier
 * answers "is this token genuine?", and this service applies account policy on
 * top of it. Every authenticated user has the same access — there are no roles.
 *
 * Pipeline: verify → require a verified email → enforce the optional email /
 * Workspace-domain allow-lists → find-or-JIT-provision the user → reject a
 * disabled account → resolve the principal. Identity problems surface as 401; policy
 * problems (wrong domain, disabled) as 403.
 */
@Injectable()
export class AuthService {
  private readonly allowedDomains: string[];
  private readonly allowedEmails: string[];

  constructor(
    private readonly verifier: IdTokenVerifier,
    private readonly usersRepository: UsersRepository,
    config: ConfigService<AppConfig, true>,
  ) {
    const auth = config.get('auth', { infer: true });
    this.allowedDomains = auth.allowedAuthDomains;
    this.allowedEmails = auth.allowedAuthEmails ?? [];
  }

  /** Verify a raw bearer token and resolve the caller to a principal. */
  async authenticate(idToken: string): Promise<AuthenticatedPrincipal> {
    const identity = await this.verifier.verify(idToken);

    if (!identity.email) {
      // No email claim — we cannot identify the account.
      throw new UnauthorizedException('Token has no email claim');
    }
    if (!identity.emailVerified) {
      throw new ForbiddenException('Email is not verified');
    }
    this.enforceAllowLists(identity.email);

    const user = await this.findOrProvision(identity);
    if (user.status === 'disabled') {
      throw new ForbiddenException('Account is disabled');
    }

    return this.toPrincipal(user, identity);
  }

  /**
   * With neither list set, sign-up is open to any verified Google account.
   * Otherwise the email must be listed exactly or belong to a listed domain —
   * checked before provisioning, so a refused account never gets a user record.
   */
  private enforceAllowLists(email: string): void {
    if (this.allowedDomains.length === 0 && this.allowedEmails.length === 0) {
      return;
    }
    const normalized = email.toLowerCase();
    const domain = normalized.split('@')[1];
    if (
      this.allowedEmails.includes(normalized) ||
      (!!domain && this.allowedDomains.includes(domain))
    ) {
      return;
    }
    throw new ForbiddenException('This account is not allowed to sign in');
  }

  /**
   * Look up the user by their Google `sub`, provisioning a minimal record on
   * first login (the profile is enriched later via `PUT /users/me`). The
   * document is keyed by the sub so identity is stable across sign-ins.
   */
  private async findOrProvision(identity: VerifiedIdentity): Promise<User> {
    const existing = await this.usersRepository.findById(identity.sub);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    return this.usersRepository.create({
      id: identity.sub,
      email: identity.email ?? '',
      displayName: identity.name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  private toPrincipal(
    user: User,
    identity: VerifiedIdentity,
  ): AuthenticatedPrincipal {
    return {
      uid: user.id,
      email: user.email,
      emailVerified: identity.emailVerified,
      name: user.displayName ?? identity.name,
      picture: identity.picture,
      status: user.status,
    };
  }
}
