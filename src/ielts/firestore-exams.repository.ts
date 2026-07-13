import { Inject, Injectable } from '@nestjs/common';
import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, FIRESTORE } from '../firestore/firestore.constants';
import { IeltsExam, IeltsSection } from './entities/exam.entity';
import { ExamsRepository } from './exams.repository';

/**
 * Firestore-backed ExamsRepository. The document id is the exam id, so lookups
 * are single-document reads. All SDK access is confined here; the service stays
 * persistence-agnostic.
 */
@Injectable()
export class FirestoreExamsRepository extends ExamsRepository {
  constructor(@Inject(FIRESTORE) private readonly firestore: Firestore) {
    super();
  }

  private get collection() {
    return this.firestore.collection(COLLECTIONS.IELTS_EXAMS);
  }

  async findById(id: string): Promise<IeltsExam | null> {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? (snapshot.data() as IeltsExam) : null;
  }

  async listBySection(
    section: IeltsSection,
    limit: number,
  ): Promise<IeltsExam[]> {
    const snapshot = await this.collection
      .where('section', '==', section)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as IeltsExam);
  }

  async create(exam: IeltsExam): Promise<IeltsExam> {
    await this.collection.doc(exam.id).set(exam);
    return exam;
  }
}
