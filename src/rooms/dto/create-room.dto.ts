import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Payload to open a new practice room. Every field is validated
 * (security-validate-all-input); unknown fields are stripped by the global
 * whitelisting ValidationPipe. `facilitatorPersona` and `maxParticipants` are
 * optional — the service applies sensible defaults.
 */
export class CreateRoomDto {
  @ApiProperty({
    description: 'Conversation topic the room is centered on.',
    example: 'Weekend plans & small talk',
    minLength: 3,
    maxLength: 120,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  topic!: string;

  @ApiPropertyOptional({
    description:
      'Persona/brief that shapes the AI facilitator’s tone and topic nudges. Defaults to a warm, curious facilitator.',
    example: 'A warm, curious facilitator who loves unexpected tangents',
    maxLength: 300,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  facilitatorPersona?: string;

  @ApiPropertyOptional({
    description:
      'Maximum number of participants (2–5). Capped at 5 while voice runs over P2P mesh WebRTC; see docs/audio-architecture.md. Defaults to 5.',
    example: 5,
    minimum: 2,
    maximum: 5,
    default: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(5)
  maxParticipants?: number;
}
