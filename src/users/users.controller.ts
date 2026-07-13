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
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
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
@ApiBearerAuth('firebase')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired Firebase token.',
  type: ErrorResponseDto,
})
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Get my profile',
    description:
      'Returns the authenticated user’s profile. Returns 404 until the profile has been created via `PUT /users/me`.',
  })
  @ApiEnvelopeResponse(User, { description: 'The caller’s profile.' })
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<User> {
    return this.usersService.getProfile(user.uid);
  }

  @Put('me')
  @ApiOperation({
    summary: 'Create or update my profile',
    description:
      'Idempotent upsert of the caller’s profile keyed by their Firebase UID. The first call after sign-in materializes the profile; later calls update it (preserving `createdAt`).',
  })
  @ApiEnvelopeResponse(User, { description: 'The saved profile.' })
  upsertMe(
    @CurrentUser() user: AuthenticatedUser,
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
