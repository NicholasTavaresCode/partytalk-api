import { ApiProperty } from '@nestjs/swagger';

/**
 * The four skills assessed by IELTS. Listening/Reading are objectively scored
 * against an answer key; Writing/Speaking are graded by the LLM against the
 * official band-descriptor rubric.
 */
export type IeltsSection = 'listening' | 'reading' | 'writing' | 'speaking';

export const IELTS_SECTIONS: IeltsSection[] = [
  'listening',
  'reading',
  'writing',
  'speaking',
];

/**
 * A single question within an exam. `answerKey` is present for objectively
 * scored sections (listening/reading) and absent for the productive sections
 * (writing/speaking) which are rubric-graded.
 *
 * Declared as a class (not an interface) so `@nestjs/swagger` can reflect it
 * into an OpenAPI schema; plain object literals remain structurally assignable.
 */
export class ExamQuestion {
  @ApiProperty({
    description: 'Stable question id; used as the key in an attempt’s answers.',
    example: 'q1',
  })
  id!: string;

  @ApiProperty({
    description: 'The question prompt shown to the learner.',
    example:
      'The speaker recommends booking tickets at least ___ days in advance.',
  })
  prompt!: string;

  @ApiProperty({
    required: false,
    description:
      'Expected answer for objectively scored sections (listening/reading). Absent for writing/speaking, which are rubric-graded.',
    example: 'three',
  })
  answerKey?: string;
}

/** A unit of IELTS exam content a learner attempts. */
export class IeltsExam {
  @ApiProperty({
    description: 'Unique exam id.',
    example: 'exam-listening-001',
  })
  id!: string;

  @ApiProperty({
    enum: IELTS_SECTIONS,
    description: 'The IELTS skill this exam assesses.',
    example: 'listening',
  })
  section!: IeltsSection;

  @ApiProperty({
    description: 'Human-readable exam title.',
    example: 'Listening Practice Test 1 — Booking a Tour',
  })
  title!: string;

  @ApiProperty({
    type: () => [ExamQuestion],
    description: 'Ordered list of questions that make up the exam.',
  })
  questions!: ExamQuestion[];

  @ApiProperty({
    format: 'date-time',
    description: 'When the exam was created (ISO-8601).',
    example: '2026-07-01T12:00:00.000Z',
  })
  createdAt!: string;
}
