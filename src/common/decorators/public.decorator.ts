import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as accessible without authentication. The global
 * GoogleAuthGuard checks for this metadata and skips verification when present.
 * Secure-by-default: routes are protected unless explicitly made `@Public()`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
