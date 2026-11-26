import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a controller or handler out of the global JwtAuthGuard. Every route is
 * authenticated by default; only the reviewed public allowlist
 * (src/auth/public-routes.spec.ts) may carry this decorator.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
