import { isIP } from 'node:net';

import { parseTrustProxy } from '../common/utils/trust-proxy';

/**
 * P3-BE11 deployment environment and release-safety configuration.
 *
 * NODE_ENV selects the environment (the repository convention since
 * P3-BE06): unset/development, test, staging, production. "staging" and
 * "production" are DEPLOYED environments: every fail-closed rule applies
 * to both, so staging can never start with development shortcuts. Any
 * other value (e.g. a typo such as "prod") stops the startup instead of
 * silently running with development defaults.
 *
 * Errors name the variable and the rule, never a configured value.
 */
export const NODE_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

type Env = Readonly<Record<string, string | undefined>>;

export function nodeEnvironment(env: Env): NodeEnvironment {
  const raw = env.NODE_ENV?.trim().toLowerCase() || 'development';
  if (!(NODE_ENVIRONMENTS as readonly string[]).includes(raw)) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENVIRONMENTS.join(', ')} (or unset for development)`);
  }
  return raw as NodeEnvironment;
}

/** Staging and production serve real clients: development shortcuts are refused in both. */
export function isDeployedEnvironment(nodeEnv: string | undefined): boolean {
  const value = nodeEnv?.trim().toLowerCase();
  return value === 'staging' || value === 'production';
}

/** Local development origins used when nothing is configured outside a deployed environment. */
export const DEFAULT_DEVELOPMENT_ORIGINS = ['http://localhost:3000', 'http://localhost:3001'] as const;

export type DbSslMode = 'disable' | 'require' | 'no-verify';

export interface ReleaseConfig {
  nodeEnv: NodeEnvironment;
  deployed: boolean;
  /** Exact browser origins allowed by CORS (scheme://host[:port]). */
  corsOrigins: string[];
  swaggerEnabled: boolean;
  /** Strict-Transport-Security max-age in seconds; 0 = header disabled. Sent only on HTTPS requests. */
  hstsMaxAgeSeconds: number;
  dbSsl: DbSslMode;
  /** Refuse to start when the database is not at the code's migration level. */
  migrationsCheck: 'enforce' | 'off';
  /** Upper bound of the readiness database probe. */
  healthDbTimeoutMs: number;
}

const DEV_DATABASE_NAMES = new Set(['pet_care_db']);
const PLACEHOLDER_SECRET = /^(your[_-]|change[_-]?me|secret$|password$|test$|example)/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Parses an origin list; returns normalized origins or throws naming the variable. */
export function parseOrigins(raw: string, variable: string, deployed: boolean): string[] {
  const out: string[] = [];
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${variable} must contain absolute origins such as https://app.example.com`);
    }
    if (entry.includes('*')) throw new Error(`${variable} must not contain wildcards`);
    if (url.origin === 'null' || !['http:', 'https:'].includes(url.protocol)) throw new Error(`${variable} entries must use http or https`);
    // Hostnames are case-insensitive; anything else that differs from the origin (path, query, credentials) is refused.
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || entry.replace(/\/$/, '').toLowerCase() !== url.origin) {
      throw new Error(`${variable} entries must be bare origins (scheme://host[:port], no path, query or credentials)`);
    }
    if (deployed && url.protocol !== 'https:') throw new Error(`${variable} must use https origins in a deployed environment`);
    if (deployed && (LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname === '[::1]')) {
      throw new Error(`${variable} must not contain localhost origins in a deployed environment`);
    }
    out.push(url.origin);
  }
  return [...new Set(out)];
}

