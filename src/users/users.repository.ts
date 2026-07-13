import { User } from './entities/user.entity';

/**
 * Persistence contract for users, abstracted from Firestore so the service is
 * unit-testable with an in-memory fake (arch-use-repository-pattern). Used as a
 * DI token via `useClass`.
 */
export abstract class UsersRepository {
  abstract findById(id: string): Promise<User | null>;
  abstract create(user: User): Promise<User>;
  abstract update(
    id: string,
    changes: Partial<Omit<User, 'id' | 'createdAt'>>,
  ): Promise<User | null>;
  abstract delete(id: string): Promise<void>;
}
