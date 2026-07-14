import { ApiProperty } from '@nestjs/swagger';
import { IELTS_SECTIONS, IeltsSection } from './exam.entity';

/** Lifecycle states an attempt moves through: start → submit → score. */
export type AttemptStatus = 'in_progress' | 'submitted' | 'scored';

export const ATTEMPT_STATUSES: AttemptStatus[] = [
  'in_progress',
  'submitted',
  'scored',
];

/**
 * Per-criterion band + feedback returned by rubric (LLM) grading.
 *
 * Declared as a class (not an interface) so `@nestjs/swagger` can reflect it
 * into an OpenAPI schema; plain object literals remain structurally assignable.
 */
export class CriterionScore {
  @ApiProperty({
    description: 'The IELTS band descriptor criterion being scored.',
    example: 'Task Achievement',
  })
  criterion!: string;

  @ApiProperty({
    minimum: 0,
    maximum: 9,
    description: 'Band awarded for this criterion (0–9, 0.5 increments).',
    example: 6.5,
  })
  band!: number;

  @ApiProperty({
    description: 'Examiner-style feedback justifying the criterion band.',
    example:
      'Addresses all parts of the task but develops some ideas more fully than others; a clearer position throughout would lift the response.',
  })
  feedback!: string;
}

/**
 * The outcome of scoring one section. `criteria` is populated for rubric-graded
 * sections; `correctCount`/`total` for objectively scored ones.
 */
export class SectionResult {
  @ApiProperty({
    minimum: 0,
    maximum: 9,
    description: 'Overall band for the section (0–9, 0.5 increments).',
    example: 6.5,
  })
  band!: number;

  @ApiProperty({
    type: () => [CriterionScore],
    required: false,
    description:
      'Per-criterion breakdown, present for rubric-graded sections (writing/speaking).',
  })
  criteria?: CriterionScore[];

  @ApiProperty({
    required: false,
    description:
      'Number of correct answers, present for objectively scored sections (listening/reading).',
    example: 8,
  })
  correctCount?: number;

  @ApiProperty({
    required: false,
    description:
      'Total number of scored questions, present for objectively scored sections.',
    example: 10,
  })
  total?: number;
}

/** A learner's single run against an exam, from start through scoring. */
export class IeltsAttempt {
  @ApiProperty({
    description: 'Unique attempt id (UUID).',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  id!: string;

  @ApiProperty({
    description: 'Google account `sub` of the learner who owns this attempt.',
    example: '110169484474386276334',
  })
  userId!: string;

  @ApiProperty({
    description: 'Id of the exam this attempt is against.',
    example: 'exam-listening-001',
  })
  examId!: string;

  @ApiProperty({
    enum: IELTS_SECTIONS,
    description: 'The IELTS skill assessed, copied from the exam at start.',
    example: 'listening',
  })
  section!: IeltsSection;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Answers keyed by question id.',
    example: { q1: 'B', q2: 'True' },
  })
  responses!: Record<string, string>;

  @ApiProperty({
    enum: ATTEMPT_STATUSES,
    description:
      'Lifecycle state: `in_progress` after start, `submitted` after answers are sent, `scored` once graded.',
    example: 'in_progress',
  })
  status!: AttemptStatus;

  @ApiProperty({
    type: () => SectionResult,
    required: false,
    description: 'Scoring outcome; present only once the attempt is scored.',
  })
  result?: SectionResult;

  @ApiProperty({
    format: 'date-time',
    description: 'When the attempt was started (ISO-8601).',
    example: '2026-07-12T09:30:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'When answers were submitted (ISO-8601), if submitted.',
    example: '2026-07-12T09:45:00.000Z',
  })
  submittedAt?: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'When the attempt was scored (ISO-8601), if scored.',
    example: '2026-07-12T09:46:00.000Z',
  })
  scoredAt?: string;
}
