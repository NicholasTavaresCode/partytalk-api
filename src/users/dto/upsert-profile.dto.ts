import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
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

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 9,
    description: 'Target overall IELTS band (0.5 increments), 1–9.',
    example: 7.5,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(9)
  targetIeltsBand?: number;
}
