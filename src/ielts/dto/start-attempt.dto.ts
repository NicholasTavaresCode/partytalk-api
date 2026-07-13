import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload to start an attempt against an exam. Validated
 * (security-validate-all-input); unknown fields are stripped by the global
 * whitelisting ValidationPipe.
 */
export class StartAttemptDto {
  @ApiProperty({
    description: 'Id of the exam to start an attempt against.',
    example: 'exam-listening-001',
  })
  @IsString()
  @IsNotEmpty()
  examId!: string;
}
