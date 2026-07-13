import { Inject, Injectable } from '@nestjs/common';
import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, FIRESTORE } from '../firestore/firestore.constants';
import { IeltsAttempt } from './entities/attempt.entity';
import { AttemptsRepository } from './attempts.repository';

/**
 * Firestore-backed AttemptsRepository. The document id is the attempt id, so
 * lookups are single-document reads. All SDK access is confined here; the
 * service stays persistence-agnostic.
 */
@Injectable()
export class FirestoreAttemptsRepository extends AttemptsRepository {
  constructor(@Inject(FIRESTORE) private readonly firestore: Firestore) {
    super();
  }

  private get collection() {
    return this.firestore.collection(COLLECTIONS.IELTS_ATTEMPTS);
  }

  async findById(id: string): Promise<IeltsAttempt | null> {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? (snapshot.data() as IeltsAttempt) : null;
  }

  async create(attempt: IeltsAttempt): Promise<IeltsAttempt> {
    await this.collection.doc(attempt.id).set(attempt);
    return attempt;
  }

  async update(
    id: string,
    changes: Partial<Omit<IeltsAttempt, 'id' | 'createdAt'>>,
  ): Promise<IeltsAttempt | null> {
    const ref = this.collection.doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return null;
    }
    await ref.set(changes, { merge: true });
    const updated = await ref.get();
    return updated.data() as IeltsAttempt;
  }

  async listByUser(userId: string, limit: number): Promise<IeltsAttempt[]> {
    const snapshot = await this.collection
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as IeltsAttempt);
  }
}
