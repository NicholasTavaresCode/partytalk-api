import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Reusable pagination query params. `@Type` coerces the incoming string query
 * values to numbers before validation (works with the global transforming
 * ValidationPipe).
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum number of items to return.',
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
