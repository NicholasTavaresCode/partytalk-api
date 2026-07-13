import { IeltsAttempt } from './entities/attempt.entity';

/**
 * Persistence contract for learner attempts, abstracted from Firestore so the
 * service is unit-testable with an in-memory fake (arch-use-repository-pattern).
 * Used as a DI token via `useClass`.
 */
export abstract class AttemptsRepository {
  abstract findById(id: string): Promise<IeltsAttempt | null>;
  abstract create(attempt: IeltsAttempt): Promise<IeltsAttempt>;
  abstract update(
    id: string,
    changes: Partial<Omit<IeltsAttempt, 'id' | 'createdAt'>>,
  ): Promise<IeltsAttempt | null>;
  abstract listByUser(
    userId: string,
    limit: number,
  ): Promise<IeltsAttempt[]>;
}
