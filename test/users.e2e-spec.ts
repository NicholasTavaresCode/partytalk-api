import { VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { HttpAdapterHost } from '@nestjs/core';
import {
  IdTokenVerifier,
  VerifiedIdentity,
} from '../src/auth/id-token-verifier';
import { FIRESTORE } from '../src/firestore/firestore.constants';
import { User } from '../src/users/entities/user.entity';
import { UsersRepository } from '../src/users/users.repository';

/** In-memory UsersRepository so the suite needs no real Firestore. */
class InMemoryUsersRepository extends UsersRepository {
  private store = new Map<string, User>();
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

/** Verifier that trusts the bearer token as the Google `sub` — lets tests pick an identity. */
class FakeIdTokenVerifier extends IdTokenVerifier {
  async verify(idToken: string): Promise<VerifiedIdentity> {
    if (idToken === 'invalid') throw new Error('bad token');
    return {
      sub: idToken,
      email: `${idToken}@example.com`,
      emailVerified: true,
    };
  }
}

describe('Users (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(FIRESTORE)
      .useValue({ listCollections: async () => [] })
      .overrideProvider(IdTokenVerifier)
      .useClass(FakeIdTokenVerifier)
      .overrideProvider(UsersRepository)
      .useClass(InMemoryUsersRepository)
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // Filter needs the http adapter; register it explicitly for the test app.
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health/live is public', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.status).toBe('ok');
      });
  });

  it('rejects unauthenticated access to /users/me', () => {
    return request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
  });

  it('rejects an invalid token', () => {
    return request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
  });

  it('auto-provisions the caller on first authenticated request', () => {
    // JIT provisioning happens in the guard, so GET /users/me returns the freshly
    // created record (active) even before the profile is filled in.
    return request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer carol')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.id).toBe('carol');
        expect(res.body.data.email).toBe('carol@example.com');
        expect(res.body.data.status).toBe('active');
        expect(res.body.data.displayName).toBeUndefined();
      });
  });

  it('GET /api/v1/auth/me echoes the resolved principal', () => {
    return request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer dave')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.uid).toBe('dave');
        expect(res.body.data.email).toBe('dave@example.com');
        expect(res.body.data.status).toBe('active');
      });
  });

  it('creates then reads the caller profile (upsert)', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/users/me')
      .set('Authorization', 'Bearer alice')
      .send({
        displayName: 'Alice',
        englishLevel: 'intermediate',
        targetIeltsBand: 7,
      })
      .expect(200)
      .expect((res) => {
        expect(res.body.data.id).toBe('alice');
        expect(res.body.data.email).toBe('alice@example.com');
        expect(res.body.meta.timestamp).toBeDefined();
      });

    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer alice')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.displayName).toBe('Alice');
      });
  });

  it('rejects invalid profile payloads (validation pipe)', () => {
    return request(app.getHttpServer())
      .put('/api/v1/users/me')
      .set('Authorization', 'Bearer bob')
      .send({ displayName: '', englishLevel: 'fluent', extra: 'nope' })
      .expect(400);
  });
});
