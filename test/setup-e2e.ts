/**
 * Runs before any e2e test module is imported (jest `setupFiles`). Provides the
 * minimum env the config schema requires so AppModule can boot without real
 * cloud credentials — all external services are overridden with fakes in the
 * individual specs.
 */
process.env.NODE_ENV = 'test';
process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'test-project';
process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
