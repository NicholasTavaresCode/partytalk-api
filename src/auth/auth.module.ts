import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthGuard } from './google-auth.guard';
import { GoogleIdTokenVerifier } from './google-id-token-verifier';
import { IdTokenVerifier } from './id-token-verifier';
import { WsAuthenticator } from './ws-authenticator';

/**
 * Wires Google Identity authentication. The IdTokenVerifier is bound to its
 * Google implementation; AuthService turns a verified token into a principal
 * (provisioning users via the UsersRepository from UsersModule). Global so the
 * guard can be registered app-wide and any module can rely on `req.user`.
 * Swapping identity providers later means only rebinding IdTokenVerifier here.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    { provide: IdTokenVerifier, useClass: GoogleIdTokenVerifier },
    AuthService,
    GoogleAuthGuard,
    WsAuthenticator,
  ],
  exports: [IdTokenVerifier, AuthService, GoogleAuthGuard, WsAuthenticator],
})
export class AuthModule {}
