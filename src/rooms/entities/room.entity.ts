import { ApiProperty } from '@nestjs/swagger';
import { RoomReport } from './room-report.entity';

/**
 * Lifecycle of a practice room. The owner starts it; it ends when its time runs
 * out or when the owner ends it early. `waiting` accepts joins.
 */
export type RoomStatus = 'waiting' | 'live' | 'ended';

export const ROOM_STATUSES: RoomStatus[] = ['waiting', 'live', 'ended'];

/** Session lengths a room can be created with, in minutes. */
export type RoomDurationMinutes = 10 | 15 | 30 | 45 | 60;

export const ROOM_DURATION_MINUTES: RoomDurationMinutes[] = [
  10, 15, 30, 45, 60,
];

/** Applied when the creator does not pick a length. */
export const DEFAULT_ROOM_DURATION_MINUTES: RoomDurationMinutes = 30;

/**
 * A live group English-practice room. Participants talk by voice; the frontend
 * streams speech-to-text as transcript segments. An AI host is always in the
 * room listening to that transcript; once a topic has been talked about enough
 * it speaks up and moves the group onto a completely different one, and it
 * produces a single report when the room ends.
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
    description:
      'Topic the room opens with — typed by the creator, or picked by the AI host when `hostPicksTopic` was set. The host later moves the room onto new, unrelated topics (see host messages).',
    example: 'Weekend plans & small talk',
    minLength: 3,
    maxLength: 120,
  })
  topic!: string;

  @ApiProperty({
    description:
      'Whether the AI host picked the opening topic (`hostPicksTopic` at creation) rather than the creator.',
    example: false,
  })
  topicPickedByHost!: boolean;

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
    minimum: 1,
    maximum: 5,
    description:
      'Maximum number of participants allowed (1 for a solo test room; capped at 5 while on P2P mesh audio).',
    example: 5,
  })
  maxParticipants!: number;

  @ApiProperty({
    enum: ROOM_DURATION_MINUTES,
    description:
      'Session length in minutes, chosen at creation. The clock starts at `startedAt`; the room ends automatically at `scheduledEndAt` unless the owner ends it first.',
    example: 30,
  })
  durationMinutes!: RoomDurationMinutes;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'When the owner started the session. Absent while `waiting`.',
    example: '2026-07-12T18:15:00.000Z',
  })
  startedAt?: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description:
      '`startedAt` + `durationMinutes`: when the session ends automatically unless the owner ends it earlier. Absent while `waiting`.',
    example: '2026-07-12T18:45:00.000Z',
  })
  scheduledEndAt?: string;

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
    description:
      'When the session actually ended — by the owner, or automatically when its time ran out. Absent until then.',
    example: '2026-07-12T18:45:00.000Z',
  })
  endedAt?: string;
}
