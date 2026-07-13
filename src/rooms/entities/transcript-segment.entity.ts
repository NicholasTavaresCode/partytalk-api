import { ApiProperty } from '@nestjs/swagger';

/**
 * A single utterance in a room's voice transcript, produced by client-side
 * speech-to-text and streamed to the backend in real time. The AI facilitator
 * reads a rolling window of these to decide when (and what) to suggest.
 *
 * Declared as a class so `@nestjs/swagger` can reflect it; object literals stay
 * structurally assignable.
 */
export class TranscriptSegment {
  @ApiProperty({
    format: 'uuid',
    description: 'Server-minted segment id (UUID v4).',
    example: 'c4d2e3f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Id of the room this segment belongs to.',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  roomId!: string;

  @ApiProperty({
    description: 'Firebase UID of the participant who spoke this segment.',
    example: 'aXbQ1m9Zt0Yc3kLpR7sVwE2fH1',
  })
  speakerId!: string;

  @ApiProperty({
    required: false,
    description: 'Display name of the speaker, if known (for nicer transcripts).',
    example: 'Ada',
  })
  speakerName?: string;

  @ApiProperty({
    description: 'Transcribed text of the utterance.',
    example: 'This weekend I’m planning to visit the coast with some friends.',
    minLength: 1,
    maxLength: 2000,
  })
  text!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When the utterance was spoken/transcribed (ISO-8601).',
    example: '2026-07-12T18:12:04.000Z',
  })
  at!: string;
}
