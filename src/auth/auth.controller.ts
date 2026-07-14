import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { ApiEnvelopeResponse } from '../common/swagger/api-envelope';
import { ErrorResponseDto } from '../common/swagger/error-response.dto';

/**
 * Identity endpoint. Returns the resolved principal straight from `req.user`,
 * so the frontend can drive identity-aware UI without a second round-trip. No
 * work happens here beyond echoing what the guard already established.
 */
@ApiTags('Auth')
@ApiBearerAuth('google')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or invalid Google ID token.',
  type: ErrorResponseDto,
})
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  @Get('me')
  @ApiOperation({
    summary: 'Get my identity',
    description:
      'Returns the authenticated principal derived from the Google ID token: uid (Google `sub`), email, profile fields and account status. A user is auto-provisioned on first call.',
  })
  @ApiEnvelopeResponse(AuthenticatedPrincipal, {
    description: 'The caller’s resolved principal.',
  })
  me(@CurrentUser() principal: AuthenticatedPrincipal): AuthenticatedPrincipal {
    return principal;
  }
}
