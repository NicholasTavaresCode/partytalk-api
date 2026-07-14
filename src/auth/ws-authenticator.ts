import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { AuthService } from './auth.service';

/** Minimal shape of a Socket.IO client handshake we read a token from. */
export interface WsHandshakeSocket {
  handshake: {
    auth?: { token?: string };
    headers?: { authorization?: string };
    query?: Record<string, unknown>;
  };
}

/**
 * Authenticates a WebSocket connection from its handshake, reusing the same
 * AuthService (and therefore the same Google token verification and account
 * policy) as the HTTP guard. Kept separate from the gateway so it can be
 * unit-tested and shared by the signaling and audio gateways
 * (security-use-guards, di-use-interfaces-tokens).
 */
@Injectable()
export class WsAuthenticator {
  constructor(private readonly authService: AuthService) {}

  async authenticate(
    client: WsHandshakeSocket,
  ): Promise<AuthenticatedPrincipal> {
    const token = this.extractToken(client);
    if (!token) {
      throw new UnauthorizedException('Missing socket auth token');
    }
    return this.authService.authenticate(token);
  }

  private extractToken(client: WsHandshakeSocket): string | null {
    const { handshake } = client;
    const fromAuth = handshake.auth?.token;
    if (fromAuth) {
      return fromAuth;
    }
    const header = handshake.headers?.authorization;
    if (header?.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim() || null;
    }
    const fromQuery = handshake.query?.token;
    return typeof fromQuery === 'string' && fromQuery ? fromQuery : null;
  }
}
