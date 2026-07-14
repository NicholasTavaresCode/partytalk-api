import { Inject, Injectable } from '@nestjs/common';
import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, FIRESTORE } from '../firestore/firestore.constants';
import { User } from './entities/user.entity';
import { UsersRepository } from './users.repository';

/**
 * Firestore-backed UsersRepository. The document id is the user's Google account
 * `sub`, so lookups are single-document reads (no queries, no N+1). All SDK access is
 * confined here; the service stays persistence-agnostic.
 */
@Injectable()
export class FirestoreUsersRepository extends UsersRepository {
  constructor(@Inject(FIRESTORE) private readonly firestore: Firestore) {
    super();
  }

  private get collection() {
    return this.firestore.collection(COLLECTIONS.USERS);
  }

  async findById(id: string): Promise<User | null> {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? (snapshot.data() as User) : null;
  }

  async create(user: User): Promise<User> {
    await this.collection.doc(user.id).set(user);
    return user;
  }

  async update(
    id: string,
    changes: Partial<Omit<User, 'id' | 'createdAt'>>,
  ): Promise<User | null> {
    const ref = this.collection.doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return null;
    }
    await ref.set(changes, { merge: true });
    const updated = await ref.get();
    return updated.data() as User;
  }

  async delete(id: string): Promise<void> {
    await this.collection.doc(id).delete();
  }
}
