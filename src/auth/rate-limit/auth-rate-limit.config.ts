import type { ConfigService } from '@nestjs/config';

/**
 * P3-BE03 rate-limit policies for the public authentication endpoints.
 * Fixed windows, counted in PostgreSQL (shared by all instances). Every
 * request counts, whatever its outcome, so failures cannot be used to probe
 * accounts and the counters reveal nothing about account existence.
 *
 * Override a policy with `RATE_LIMIT_<NAME>=<limit>/<windowSeconds>`,
 * e.g. `RATE_LIMIT_LOGIN_IP=20/300`.
 */
export interface RateLimitPolicy {
  name: string;
  key: 'ip' | 'email';
  limit: number;
  windowSeconds: number;
}

export type RateLimitedRoute = 'login' | 'register' | 'forgot-password' | 'reset-password';

export const DEFAULT_RATE_LIMIT_POLICIES: Readonly<Record<RateLimitedRoute, readonly RateLimitPolicy[]>> = {
  login: [
    { name: 'login_ip', key: 'ip', limit: 20, windowSeconds: 300 },
    { name: 'login_email', key: 'email', limit: 10, windowSeconds: 900 },
  ],
  register: [{ name: 'register_ip', key: 'ip', limit: 10, windowSeconds: 3600 }],
  'forgot-password': [
    { name: 'forgot_ip', key: 'ip', limit: 10, windowSeconds: 900 },
    { name: 'forgot_email', key: 'email', limit: 5, windowSeconds: 3600 },
  ],
  'reset-password': [{ name: 'reset_ip', key: 'ip', limit: 10, windowSeconds: 900 }],
};

export type AuthRateLimitConfig =
  | { mode: 'disabled' }
  | { mode: 'enabled'; policies: Record<RateLimitedRoute, RateLimitPolicy[]>; hashSecret: string };

export function loadAuthRateLimitConfig(config: ConfigService): AuthRateLimitConfig {
  const production = config.get<string>('NODE_ENV') === 'production';
  const mode = (config.get<string>('AUTH_RATE_LIMIT') ?? 'enabled').trim().toLowerCase();

  if (mode === 'disabled') {
    if (production) {
      throw new Error('AUTH_RATE_LIMIT=disabled is not allowed when NODE_ENV=production');
    }
    return { mode: 'disabled' };
  }
  if (mode !== 'enabled' && mode !== '') {
    throw new Error('AUTH_RATE_LIMIT must be "enabled" or "disabled"');
  }

  const policies = {} as Record<RateLimitedRoute, RateLimitPolicy[]>;
  for (const [route, list] of Object.entries(DEFAULT_RATE_LIMIT_POLICIES) as [RateLimitedRoute, readonly RateLimitPolicy[]][]) {
    policies[route] = list.map((policy) => {
      const envName = `RATE_LIMIT_${policy.name.toUpperCase()}`;
      const raw = config.get<string>(envName)?.trim();
      if (!raw) return { ...policy };
      const match = /^(\d+)\/(\d+)$/.exec(raw);
      const limit = Number(match?.[1]);
      const windowSeconds = Number(match?.[2]);
      if (!match || limit < 1 || limit > 100_000 || windowSeconds < 1 || windowSeconds > 86_400) {
        throw new Error(`${envName} must be "<limit>/<windowSeconds>" (limit 1-100000, window 1-86400 s)`);
      }
      return { ...policy, limit, windowSeconds };
    });
  }

  // Buckets are HMACs so the table never holds raw IPs or e-mail addresses.
  const hashSecret = config.get<string>('RATE_LIMIT_HASH_SECRET')?.trim() || config.get<string>('JWT_SECRET')?.trim();
  if (!hashSecret) {
    throw new Error('RATE_LIMIT_HASH_SECRET or JWT_SECRET is required for auth rate limiting');
  }

  return { mode: 'enabled', policies, hashSecret };
}
