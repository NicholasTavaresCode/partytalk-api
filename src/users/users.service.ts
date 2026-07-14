import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { UpsertProfileDto } from './dto/upsert-profile.dto';
import { User } from './entities/user.entity';
import { UsersRepository } from './users.repository';

/**
 * Owns user-profile business rules. A user's id is always their Google `sub`.
 * The account record is JIT-provisioned by AuthService on first login; this
 * service fills in and updates the learner-profile fields on top of it. The
 * create branch below is a defensive fallback for the (normally impossible)
 * case of an upsert arriving before provisioning. Focused single-responsibility
 * service (arch-single-responsibility).
 */
@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async getProfile(id: string): Promise<User> {
    const user = await this.usersRepository.findById(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async upsertProfile(
    authUser: AuthenticatedPrincipal,
    dto: UpsertProfileDto,
  ): Promise<User> {
    const existing = await this.usersRepository.findById(authUser.uid);
    const now = new Date().toISOString();

    if (!existing) {
      return this.usersRepository.create({
        id: authUser.uid,
        email: authUser.email ?? '',
        status: authUser.status,
        displayName: dto.displayName,
        englishLevel: dto.englishLevel,
        targetIeltsBand: dto.targetIeltsBand,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await this.usersRepository.update(authUser.uid, {
      displayName: dto.displayName,
      englishLevel: dto.englishLevel,
      targetIeltsBand: dto.targetIeltsBand,
      email: authUser.email ?? existing.email,
      updatedAt: now,
    });
    // update() only returns null if the row vanished between read and write.
    return updated ?? this.getProfile(authUser.uid);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.usersRepository.delete(id);
  }
}
