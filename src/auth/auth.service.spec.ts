import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import { UsersRepository } from '../users/users.repository';
import { AuthService } from './auth.service';
import { IdTokenVerifier, VerifiedIdentity } from './id-token-verifier';

class InMemoryUsersRepository extends UsersRepository {
  store = new Map<string, User>();
  async findById(id: string) {
    return this.store.get(id) ?? null;
  }
  async create(user: User) {
    this.store.set(user.id, user);
    return user;
  }
  async update(id: string, changes: Partial<Omit<User, 'id' | 'createdAt'>>) {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...changes } as User;
    this.store.set(id, updated);
    return updated;
  }
  async delete(id: string) {
    this.store.delete(id);
  }
}

/** Verifier that returns a caller-supplied identity, so tests pick the claims. */
class FakeVerifier extends IdTokenVerifier {
  identity: VerifiedIdentity = {
    sub: 'sub-1',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada',
    picture: 'https://pic',
  };
  shouldThrow = false;
  async verify(): Promise<VerifiedIdentity> {
    if (this.shouldThrow) throw new Error('invalid token');
    return this.identity;
  }
}

describe('AuthService', () => {
  let verifier: FakeVerifier;
  let repo: InMemoryUsersRepository;

  const build = (auth: { allowedAuthDomains?: string[] } = {}): AuthService => {
    const config = {
      get: () => ({
        googleOAuthClientId: 'client-id',
        allowedAuthDomains: auth.allowedAuthDomains ?? [],
      }),
    } as unknown as ConfigService;
    return new AuthService(verifier, repo, config as ConfigService);
  };

  beforeEach(() => {
    verifier = new FakeVerifier();
    repo = new InMemoryUsersRepository();
  });

  it('propagates a verifier failure (invalid/expired token)', async () => {
    verifier.shouldThrow = true;
    await expect(build({}).authenticate('bad')).rejects.toThrow(
      'invalid token',
    );
  });

  it('rejects a token with no email (401 — cannot identify)', async () => {
    verifier.identity = { sub: 'sub-1' };
    await expect(build({}).authenticate('t')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unverified email (403 — policy)', async () => {
    verifier.identity = {
      sub: 'sub-1',
      email: 'a@b.com',
      emailVerified: false,
    };
    await expect(build({}).authenticate('t')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('JIT-provisions a new active user on first login', async () => {
    const principal = await build().authenticate('t');

    expect(principal).toMatchObject({
      uid: 'sub-1',
      email: 'ada@example.com',
      name: 'Ada',
      picture: 'https://pic',
      status: 'active',
    });
    const stored = repo.store.get('sub-1');
    expect(stored).toMatchObject({ id: 'sub-1', status: 'active' });
    expect(stored?.createdAt).toEqual(stored?.updatedAt);
  });

  it('reuses an existing user instead of re-provisioning', async () => {
    const now = new Date().toISOString();
    repo.store.set('sub-1', {
      id: 'sub-1',
      email: 'ada@example.com',
      status: 'active',
      displayName: 'Ada L.',
      createdAt: now,
      updatedAt: now,
    });

    const principal = await build().authenticate('t');

    expect(principal.name).toBe('Ada L.'); // profile display name wins
    expect(repo.store.size).toBe(1);
  });

  it('rejects a disabled account (403)', async () => {
    const now = new Date().toISOString();
    repo.store.set('sub-1', {
      id: 'sub-1',
      email: 'ada@example.com',
      status: 'disabled',
      createdAt: now,
      updatedAt: now,
    });
    await expect(build().authenticate('t')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('domain allow-list', () => {
    it('allows any verified account when the list is empty', async () => {
      await expect(
        build({ allowedAuthDomains: [] }).authenticate('t'),
      ).resolves.toMatchObject({ uid: 'sub-1' });
    });

    it('allows an email in an allowed domain', async () => {
      await expect(
        build({ allowedAuthDomains: ['example.com'] }).authenticate('t'),
      ).resolves.toMatchObject({ uid: 'sub-1' });
    });

    it('rejects an email outside the allowed domains (403)', async () => {
      await expect(
        build({ allowedAuthDomains: ['corp.com'] }).authenticate('t'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.store.size).toBe(0); // never provisioned
    });
  });
});
