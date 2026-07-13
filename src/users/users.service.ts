import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { UpsertProfileDto } from './dto/upsert-profile.dto';
import { User } from './entities/user.entity';
import { UsersRepository } from './users.repository';

/**
 * Owns user-profile business rules. A user's id is always their Firebase UID,
 * so there is no separate "create account" flow — the first upsert after
 * sign-in materializes the profile. Focused single-responsibility service
 * (arch-single-responsibility).
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
    authUser: AuthenticatedUser,
    dto: UpsertProfileDto,
  ): Promise<User> {
    const existing = await this.usersRepository.findById(authUser.uid);
    const now = new Date().toISOString();

    if (!existing) {
      return this.usersRepository.create({
        id: authUser.uid,
        email: authUser.email ?? '',
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
