import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional body for joining: an invite-link code for callers not yet invited. */
export class JoinRoomDto {
  @ApiPropertyOptional({
    description:
      'Code from the owner’s invite link. Lets a signed-in caller who is not on the invite list join; their email is then added to the list.',
    example: 'q3Zl0tqS2mVJ8vV1i0b2Pw',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  inviteCode?: string;
}
