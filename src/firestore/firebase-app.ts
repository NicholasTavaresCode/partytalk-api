import * as admin from 'firebase-admin';
import { AppConfig } from '../config/configuration';

/**
 * Lazily initialize (and memoize) the single firebase-admin app used for both
 * Firestore and Firebase Auth. Initializing more than once throws, so we guard
 * on `admin.apps.length`. Credentials come from Application Default Credentials
 * unless a key path is provided; the Firestore emulator is honored via the
 * standard `FIRESTORE_EMULATOR_HOST` env var read by the SDK.
 */
export function getFirebaseApp(config: AppConfig['gcp']): admin.app.App {
  if (admin.apps.length > 0 && admin.apps[0]) {
    return admin.apps[0];
  }

  // Against the emulator, no real credential is needed — a projectId is enough.
  if (config.firestoreEmulatorHost) {
    return admin.initializeApp({ projectId: config.projectId });
  }

  const credential = config.credentialsPath
    ? admin.credential.cert(config.credentialsPath)
    : admin.credential.applicationDefault();

  return admin.initializeApp({
    credential,
    projectId: config.projectId,
  });
}
