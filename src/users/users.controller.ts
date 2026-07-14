import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { ApiEnvelopeResponse } from '../common/swagger/api-envelope';
import { ErrorResponseDto } from '../common/swagger/error-response.dto';
import { UpsertProfileDto } from './dto/upsert-profile.dto';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

/**
 * Endpoints operate on the *caller's own* profile only — the id always comes
 * from the verified token, never from the URL, so a user cannot read or mutate
 * another user's record (no IDOR surface).
 */
@ApiTags('Users')
@ApiBearerAuth('google')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or invalid Google ID token.',
  type: ErrorResponseDto,
})
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Get my profile',
    description:
      'Returns the authenticated user’s profile. The record is auto-provisioned on first sign-in, so this succeeds immediately; the learner fields (`displayName`, `englishLevel`, `targetIeltsBand`) stay empty until set via `PUT /users/me`.',
  })
  @ApiEnvelopeResponse(User, { description: 'The caller’s profile.' })
  getMe(@CurrentUser() user: AuthenticatedPrincipal): Promise<User> {
    return this.usersService.getProfile(user.uid);
  }

  @Put('me')
  @ApiOperation({
    summary: 'Create or update my profile',
    description:
      'Idempotent upsert of the caller’s profile keyed by their Google account `sub`. The profile is auto-provisioned on first sign-in; this fills in and updates the learner fields (preserving `createdAt`).',
  })
  @ApiEnvelopeResponse(User, { description: 'The saved profile.' })
  upsertMe(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: UpsertProfileDto,
  ): Promise<User> {
    return this.usersService.upsertProfile(user, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete my profile',
    description:
      'Permanently deletes the caller’s profile. Idempotent — succeeds even if no profile exists.',
  })
  @ApiNoContentResponse({ description: 'Profile deleted (no content).' })
  deleteMe(@CurrentUser('uid') uid: string): Promise<void> {
    return this.usersService.deleteProfile(uid);
  }
}
