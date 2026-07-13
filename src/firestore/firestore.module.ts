import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Firestore } from 'firebase-admin/firestore';
import { AppConfig } from '../config/configuration';
import { getFirebaseApp } from './firebase-app';
import { FIRESTORE } from './firestore.constants';

/**
 * Provides the Firestore instance under the `FIRESTORE` token. Global so any
 * repository can inject it. The firebase-admin app is shared with the auth
 * layer via `getFirebaseApp`, so it is only ever initialized once.
 */
@Global()
@Module({
  providers: [
    {
      provide: FIRESTORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Firestore => {
        const app = getFirebaseApp(config.get('gcp', { infer: true }));
        const firestore = app.firestore();
        firestore.settings({ ignoreUndefinedProperties: true });
        return firestore;
      },
    },
  ],
  exports: [FIRESTORE],
})
export class FirestoreModule {}
