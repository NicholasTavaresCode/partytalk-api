import * as Joi from 'joi';

/**
 * Fail fast at startup if required configuration is missing or malformed.
 * A misconfigured env is a deploy-time bug, not a runtime one.
 */
export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),

  GCP_PROJECT_ID: Joi.string().required(),
  GOOGLE_APPLICATION_CREDENTIALS: Joi.string().allow('').optional(),
  FIRESTORE_EMULATOR_HOST: Joi.string().allow('').optional(),

  // Google Identity ("Sign in with Google") — the frontend does the sign-in and
  // sends the resulting ID token; the API verifies it against this client id.
  GOOGLE_OAUTH_CLIENT_ID: Joi.string().required(),
  // Optional comma-separated Workspace domain allow-list. Empty = open sign-up.
  ALLOWED_AUTH_DOMAINS: Joi.string().allow('').optional(),
  // TEMP local-testing flag: true bypasses Google token verification entirely.
  AUTH_DISABLED: Joi.boolean().default(false),

  VERTEX_LOCATION: Joi.string().default('us-central1'),
  VERTEX_HOST_MODEL: Joi.string().default('gemini-2.0-flash'),
  VERTEX_SCORING_MODEL: Joi.string().default('gemini-2.0-flash'),

  ROOM_SUGGEST_EVERY_SEGMENTS: Joi.number().integer().min(1).default(8),
  ROOM_SILENCE_MS: Joi.number().integer().min(1000).default(25000),
  ROOM_CONTEXT_SEGMENTS: Joi.number().integer().min(1).default(25),
});
