import { TokenVerifier, VerifiedToken } from './token-verifier';
import { WsAuthenticator, WsHandshakeSocket } from './ws-authenticator';

describe('WsAuthenticator', () => {
  let verifier: jest.Mocked<TokenVerifier>;
  let auth: WsAuthenticator;

  const socketWith = (
    handshake: WsHandshakeSocket['handshake'],
  ): WsHandshakeSocket => ({ handshake });

  beforeEach(() => {
    verifier = { verify: jest.fn() };
    auth = new WsAuthenticator(verifier);
  });

  it('authenticates from handshake.auth.token', async () => {
    const decoded: VerifiedToken = { uid: 'u1', email: 'a@b.com' };
    verifier.verify.mockResolvedValue(decoded);

    const user = await auth.authenticate(
      socketWith({ auth: { token: 'good' }, headers: {} }),
    );

    expect(verifier.verify).toHaveBeenCalledWith('good');
    expect(user).toEqual({
      uid: 'u1',
      email: 'a@b.com',
      emailVerified: undefined,
      name: undefined,
      picture: undefined,
    });
  });

  it('falls back to the Authorization bearer header', async () => {
    verifier.verify.mockResolvedValue({ uid: 'u2' });

    const user = await auth.authenticate(
      socketWith({ auth: {}, headers: { authorization: 'Bearer hdr' } }),
    );

    expect(verifier.verify).toHaveBeenCalledWith('hdr');
    expect(user.uid).toBe('u2');
  });

  it('throws when no token is present', async () => {
    await expect(
      auth.authenticate(socketWith({ auth: {}, headers: {} })),
    ).rejects.toThrow();
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('throws when the verifier rejects the token', async () => {
    verifier.verify.mockRejectedValue(new Error('expired'));
    await expect(
      auth.authenticate(socketWith({ auth: { token: 'bad' }, headers: {} })),
    ).rejects.toThrow();
  });
});