function intInRange(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function flag(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key} must be "true" or "false"`);
}

/**
 * Loads and validates the release configuration. In a deployed environment
 * every violation is collected and reported together (names only), so an
 * operator fixes the whole configuration in one pass.
 */
export function loadReleaseConfig(env: Env): ReleaseConfig {
  const nodeEnv = nodeEnvironment(env);
  const deployed = isDeployedEnvironment(nodeEnv);
  const problems: string[] = [];
  const attempt = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return fallback;
    }
  };

  // CORS: CORS_ORIGINS (explicit list). FRONTEND_URL is accepted outside deployed environments
  // for backward compatibility; deployed environments must list their origins explicitly.
  const corsRaw = env.CORS_ORIGINS?.trim();
  let corsOrigins: string[] = [];
  if (corsRaw) {
    corsOrigins = attempt(() => parseOrigins(corsRaw, 'CORS_ORIGINS', deployed), []);
  } else if (deployed) {
    problems.push('CORS_ORIGINS is required in a deployed environment (comma-separated https origins)');
  } else {
    const legacy = env.FRONTEND_URL?.trim();
    corsOrigins = legacy ? attempt(() => parseOrigins(legacy, 'FRONTEND_URL', false), []) : [...DEFAULT_DEVELOPMENT_ORIGINS];
  }
  if (deployed && corsRaw && corsOrigins.length === 0 && problems.length === 0) problems.push('CORS_ORIGINS must list at least one origin');

  const swaggerEnabled = attempt(() => flag(env, 'SWAGGER_ENABLED', !deployed), false);
  const hstsMaxAgeSeconds = attempt(() => intInRange(env, 'HSTS_MAX_AGE_SECONDS', deployed ? 15_552_000 : 0, 0, 63_072_000), 0);
  const healthDbTimeoutMs = attempt(() => intInRange(env, 'HEALTH_DB_TIMEOUT_MS', 2_000, 100, 10_000), 2_000);

  const sslRaw = env.DB_SSL?.trim().toLowerCase() || (deployed ? '' : 'disable');
  let dbSsl: DbSslMode = 'disable';
  if (!['disable', 'require', 'no-verify'].includes(sslRaw)) {
    problems.push(deployed && !sslRaw ? 'DB_SSL must be set explicitly in a deployed environment ("require", "no-verify" or "disable")' : 'DB_SSL must be "disable", "require" or "no-verify"');
  } else {
    dbSsl = sslRaw as DbSslMode;
  }

  const checkRaw = env.MIGRATIONS_CHECK?.trim().toLowerCase() || (deployed ? 'enforce' : 'off');
  let migrationsCheck: 'enforce' | 'off' = 'off';
  if (checkRaw !== 'enforce' && checkRaw !== 'off') problems.push('MIGRATIONS_CHECK must be "enforce" or "off"');
  else migrationsCheck = checkRaw;

  if (deployed) {
    const jwt = env.JWT_SECRET?.trim() ?? '';
    if (jwt.length < 32 || PLACEHOLDER_SECRET.test(jwt)) problems.push('JWT_SECRET must be a random value of at least 32 characters in a deployed environment');
    const hash = env.RATE_LIMIT_HASH_SECRET?.trim();
    if (hash !== undefined && hash !== '' && (hash.length < 32 || hash === jwt)) problems.push('RATE_LIMIT_HASH_SECRET must be at least 32 characters and differ from JWT_SECRET');

    for (const key of ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE']) {
      if (!env[key]?.trim()) problems.push(`${key} is required`);
    }
    const db = env.DB_DATABASE?.trim() ?? '';
    // Disposable pawflow_qa_* databases stay allowed: the staging rehearsal (qa:release-security) runs on one.
    if (DEV_DATABASE_NAMES.has(db)) problems.push('DB_DATABASE must be a dedicated staging/production database, not the development database');
    if (PLACEHOLDER_SECRET.test(env.DB_PASSWORD?.trim() ?? '') || (env.DB_PASSWORD?.trim().length ?? 0) < 12) problems.push('DB_PASSWORD must be a real credential of at least 12 characters');
    if (['postgres', 'root', 'admin'].includes(env.DB_USERNAME?.trim().toLowerCase() ?? '')) problems.push('DB_USERNAME must be a dedicated least-privilege role, not a superuser account');
    const host = env.DB_HOST?.trim().toLowerCase() ?? '';
    if (dbSsl === 'disable' && host && !LOOPBACK_HOSTS.has(host) && !(isIP(host) === 4 && host.startsWith('127.'))) {
      problems.push('DB_SSL=disable is allowed in a deployed environment only for a database on the same host (loopback)');
    }

    if (env.TRUST_PROXY === undefined || env.TRUST_PROXY.trim() === '') {
      problems.push('TRUST_PROXY must be set explicitly in a deployed environment (proxy CIDRs/addresses, a hop count, or "false" for direct exposure)');
    } else {
      attempt(() => parseTrustProxy(env.TRUST_PROXY), false);
    }
    if (env.API_RATE_LIMIT?.trim().toLowerCase() === 'disabled') problems.push('API_RATE_LIMIT=disabled is not allowed in a deployed environment');
    if (nodeEnv === 'staging' && env.PUSH_DELIVERY_MODE?.trim().toLowerCase() === 'firebase' && env.STAGING_ALLOW_REAL_PUSH?.trim().toLowerCase() !== 'true') {
      problems.push('PUSH_DELIVERY_MODE=firebase in staging sends real notifications; set STAGING_ALLOW_REAL_PUSH=true to confirm');
    }
    if (env.PORT?.trim() && !/^\d+$/.test(env.PORT.trim())) problems.push('PORT must be a number');
  }

  if (problems.length > 0) {
    throw new Error(`Unsafe or invalid configuration for NODE_ENV=${nodeEnv}:\n- ${[...new Set(problems)].join('\n- ')}`);
  }
  return { nodeEnv, deployed, corsOrigins, swaggerEnabled, hstsMaxAgeSeconds, dbSsl, migrationsCheck, healthDbTimeoutMs };
}

/** TypeORM/pg `ssl` option for DB_SSL. */
export function postgresSslOption(mode: DbSslMode): false | { rejectUnauthorized: boolean } {
  if (mode === 'require') return { rejectUnauthorized: true };
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return false;
}
