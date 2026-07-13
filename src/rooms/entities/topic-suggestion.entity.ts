import { ApiProperty } from '@nestjs/swagger';

/** What prompted the facilitator to suggest a topic. */
export type SuggestionTrigger = 'volume' | 'silence' | 'manual';

export const SUGGESTION_TRIGGERS: SuggestionTrigger[] = [
  'volume',
  'silence',
  'manual',
];

/**
 * An AI-generated nudge that steers the conversation toward a new, related
 * topic to keep participants practising with versatility and creativity.
 *
 * Declared as a class so `@nestjs/swagger` can reflect it; object literals stay
 * structurally assignable.
 */
export class TopicSuggestion {
  @ApiProperty({
    format: 'uuid',
    description: 'Server-minted suggestion id (UUID v4).',
    example: 'd5e3f4a6-7b8c-4d9e-0f1a-2b3c4d5e6f70',
  })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Id of the room the suggestion was made in.',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  roomId!: string;

  @ApiProperty({
    description: 'The new topic/prompt to pivot the conversation toward.',
    example:
      'You mentioned the coast — if you could live on any coastline in the world, where and why?',
  })
  topic!: string;

  @ApiProperty({
    description:
      'Short rationale tying the suggestion back to what was just being discussed.',
    example: 'Builds on the coast/travel thread but pushes toward opinion and reasoning.',
  })
  rationale!: string;

  @ApiProperty({
    enum: SUGGESTION_TRIGGERS,
    description:
      'What caused the suggestion: `volume` (enough was said), `silence` (the talk stalled), or `manual` (someone asked).',
    example: 'volume',
  })
  trigger!: SuggestionTrigger;

  @ApiProperty({
    format: 'date-time',
    description: 'When the suggestion was generated (ISO-8601).',
    example: '2026-07-12T18:20:00.000Z',
  })
  at!: string;
}
