import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { User } from './entities/user.entity';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

class InMemoryUsersRepository extends UsersRepository {
  private store = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    return this.store.get(id) ?? null;
  }
  async create(user: User): Promise<User> {
    this.store.set(user.id, user);
    return user;
  }
  async update(
    id: string,
    changes: Partial<Omit<User, 'id' | 'createdAt'>>,
  ): Promise<User | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...changes };
    this.store.set(id, updated);
    return updated;
  }
  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

describe('UsersService', () => {
  let service: UsersService;
  let repo: InMemoryUsersRepository;

  const authUser: AuthenticatedPrincipal = {
    uid: 'uid-1',
    email: 'learner@example.com',
    status: 'active',
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useClass: InMemoryUsersRepository },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
    repo = moduleRef.get(UsersRepository);
  });

  describe('getProfile', () => {
    it('throws NotFound when the user does not exist', async () => {
      await expect(service.getProfile('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the stored user', async () => {
      const now = new Date().toISOString();
      await repo.create({
        id: 'uid-1',
        email: 'learner@example.com',
        displayName: 'Ada',
        englishLevel: 'intermediate',
        createdAt: now,
        updatedAt: now,
      });

      await expect(service.getProfile('uid-1')).resolves.toMatchObject({
        id: 'uid-1',
        displayName: 'Ada',
      });
    });
  });

  describe('upsertProfile', () => {
    it('creates a new profile keyed by the auth uid', async () => {
      const result = await service.upsertProfile(authUser, {
        displayName: 'Ada',
        englishLevel: 'advanced',
        targetIeltsBand: 7.5,
      });

      expect(result.id).toBe('uid-1');
      expect(result.email).toBe('learner@example.com');
      expect(result.displayName).toBe('Ada');
      expect(result.targetIeltsBand).toBe(7.5);
      expect(result.createdAt).toEqual(result.updatedAt);
      expect(await repo.findById('uid-1')).not.toBeNull();
    });

    it('updates an existing profile without changing createdAt', async () => {
      const created = await service.upsertProfile(authUser, {
        displayName: 'Ada',
        englishLevel: 'beginner',
      });

      const updated = await service.upsertProfile(authUser, {
        displayName: 'Ada Lovelace',
        englishLevel: 'intermediate',
      });

      expect(updated.displayName).toBe('Ada Lovelace');
      expect(updated.englishLevel).toBe('intermediate');
      expect(updated.createdAt).toBe(created.createdAt);
    });

    it('falls back to a placeholder email when the token has none', async () => {
      const result = await service.upsertProfile(
        { uid: 'uid-2', status: 'active' },
        { displayName: 'Anon', englishLevel: 'elementary' },
      );
      expect(result.email).toBe('');
    });
  });

  describe('deleteProfile', () => {
    it('removes the user', async () => {
      await service.upsertProfile(authUser, {
        displayName: 'Ada',
        englishLevel: 'beginner',
      });
      await service.deleteProfile('uid-1');
      await expect(service.getProfile('uid-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
