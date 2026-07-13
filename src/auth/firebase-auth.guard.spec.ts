import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { TokenVerifier, VerifiedToken } from './token-verifier';

describe('FirebaseAuthGuard', () => {
  let guard: FirebaseAuthGuard;
  let reflector: Reflector;
  let verifier: jest.Mocked<TokenVerifier>;

  const buildContext = (
    headers: Record<string, string>,
    request: Record<string, unknown> = {},
  ): { ctx: ExecutionContext; request: Record<string, unknown> } => {
    const req = { headers, ...request };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { ctx, request: req };
  };

  beforeEach(() => {
    reflector = new Reflector();
    verifier = { verify: jest.fn() };
    guard = new FirebaseAuthGuard(reflector, verifier);
  });

  it('allows public routes without a token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const { ctx } = buildContext({});

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects a request with no Authorization header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { ctx } = buildContext({});

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed Authorization header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { ctx } = buildContext({ authorization: 'Basic abc' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects when the verifier throws (invalid/expired token)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    verifier.verify.mockRejectedValue(new Error('token expired'));
    const { ctx } = buildContext({ authorization: 'Bearer bad-token' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the verified user to the request on success', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const decoded: VerifiedToken = {
      uid: 'user-123',
      email: 'a@b.com',
      emailVerified: true,
      name: 'Ada',
    };
    verifier.verify.mockResolvedValue(decoded);
    const { ctx, request } = buildContext({ authorization: 'Bearer good-token' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verifier.verify).toHaveBeenCalledWith('good-token');
    expect(request.user).toEqual({
      uid: 'user-123',
      email: 'a@b.com',
      emailVerified: true,
      name: 'Ada',
      picture: undefined,
    });
  });
});
