import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { TokenVerifier } from './token-verifier';

/**
 * Secure-by-default authentication guard. Applied globally, it rejects any
 * request lacking a valid Firebase ID token unless the route is `@Public()`
 * (security-use-guards, security-auth-jwt). On success it populates
 * `req.user` with an AuthenticatedUser for `@CurrentUser()`.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenVerifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractBearerToken(request.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing or malformed bearer token');
    }

    try {
      const decoded = await this.tokenVerifier.verify(token);
      const user: AuthenticatedUser = {
        uid: decoded.uid,
        email: decoded.email,
        emailVerified: decoded.emailVerified,
        name: decoded.name,
        picture: decoded.picture,
      };
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractBearerToken(header?: string): string | null {
    if (!header) {
      return null;
    }
    const [scheme, value] = header.split(' ');
    if (scheme !== 'Bearer' || !value) {
      return null;
    }
    return value.trim();
  }
}
