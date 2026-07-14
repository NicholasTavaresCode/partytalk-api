import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { AuthService } from './auth.service';
import { WsAuthenticator, WsHandshakeSocket } from './ws-authenticator';

describe('WsAuthenticator', () => {
  let authService: { authenticate: jest.Mock };
  let auth: WsAuthenticator;

  const principal: AuthenticatedPrincipal = {
    uid: 'u1',
    email: 'a@b.com',
    emailVerified: true,
    status: 'active',
  };

  const socketWith = (
    handshake: WsHandshakeSocket['handshake'],
  ): WsHandshakeSocket => ({ handshake });

  beforeEach(() => {
    authService = { authenticate: jest.fn() };
    auth = new WsAuthenticator(authService as unknown as AuthService);
  });

  it('authenticates from handshake.auth.token', async () => {
    authService.authenticate.mockResolvedValue(principal);

    const user = await auth.authenticate(
      socketWith({ auth: { token: 'good' }, headers: {} }),
    );

    expect(authService.authenticate).toHaveBeenCalledWith('good');
    expect(user).toBe(principal);
  });

  it('falls back to the Authorization bearer header', async () => {
    authService.authenticate.mockResolvedValue(principal);

    await auth.authenticate(
      socketWith({ auth: {}, headers: { authorization: 'Bearer hdr' } }),
    );

    expect(authService.authenticate).toHaveBeenCalledWith('hdr');
  });

  it('throws when no token is present', async () => {
    await expect(
      auth.authenticate(socketWith({ auth: {}, headers: {} })),
    ).rejects.toThrow();
    expect(authService.authenticate).not.toHaveBeenCalled();
  });

  it('throws when AuthService rejects the token', async () => {
    authService.authenticate.mockRejectedValue(new Error('expired'));
    await expect(
      auth.authenticate(socketWith({ auth: { token: 'bad' }, headers: {} })),
    ).rejects.toThrow();
  });
});
