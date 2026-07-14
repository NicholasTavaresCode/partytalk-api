import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { AuthenticatedPrincipal } from '../interfaces/authenticated-principal.interface';

/**
 * Extracts the authenticated principal placed on the request by GoogleAuthGuard.
 * Throws if used on a route that is not behind the guard — a programming error
 * we want to surface loudly rather than silently returning undefined.
 *
 * Usage: `@CurrentUser() user: AuthenticatedPrincipal` or `@CurrentUser('uid') uid: string`.
 */
export const CurrentUser = createParamDecorator(
  (
    data: keyof AuthenticatedPrincipal | undefined,
    ctx: ExecutionContext,
  ):
    | AuthenticatedPrincipal
    | AuthenticatedPrincipal[keyof AuthenticatedPrincipal] => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthenticatedPrincipal | undefined = request.user;

    if (!user) {
      throw new InternalServerErrorException(
        'CurrentUser used on a route without an authentication guard',
      );
    }

    return data ? user[data] : user;
  },
);
