import type { ConfigService } from '@nestjs/config';

import { isDeployedEnvironment } from '../../config/deployment-environment';

/**
 * Rate-limit policies (P3-BE03, extended by P3-BE11). Fixed windows,
 * counted in PostgreSQL (`auth_rate_limits`, shared by all instances): every
 * request counts, whatever its outcome, so failures cannot be used to probe
 * accounts and the counters reveal nothing about account existence.
 *
 * Keys: `ip` = request.ip (honours TRUST_PROXY; IPv6 grouped per /64),
 * `email` = normalized e-mail of the request body (account-targeted abuse),
 * `user` = the authenticated user id set by JwtAuthGuard (never a claim or
 * a client header). Buckets are HMACs: no raw IP, e-mail or id is stored.
 *
 * Override a policy with `RATE_LIMIT_<NAME>=<limit>/<windowSeconds>`,
 * e.g. `RATE_LIMIT_LOGIN_IP=20/300` or `RATE_LIMIT_API_IP=1200/60`.
 */
export interface RateLimitPolicy {
  name: string;
  key: 'ip' | 'email' | 'user';
  limit: number;
  windowSeconds: number;
}

export type RateLimitedRoute =
  | 'login'
  | 'register'
  | 'forgot-password'
  | 'reset-password'
  | 'refresh'
  | 'verify-email'
  | 'verify-email-resend'
  | 'change-password';

/** Endpoint-specific policies (AUTH_RATE_LIMIT). */
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
  // P3-BE11
  refresh: [{ name: 'refresh_ip', key: 'ip', limit: 60, windowSeconds: 300 }],
  'verify-email': [{ name: 'verify_ip', key: 'ip', limit: 20, windowSeconds: 900 }],
  'verify-email-resend': [{ name: 'verify_resend_user', key: 'user', limit: 5, windowSeconds: 3600 }],
  'change-password': [{ name: 'change_password_user', key: 'user', limit: 5, windowSeconds: 900 }],
};

/**
 * P3-BE11 API-wide policies (API_RATE_LIMIT):
 *   api         every request except health checks, per client IP (also
 *               bounds 401 floods, since it runs before authentication);
 *   public      unauthenticated catalogue/search routes, per client IP;
 *   user-read   GET/HEAD/OPTIONS of an authenticated user, per user;
 *   user-write  other methods of an authenticated user, per user.
 * The per-IP ceilings leave room for users behind one shared NAT.
 */
export type ApiRateLimitScope = 'api' | 'public' | 'user-read' | 'user-write';

export const DEFAULT_API_RATE_LIMIT_POLICIES: Readonly<Record<ApiRateLimitScope, RateLimitPolicy>> = {
  api: { name: 'api_ip', key: 'ip', limit: 600, windowSeconds: 60 },
  public: { name: 'public_ip', key: 'ip', limit: 120, windowSeconds: 60 },
  'user-read': { name: 'user_read', key: 'user', limit: 300, windowSeconds: 60 },
  'user-write': { name: 'user_write', key: 'user', limit: 60, windowSeconds: 60 },
};

export type AuthRateLimitConfig =
  | { mode: 'disabled' }
  | { mode: 'enabled'; policies: Record<RateLimitedRoute, RateLimitPolicy[]>; hashSecret: string };

export type ApiRateLimitConfig =
  | { mode: 'disabled' }
  | { mode: 'enabled'; policies: Record<ApiRateLimitScope, RateLimitPolicy>; hashSecret: string };

type Config = Pick<ConfigService, 'get'>;

function withOverride(config: Config, policy: RateLimitPolicy): RateLimitPolicy {
  const envName = `RATE_LIMIT_${policy.name.toUpperCase()}`;
  const raw = config.get<string>(envName)?.trim();
  if (!raw) return { ...policy };
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  const limit = Number(match?.[1]);
  const windowSeconds = Number(match?.[2]);
  if (!match || limit < 1 || limit > 100_000_000 || windowSeconds < 1 || windowSeconds > 86_400) {
    throw new Error(`${envName} must be "<limit>/<windowSeconds>" (limit 1-100000000, window 1-86400 s)`);
  }
  return { ...policy, limit, windowSeconds };
}

function modeOf(config: Config, variable: string): 'enabled' | 'disabled' {
  const nodeEnvName = config.get<string>('NODE_ENV')?.trim().toLowerCase() ?? '';
  const mode = (config.get<string>(variable) ?? 'enabled').trim().toLowerCase();
  if (mode === 'disabled') {
    // P3-BE11: staging is a deployed environment too.
    if (isDeployedEnvironment(nodeEnvName)) {
      throw new Error(`${variable}=disabled is not allowed when NODE_ENV=${nodeEnvName}`);
    }
    return 'disabled';
  }
  if (mode !== 'enabled' && mode !== '') {
    throw new Error(`${variable} must be "enabled" or "disabled"`);
  }
  return 'enabled';
}

function hashSecretOf(config: Config, purpose: string): string {
  // Buckets are HMACs so the table never holds raw IPs, e-mail addresses or user ids.
  const hashSecret = config.get<string>('RATE_LIMIT_HASH_SECRET')?.trim() || config.get<string>('JWT_SECRET')?.trim();
  if (!hashSecret) {
    throw new Error(`RATE_LIMIT_HASH_SECRET or JWT_SECRET is required for ${purpose}`);
  }
  return hashSecret;
}

export function loadAuthRateLimitConfig(config: Config): AuthRateLimitConfig {
  if (modeOf(config, 'AUTH_RATE_LIMIT') === 'disabled') return { mode: 'disabled' };
  const policies = {} as Record<RateLimitedRoute, RateLimitPolicy[]>;
  for (const [route, list] of Object.entries(DEFAULT_RATE_LIMIT_POLICIES) as [RateLimitedRoute, readonly RateLimitPolicy[]][]) {
    policies[route] = list.map((policy) => withOverride(config, policy));
  }
  return { mode: 'enabled', policies, hashSecret: hashSecretOf(config, 'auth rate limiting') };
}

export function loadApiRateLimitConfig(config: Config): ApiRateLimitConfig {
  if (modeOf(config, 'API_RATE_LIMIT') === 'disabled') return { mode: 'disabled' };
  const policies = {} as Record<ApiRateLimitScope, RateLimitPolicy>;
  for (const [scope, policy] of Object.entries(DEFAULT_API_RATE_LIMIT_POLICIES) as [ApiRateLimitScope, RateLimitPolicy][]) {
    policies[scope] = withOverride(config, policy);
  }
  return { mode: 'enabled', policies, hashSecret: hashSecretOf(config, 'API rate limiting') };
}
