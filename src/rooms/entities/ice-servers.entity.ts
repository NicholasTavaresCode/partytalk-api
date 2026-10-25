import { ApiProperty } from '@nestjs/swagger';

/** One entry of `RTCConfiguration.iceServers`, passed to the browser as-is. */
export class IceServer {
  @ApiProperty({
    type: [String],
    description: 'STUN or TURN URLs.',
    example: ['turn:203.0.113.7:3478?transport=udp'],
  })
  urls!: string[];

  @ApiProperty({
    required: false,
    description:
      'TURN only: `<expiry unix seconds>:<uid>` (coturn `use-auth-secret`).',
    example: '1767225600:110169484474386276334',
  })
  username?: string;

  @ApiProperty({
    required: false,
    description:
      'TURN only: base64 HMAC-SHA1 of `username` with the relay secret.',
    example: 'q3Zl0tqS2mVJ8vV1i0b2PwAbCdE=',
  })
  credential?: string;
}

export class IceServers {
  @ApiProperty({
    type: () => [IceServer],
    description:
      'STUN servers, plus the TURN relay with a time-limited credential when one is configured.',
  })
  iceServers!: IceServer[];

  @ApiProperty({
    description:
      'Seconds until the TURN credential expires — fetch again after reconnecting.',
    example: 21600,
  })
  ttlSeconds!: number;
}
