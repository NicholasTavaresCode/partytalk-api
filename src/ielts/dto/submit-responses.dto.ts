import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * Payload submitting a learner's answers, keyed by question id. Modelled as a
 * free-form string→string map; `@IsObject()` guards the shape while keeping the
 * per-question keys open (exam-defined). Unknown top-level fields are stripped
 * by the global whitelisting ValidationPipe (security-validate-all-input).
 */
export class SubmitResponsesDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Answers keyed by question id.',
    example: { q1: 'B', q2: 'True' },
  })
  @IsObject()
  responses!: Record<string, string>;
}
