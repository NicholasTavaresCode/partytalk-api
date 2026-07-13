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

  VERTEX_LOCATION: Joi.string().default('us-central1'),
  VERTEX_HOST_MODEL: Joi.string().default('gemini-2.0-flash'),
  VERTEX_SCORING_MODEL: Joi.string().default('gemini-2.0-flash'),

  ROOM_SUGGEST_EVERY_SEGMENTS: Joi.number().integer().min(1).default(8),
  ROOM_SILENCE_MS: Joi.number().integer().min(1000).default(25000),
  ROOM_CONTEXT_SEGMENTS: Joi.number().integer().min(1).default(25),
});
