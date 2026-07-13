import { ApiProperty } from '@nestjs/swagger';

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
 * A PartyTalk user. `id` is the Firebase Auth UID — we do not mint our own user
 * ids, keeping identity consistent across Auth, Firestore and realtime sockets.
 *
 * Declared as a class (not an interface) so `@nestjs/swagger` can reflect it
 * into an OpenAPI schema; plain object literals remain structurally assignable.
 */
export class User {
  @ApiProperty({
    description: 'Firebase Auth UID — the stable primary key for the user.',
    example: 'aXbQ1m9Zt0Yc3kLpR7sVwE2fH1',
  })
  id!: string;

  @ApiProperty({
    format: 'email',
    description: 'Email from the verified token; empty if the token has none.',
    example: 'ada@example.com',
  })
  email!: string;

  @ApiProperty({
    description: 'Public display name shown in rooms.',
    example: 'Ada Lovelace',
    minLength: 1,
    maxLength: 60,
  })
  displayName!: string;

  @ApiProperty({
    enum: ENGLISH_LEVELS,
    description: 'Self-assessed English proficiency band.',
    example: 'intermediate',
  })
  englishLevel!: EnglishLevel;

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
