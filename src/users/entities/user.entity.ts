import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '../../common/interfaces/authenticated-principal.interface';

/** English proficiency band a learner self-selects, used to tailor room + exam difficulty. */
export type EnglishLevel =
  | 'beginner'
  | 'elementary'
  | 'intermediate'
  | 'upper-intermediate'
  | 'advanced';

export const ENGLISH_LEVELS: EnglishLevel[] = [
  'beginner',
  'elementary',
  'intermediate',
  'upper-intermediate',
  'advanced',
];

/**
 * A PartyTalk user. `id` is the Google account `sub` — we do not mint our own
 * user ids, keeping identity consistent across Google Identity, Firestore and
 * realtime sockets. The record is JIT-provisioned on first login with just
 * identity + `status`; the learner-profile fields (`displayName`,
 * `englishLevel`, `targetIeltsBand`) are filled in later via `PUT /users/me`
 * and so are optional here.
 *
 * Declared as a class (not an interface) so `@nestjs/swagger` can reflect it
 * into an OpenAPI schema; plain object literals remain structurally assignable.
 */
export class User {
  @ApiProperty({
    description: 'Google account `sub` — the stable primary key for the user.',
    example: '110169484474386276334',
  })
  id!: string;

  @ApiProperty({
    format: 'email',
    description: 'Email from the verified token; empty if the token has none.',
    example: 'ada@example.com',
  })
  email!: string;

  @ApiProperty({
    enum: ['active', 'disabled'],
    description:
      'Account status. A disabled account is denied access at the guard.',
    example: 'active',
  })
  status!: AccountStatus;

  @ApiProperty({
    required: false,
    description: 'Public display name shown in rooms.',
    example: 'Ada Lovelace',
    minLength: 1,
    maxLength: 60,
  })
  displayName?: string;

  @ApiProperty({
    required: false,
    enum: ENGLISH_LEVELS,
    description: 'Self-assessed English proficiency band.',
    example: 'intermediate',
  })
  englishLevel?: EnglishLevel;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 9,
    description: 'Target overall IELTS band the learner is aiming for.',
    example: 7.5,
  })
  targetIeltsBand?: number;

  @ApiProperty({
    format: 'date-time',
    description: 'When the profile was first created (ISO-8601).',
    example: '2026-07-01T12:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When the profile was last updated (ISO-8601).',
    example: '2026-07-12T09:30:00.000Z',
  })
  updatedAt!: string;
}
