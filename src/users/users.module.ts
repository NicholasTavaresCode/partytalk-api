import { Module } from '@nestjs/common';
import { FirestoreUsersRepository } from './firestore-users.repository';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/**
 * Feature module for user profiles (arch-feature-modules). Exports UsersService
 * (and the repository token) so other features — e.g. Rooms/IELTS — can resolve
 * user data without reaching into Firestore themselves.
 */
@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: UsersRepository, useClass: FirestoreUsersRepository },
  ],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
