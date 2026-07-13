import { Global, Module } from '@nestjs/common';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { FirebaseTokenVerifier } from './firebase-token-verifier';
import { TokenVerifier } from './token-verifier';
import { WsAuthenticator } from './ws-authenticator';

/**
 * Provides the TokenVerifier (bound to the Firebase implementation) and the
 * FirebaseAuthGuard. Global so the guard can be registered app-wide and any
 * module can rely on `req.user` being populated. Swapping identity providers
 * later means only rebinding the TokenVerifier token here.
 */
@Global()
@Module({
  providers: [
    { provide: TokenVerifier, useClass: FirebaseTokenVerifier },
    FirebaseAuthGuard,
    WsAuthenticator,
  ],
  exports: [TokenVerifier, FirebaseAuthGuard, WsAuthenticator],
})
export class AuthModule {}
