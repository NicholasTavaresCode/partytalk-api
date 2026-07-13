import { IeltsExam, IeltsSection } from './entities/exam.entity';

/**
 * Persistence contract for IELTS exam content, abstracted from Firestore so the
 * service is unit-testable with an in-memory fake (arch-use-repository-pattern).
 * Used as a DI token via `useClass`.
 */
export abstract class ExamsRepository {
  abstract findById(id: string): Promise<IeltsExam | null>;
  abstract listBySection(
    section: IeltsSection,
    limit: number,
  ): Promise<IeltsExam[]>;
  abstract create(exam: IeltsExam): Promise<IeltsExam>;
}
