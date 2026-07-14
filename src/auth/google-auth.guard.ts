import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';

/**
 * Identity used for every request while auth is disabled (AUTH_DISABLED=true).
 * Lets `@CurrentUser()`-based endpoints keep working during local testing.
 */
const DEV_PRINCIPAL: AuthenticatedPrincipal = {
  uid: 'dev-user',
  email: 'dev@example.com',
  emailVerified: true,
  name: 'Dev User',
  status: 'active',
};

/**
 * Secure-by-default authentication guard. Applied globally, it rejects any
 * request lacking a valid Google ID token unless the route is `@Public()`
 * (security-use-guards, security-auth-jwt). It only handles transport concerns —
 * extracting `Authorization: Bearer <token>` and attaching the resolved
 * principal to `req.user`; AuthService owns verification and account policy.
 *
 * Intentional 401/403 from AuthService are preserved; any unexpected failure is
 * collapsed to a generic 401 so we never leak internals through the auth path.
 */
@Injectable()
export class GoogleAuthGuard implements CanActivate {
  private readonly logger = new Logger(GoogleAuthGuard.name);
  private readonly disabled: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.disabled = config.get('auth', { infer: true }).disabled;
    if (this.disabled) {
      this.logger.warn(
        'Google auth is DISABLED (AUTH_DISABLED=true): every request is treated ' +
          `as "${DEV_PRINCIPAL.uid}". Never enable this in a shared/deployed environment.`,
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // TEMPORARY: skip all token verification while testing resources locally.
    if (this.disabled) {
      request.user = DEV_PRINCIPAL;
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const token = this.extractBearerToken(request.headers?.authorization);
    if (!token) {
      this.logger.debug(
        `Rejected ${request.method} ${request.url}: no/malformed Authorization header`,
      );
      throw new UnauthorizedException('Missing or malformed bearer token');
    }

    try {
      request.user = await this.authService.authenticate(token);
      return true;
    } catch (error) {
      // Preserve deliberate auth decisions (401 identity, 403 policy); their
      // message is already meaningful, so log at debug and re-throw as-is.
      if (error instanceof HttpException) {
        this.logger.debug(
          `Rejected ${request.method} ${request.url} (${error.getStatus()}): ${error.message}`,
        );
        throw error;
      }
      // An unexpected failure — almost always the token itself failing
      // verification (wrong audience/client id, expired, malformed) or a
      // verifier network fault. Log the real reason + a likely-cause hint
      // server-side (never leaked to the client) so 401s are diagnosable.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Token verification failed for ${request.method} ${request.url}: ${reason}${this.hintFor(reason)}`,
      );
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Map common google-auth-library failures to an actionable next step. */
  private hintFor(reason: string): string {
    const r = reason.toLowerCase();
    if (r.includes('audience') || r.includes('recipient')) {
      return " — HINT: the frontend's Google client_id does not match GOOGLE_OAUTH_CLIENT_ID (check the aud claim).";
    }
    if (r.includes('expired') || r.includes('too late')) {
      return ' — HINT: the ID token has expired (they last ~1h); the frontend must fetch a fresh credential.';
    }
    if (
      r.includes('segment') ||
      r.includes('pem') ||
      r.includes('jwt') ||
      r.includes('malformed')
    ) {
      return " — HINT: this isn't a valid Google ID token. Send the sign-in `credential` JWT, not an OAuth access token.";
    }
    return '';
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
