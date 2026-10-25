/**
 * Typed application configuration, loaded once at bootstrap and exposed through
 * `ConfigService`. Keep this the single source of truth for env-derived values so
 * services never read `process.env` directly (see devops-use-config-module).
 */
export interface AppConfig {
  env: string;
  port: number;
  corsOrigins: string[];
  /**
   * Reverse proxies in front of the app (Cloud Run's front end = 1). Express then
   * takes the client IP from X-Forwarded-For, so per-client rate limiting sees
   * real clients instead of one shared proxy address. Keep 0 when nothing proxies:
   * a trusted header that no proxy rewrites lets callers pick their own identity.
   */
  trustProxyHops: number;
  gcp: {
    projectId: string;
    credentialsPath?: string;
    firestoreEmulatorHost?: string;
    /** Firestore database to use: "(default)", or a named one (HML: "partytalk"). */
    firestoreDatabaseId: string;
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
     * Optional allow-list of exact emails (e.g. the testers of a staging
     * environment). Combined with `allowedAuthDomains`: when either list is
     * non-empty, an email must match one of them.
     */
    allowedAuthEmails: string[];
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
  /** ICE servers handed to browsers for the P2P voice mesh. */
  webrtc: {
    /** Free STUN servers — enough for most home networks. */
    stunUrls: string[];
    /**
     * TURN relay URLs (e.g. `turn:203.0.113.7:3478?transport=udp`) for peers STUN
     * can't connect (mobile carriers, corporate NATs). Empty = no relay.
     */
    turnUrls: string[];
    /** coturn `static-auth-secret`; TURN is offered only when this is set too. */
    turnSecret?: string;
    /** Lifetime of each minted TURN credential, in seconds. */
    turnCredentialTtlSeconds: number;
  };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  gcp: {
    projectId: process.env.GCP_PROJECT_ID ?? '',
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST || undefined,
    firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
  },
  auth: {
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    allowedAuthDomains: (process.env.ALLOWED_AUTH_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
    allowedAuthEmails: (process.env.ALLOWED_AUTH_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
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
  webrtc: {
    stunUrls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    turnUrls: (process.env.TURN_URLS ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    turnSecret: process.env.TURN_SECRET || undefined,
    turnCredentialTtlSeconds: parseInt(
      process.env.TURN_CREDENTIAL_TTL_SECONDS ?? '21600',
      10,
    ),
  },
});
