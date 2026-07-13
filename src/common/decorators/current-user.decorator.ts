import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Extracts the authenticated user placed on the request by FirebaseAuthGuard.
 * Throws if used on a route that is not behind the guard — a programming error
 * we want to surface loudly rather than silently returning undefined.
 *
 * Usage: `@CurrentUser() user: AuthenticatedUser` or `@CurrentUser('uid') uid: string`.
 */
export const CurrentUser = createParamDecorator(
  (
    data: keyof AuthenticatedUser | undefined,
    ctx: ExecutionContext,
  ): AuthenticatedUser | AuthenticatedUser[keyof AuthenticatedUser] => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (!user) {
      throw new InternalServerErrorException(
        'CurrentUser used on a route without an authentication guard',
      );
    }

    return data ? user[data] : user;
  },
);
