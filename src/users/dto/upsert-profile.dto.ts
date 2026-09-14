import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { EnglishLevel, ENGLISH_LEVELS } from '../entities/user.entity';

/**
 * Payload to create or update the caller's own profile. Every field is
 * validated (security-validate-all-input); unknown fields are stripped by the
 * global whitelisting ValidationPipe.
 */
export class UpsertProfileDto {
  @ApiProperty({
    description: 'Public display name shown in rooms.',
    example: 'Ada Lovelace',
    minLength: 1,
    maxLength: 60,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  displayName!: string;

  @ApiProperty({
    enum: ENGLISH_LEVELS,
    description: 'Self-assessed English proficiency band.',
    example: 'intermediate',
  })
  @IsIn(ENGLISH_LEVELS)
  englishLevel!: EnglishLevel;
}
