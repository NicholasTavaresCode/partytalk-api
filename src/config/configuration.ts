/**
 * Typed application configuration, loaded once at bootstrap and exposed through
 * `ConfigService`. Keep this the single source of truth for env-derived values so
 * services never read `process.env` directly (see devops-use-config-module).
 */
export interface AppConfig {
  env: string;
  port: number;
  corsOrigins: string[];
  gcp: {
    projectId: string;
    credentialsPath?: string;
    firestoreEmulatorHost?: string;
  };
  auth: {
    /** OAuth 2.0 client id the frontend signs in with; the expected `aud` of every ID token. */
    googleOAuthClientId: string;
    /**
     * Optional Google Workspace domain allow-list. Empty = any verified Google
     * account may sign in. When set, an email outside these domains is rejected.
     */
    allowedAuthDomains: string[];
    /**
     * TEMPORARY local-testing escape hatch. When true, the guard skips Google
     * token verification entirely and treats every request as a fixed dev user.
     * Must be false anywhere shared or deployed.
     */
    disabled: boolean;
  };
  vertex: {
    location: string;
    hostModel: string;
    scoringModel: string;
  };
  facilitator: {
    /** Suggest a new topic after this many transcript segments since the last one. */
    suggestEverySegments: number;
    /** Suggest a new topic after this many milliseconds of silence in a live room. */
    silenceMs: number;
    /** How many recent transcript segments to feed the model as context. */
    contextSegments: number;
  };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  gcp: {
    projectId: process.env.GCP_PROJECT_ID ?? '',
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST || undefined,
  },
  auth: {
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    allowedAuthDomains: (process.env.ALLOWED_AUTH_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
    disabled: process.env.AUTH_DISABLED === 'true',
  },
  vertex: {
    location: process.env.VERTEX_LOCATION ?? 'us-central1',
    hostModel: process.env.VERTEX_HOST_MODEL ?? 'gemini-2.0-flash',
    scoringModel: process.env.VERTEX_SCORING_MODEL ?? 'gemini-2.0-flash',
  },
  facilitator: {
    suggestEverySegments: parseInt(
      process.env.ROOM_SUGGEST_EVERY_SEGMENTS ?? '8',
      10,
    ),
    silenceMs: parseInt(process.env.ROOM_SILENCE_MS ?? '25000', 10),
    contextSegments: parseInt(process.env.ROOM_CONTEXT_SEGMENTS ?? '25', 10),
  },
});
