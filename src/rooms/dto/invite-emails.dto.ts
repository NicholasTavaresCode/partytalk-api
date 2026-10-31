import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail } from 'class-validator';
import { MAX_INVITES } from '../room-access';

/** Emails the owner is adding to a room's invite list. */
export class InviteEmailsDto {
  @ApiProperty({
    type: [String],
    description:
      'Emails of Google accounts to invite (case-insensitive). Already-invited addresses are ignored.',
    example: ['bo@example.com'],
    minItems: 1,
    maxItems: MAX_INVITES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVITES)
  @IsEmail({}, { each: true })
  emails!: string[];
}
