import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { AppConfig } from '../config/configuration';
import { getFirebaseApp } from './firebase-app';
import { FIRESTORE } from './firestore.constants';

/**
 * Provides the Firestore instance under the `FIRESTORE` token. Global so any
 * repository can inject it. The firebase-admin app is memoized by
 * `getFirebaseApp`, so it is only ever initialized once. The database is
 * `FIRESTORE_DATABASE_ID` — "(default)" unless set (HML uses "partytalk").
 */
@Global()
@Module({
  providers: [
    {
      provide: FIRESTORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Firestore => {
        const gcp = config.get('gcp', { infer: true });
        const firestore = getFirestore(
          getFirebaseApp(gcp),
          gcp.firestoreDatabaseId,
        );
        firestore.settings({ ignoreUndefinedProperties: true });
        return firestore;
      },
    },
  ],
  exports: [FIRESTORE],
})
export class FirestoreModule {}
