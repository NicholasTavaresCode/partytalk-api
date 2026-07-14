import { ApiProperty } from '@nestjs/swagger';
import { RoomReport } from './room-report.entity';

/** Lifecycle of a practice room. Owner-driven via start/end; `waiting` accepts joins. */
export type RoomStatus = 'waiting' | 'live' | 'ended';

export const ROOM_STATUSES: RoomStatus[] = ['waiting', 'live', 'ended'];

/**
 * A live group English-practice room. Participants talk by voice; the frontend
 * streams speech-to-text as transcript segments. An AI facilitator listens to
 * that transcript, periodically suggests new related topics to push versatility,
 * resilience and creativity, and produces a single report when the room ends.
 *
 * Declared as a class (not an interface) so `@nestjs/swagger` can reflect it
 * into an OpenAPI schema; plain object literals remain structurally assignable.
 */
export class Room {
  @ApiProperty({
    format: 'uuid',
    description: 'Server-minted room id (UUID v4).',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  id!: string;

  @ApiProperty({
    description: 'Seed topic the room opens with.',
    example: 'Weekend plans & small talk',
    minLength: 3,
    maxLength: 120,
  })
  topic!: string;

  @ApiProperty({
    description:
      'Persona/brief that shapes the AI facilitator’s tone and nudges.',
    example: 'A warm, curious facilitator who loves unexpected tangents',
    maxLength: 300,
  })
  facilitatorPersona!: string;

  @ApiProperty({
    enum: ROOM_STATUSES,
    description:
      'Lifecycle state. `waiting` accepts joins; `live` is in session; `ended` is closed.',
    example: 'live',
  })
  status!: RoomStatus;

  @ApiProperty({
    description:
      'Google account `sub` of the creator/owner (always a participant).',
    example: '110169484474386276334',
  })
  ownerId!: string;

  @ApiProperty({
    type: [String],
    description:
      'Google account `sub`s currently in the room (includes the owner).',
    example: ['110169484474386276334', '104638912223344556677'],
  })
  participantIds!: string[];

  @ApiProperty({
    minimum: 2,
    maximum: 5,
    description:
      'Maximum number of participants allowed (capped at 5 while on P2P mesh audio).',
    example: 5,
  })
  maxParticipants!: number;

  @ApiProperty({
    type: () => RoomReport,
    required: false,
    description:
      'End-of-session report — highlights and suggestions. Present only once the room has ended.',
  })
  report?: RoomReport;

  @ApiProperty({
    format: 'date-time',
    description: 'When the room was created (ISO-8601).',
    example: '2026-07-12T18:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When the room was last updated (ISO-8601).',
    example: '2026-07-12T18:42:00.000Z',
  })
  updatedAt!: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'When the room was ended by its owner, if it has ended.',
    example: '2026-07-12T18:45:00.000Z',
  })
  endedAt?: string;
}
