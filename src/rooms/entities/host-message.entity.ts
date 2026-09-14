import { ApiProperty } from '@nestjs/swagger';

/** What prompted the host to be consulted. */
export type HostTrigger = 'volume' | 'silence' | 'manual';

export const HOST_TRIGGERS: HostTrigger[] = ['volume', 'silence', 'manual'];

/**
 * A line the AI host said to the room. The host is always in the room and keeps
 * listening to the transcript; when it judges the current topic has been talked
 * about enough (or the room has gone quiet) it steps in and moves the group onto
 * a completely different topic — e.g. "Ok. Now let's talk about the Usain Bolt
 * record." — so participants must adapt on the spot and practise English across
 * unrelated subjects.
 *
 * Declared as a class so `@nestjs/swagger` can reflect it; object literals stay
 * structurally assignable.
 */
export class HostMessage {
  @ApiProperty({
    format: 'uuid',
    description: 'Server-minted message id (UUID v4).',
    example: 'd5e3f4a6-7b8c-4d9e-0f1a-2b3c4d5e6f70',
  })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Id of the room the host spoke in.',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  roomId!: string;

  @ApiProperty({
    description:
      'Exactly what the host says to the room, in its own voice. Clients show and/or voice this line verbatim.',
    example: "Ok. Now let's talk about the Usain Bolt record.",
  })
  message!: string;

  @ApiProperty({
    description:
      'The new topic the host moved the room onto — deliberately unrelated to the previous one.',
    example: "Usain Bolt's 100m world record",
  })
  topic!: string;

  @ApiProperty({
    description: 'Short note on why the host stepped in at this moment.',
    example:
      'The group has been circling weekend plans for a while and is running out of things to say.',
  })
  reason!: string;

  @ApiProperty({
    enum: HOST_TRIGGERS,
    description:
      'What prompted the host to be consulted: `volume` (enough had been said since its last check), `silence` (the room went quiet), or `manual` (someone asked for a new topic).',
    example: 'volume',
  })
  trigger!: HostTrigger;

  @ApiProperty({
    format: 'date-time',
    description: 'When the host spoke (ISO-8601).',
    example: '2026-07-12T18:20:00.000Z',
  })
  at!: string;
}
