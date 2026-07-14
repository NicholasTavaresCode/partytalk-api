import { ApiProperty } from '@nestjs/swagger';

/** Account lifecycle state. A `disabled` account authenticates but is denied access. */
export type AccountStatus = 'active' | 'disabled';

/**
 * The identity attached to a request after a Google ID token is verified and the
 * user is resolved (see AuthService). This is what `@CurrentUser()` returns, what
 * the guard populates on `req.user`, and what `GET /auth/me` echoes back.
 *
 * Declared as a class (not an interface) so `@nestjs/swagger` can reflect it into
 * an OpenAPI schema; plain object literals remain structurally assignable.
 */
export class AuthenticatedPrincipal {
  @ApiProperty({
    description:
      'Google account subject (`sub`) — the stable primary key for the user.',
    example: '110169484474386276334',
  })
  uid!: string;

  @ApiProperty({
    required: false,
    format: 'email',
    description: 'Email from the verified token.',
    example: 'ada@example.com',
  })
  email?: string;

  @ApiProperty({
    required: false,
    description: 'Whether Google has verified ownership of the email.',
    example: true,
  })
  emailVerified?: boolean;

  @ApiProperty({
    required: false,
    description: 'Display name from the Google profile.',
    example: 'Ada Lovelace',
  })
  name?: string;

  @ApiProperty({
    required: false,
    format: 'uri',
    description: 'Avatar URL from the Google profile.',
  })
  picture?: string;

  @ApiProperty({
    enum: ['active', 'disabled'],
    description: 'Account status. A disabled account is rejected at the guard.',
    example: 'active',
  })
  status!: AccountStatus;
}
