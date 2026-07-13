import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Ingest one transcript segment over REST (an alternative to the realtime
 * `transcript` socket event, handy for testing and non-socket clients). The
 * speaker is always the authenticated caller, so no uid is accepted in the body.
 */
export class PostTranscriptDto {
  @ApiProperty({
    description: 'Transcribed text of the utterance (from client speech-to-text).',
    example: 'This weekend I’m planning to visit the coast with some friends.',
    minLength: 1,
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  @ApiProperty({
    required: false,
    description: 'Optional display name for the speaker on the transcript.',
    example: 'Ada',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  speakerName?: string;
}
