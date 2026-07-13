import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { IELTS_SECTIONS, IeltsSection } from '../entities/exam.entity';

/**
 * Query params for listing exams by section. `section` is validated against the
 * known IELTS sections (BadRequest otherwise); `limit` mirrors PaginationQueryDto
 * and is coerced from the query string by the global transforming ValidationPipe.
 */
export class ListExamsQueryDto {
  @ApiProperty({
    enum: IELTS_SECTIONS,
    description: 'IELTS skill to list exams for.',
    example: 'listening',
  })
  @IsIn(IELTS_SECTIONS)
  section!: IeltsSection;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Maximum number of exams to return.',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
