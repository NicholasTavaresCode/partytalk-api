import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { AuthService } from './auth.service';
import { GoogleAuthGuard } from './google-auth.guard';

describe('GoogleAuthGuard', () => {
  let guard: GoogleAuthGuard;
  let reflector: Reflector;
  let authService: { authenticate: jest.Mock };

  const buildContext = (
    headers: Record<string, string>,
  ): { ctx: ExecutionContext; request: Record<string, unknown> } => {
    const req: Record<string, unknown> = { headers };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { ctx, request: req };
  };

  const makeGuard = (disabled = false): GoogleAuthGuard => {
    const config = {
      get: () => ({ disabled }),
    } as unknown as ConfigService;
    return new GoogleAuthGuard(
      reflector,
      authService as unknown as AuthService,
      config,
    );
  };

  beforeEach(() => {
    reflector = new Reflector();
    authService = { authenticate: jest.fn() };
    guard = makeGuard();
  });

  it('bypasses verification and injects a dev user when AUTH_DISABLED is set', async () => {
    const disabledGuard = makeGuard(true);
    const { ctx, request } = buildContext({}); // no token at all

    await expect(disabledGuard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.authenticate).not.toHaveBeenCalled();
    expect((request.user as AuthenticatedPrincipal).uid).toBe('dev-user');
  });

  it('allows public routes without a token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const { ctx } = buildContext({});

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.authenticate).not.toHaveBeenCalled();
  });

  it('rejects a request with no Authorization header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { ctx } = buildContext({});

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(authService.authenticate).not.toHaveBeenCalled();
  });

  it('rejects a malformed Authorization header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { ctx } = buildContext({ authorization: 'Basic abc' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(authService.authenticate).not.toHaveBeenCalled();
  });

  it('attaches the principal to the request on success', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const principal: AuthenticatedPrincipal = {
      uid: 'sub-1',
      email: 'a@b.com',
      emailVerified: true,
      status: 'active',
    };
    authService.authenticate.mockResolvedValue(principal);
    const { ctx, request } = buildContext({ authorization: 'Bearer good' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.authenticate).toHaveBeenCalledWith('good');
    expect(request.user).toBe(principal);
  });

  it('preserves an intentional 403 from AuthService (policy)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    authService.authenticate.mockRejectedValue(
      new ForbiddenException('Account is disabled'),
    );
    const { ctx } = buildContext({ authorization: 'Bearer good' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('collapses an unexpected failure to 401', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    authService.authenticate.mockRejectedValue(new Error('network down'));
    const { ctx } = buildContext({ authorization: 'Bearer good' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
