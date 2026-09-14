import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  DEFAULT_ROOM_DURATION_MINUTES,
  ROOM_DURATION_MINUTES,
  RoomDurationMinutes,
} from '../entities/room.entity';

/**
 * Payload to open a new practice room. Every field is validated
 * (security-validate-all-input); unknown fields are stripped by the global
 * whitelisting ValidationPipe. The opening topic comes from the creator or —
 * with `hostPicksTopic` — from the AI host. `maxParticipants` and
 * `durationMinutes` are optional; the service applies sensible defaults.
 */
export class CreateRoomDto {
  @ApiPropertyOptional({
    description:
      'Conversation topic the room opens with. Required unless `hostPicksTopic` is true, in which case it is ignored.',
    example: 'Weekend plans & small talk',
    minLength: 3,
    maxLength: 120,
  })
  // Only validated when the creator is the one picking the topic.
  @ValidateIf((dto: CreateRoomDto) => !dto.hostPicksTopic)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  topic?: string;

  @ApiPropertyOptional({
    description:
      'Let the AI host pick the opening topic. When true, `topic` may be omitted (it is ignored if sent) and the created room’s `topic` is the host’s pick. Defaults to false.',
    default: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  hostPicksTopic?: boolean;

  @ApiPropertyOptional({
    description:
      'Maximum number of participants (1–5). Use 1 for a solo test room. Capped at 5 while voice runs over P2P mesh WebRTC; see docs/audio-architecture.md. Defaults to 5.',
    example: 5,
    minimum: 1,
    maximum: 5,
    default: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxParticipants?: number;

  @ApiPropertyOptional({
    description:
      'How long the session lasts once started, in minutes. The room ends automatically when the time is up. Defaults to 30.',
    enum: ROOM_DURATION_MINUTES,
    default: DEFAULT_ROOM_DURATION_MINUTES,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @IsIn(ROOM_DURATION_MINUTES)
  durationMinutes?: RoomDurationMinutes;
}
