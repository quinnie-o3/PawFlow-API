import type { ConfigService } from '@nestjs/config';

import { loadApiRateLimitConfig, loadAuthRateLimitConfig } from '../auth/rate-limit/auth-rate-limit.config';
import { loadTurnstileConfig } from '../auth/bot-protection/turnstile.config';
import { loadLoggingConfig } from '../common/observability/structured-logger';
import { createMailTransport } from '../mail/mail-transport';
import { loadPushRegistrationKeys } from '../push-devices/push-registration.crypto';
import {
  isDeployedEnvironment,
  loadReleaseConfig,
  nodeEnvironment,
  parseOrigins,
  postgresSslOption,
} from './deployment-environment';

const SECRET = 'k9Vb2mQx7Lr4Tz8Wn1Hs5Jd3Fg6Pc0Ya';
const DB_PASSWORD = 'Stg-Db-Pass-9f3kq2';

/** A complete, valid staging configuration (placeholder values only). */
const STAGING: Record<string, string> = {
  NODE_ENV: 'staging',
  JWT_SECRET: SECRET,
  DB_HOST: 'staging-db.internal.example',
  DB_PORT: '5432',
  DB_USERNAME: 'pawflow_staging_app',
  DB_PASSWORD,
  DB_DATABASE: 'pawflow_staging',
  DB_SSL: 'require',
  CORS_ORIGINS: 'https://staging.pawflow.example',
  TRUST_PROXY: '10.0.0.0/8',
};

const errorOf = (env: Record<string, string | undefined>): string => {
  try {
    loadReleaseConfig(env);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('NODE_ENV environments (P3-BE11)', () => {
  it.each([
    [undefined, 'development'], ['', 'development'], ['development', 'development'], ['test', 'test'], ['Staging', 'staging'], ['production', 'production'],
  ])('%p -> %s', (value, expected) => {
    expect(nodeEnvironment({ NODE_ENV: value })).toBe(expected);
  });

  it.each(['prod', 'stage', 'live', 'dev'])('refuses the unknown value %s instead of falling back to development', (value) => {
    expect(() => nodeEnvironment({ NODE_ENV: value })).toThrow('NODE_ENV must be one of');
  });

  it('treats staging and production as deployed environments only', () => {
    expect(['staging', 'production', ' PRODUCTION '].map(isDeployedEnvironment)).toEqual([true, true, true]);
    expect([undefined, '', 'development', 'test'].map(isDeployedEnvironment)).toEqual([false, false, false, false]);
  });
});

describe('release configuration: development and test', () => {
  it('local defaults: localhost origins, Swagger on, no HSTS, no DB TLS, no schema enforcement', () => {
    expect(loadReleaseConfig({})).toEqual({
      nodeEnv: 'development', deployed: false, corsOrigins: ['http://localhost:3000', 'http://localhost:3001'],
      swaggerEnabled: true, hstsMaxAgeSeconds: 0, dbSsl: 'disable', migrationsCheck: 'off', healthDbTimeoutMs: 2000,
    });
  });

  it('FRONTEND_URL is still honoured outside deployed environments (backward compatibility)', () => {
    expect(loadReleaseConfig({ NODE_ENV: 'test', FRONTEND_URL: 'http://localhost:3000' }).corsOrigins).toEqual(['http://localhost:3000']);
  });
});

describe('release configuration: staging and production', () => {
  it('a complete staging configuration is accepted with secure defaults', () => {
    expect(loadReleaseConfig(STAGING)).toEqual({
      nodeEnv: 'staging', deployed: true, corsOrigins: ['https://staging.pawflow.example'],
      swaggerEnabled: false, hstsMaxAgeSeconds: 15_552_000, dbSsl: 'require', migrationsCheck: 'enforce', healthDbTimeoutMs: 2000,
    });
  });

  it('the same rules apply to production; production does not inherit development origins', () => {
    const { CORS_ORIGINS: _omit, ...withoutOrigins } = STAGING;
    expect(loadReleaseConfig({ ...STAGING, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.pawflow.example' }).corsOrigins).toEqual(['https://app.pawflow.example']);
    expect(errorOf({ ...withoutOrigins, NODE_ENV: 'production', FRONTEND_URL: 'http://localhost:3000' })).toContain('CORS_ORIGINS is required');
  });

  it.each([
    ['missing JWT secret', { JWT_SECRET: undefined }, 'JWT_SECRET must be a random value'],
    ['short JWT secret', { JWT_SECRET: 'short' }, 'JWT_SECRET must be a random value'],
    ['placeholder JWT secret', { JWT_SECRET: 'your_jwt_secret_your_jwt_secret_xx' }, 'JWT_SECRET must be a random value'],
    ['hash secret equal to JWT secret', { RATE_LIMIT_HASH_SECRET: SECRET }, 'RATE_LIMIT_HASH_SECRET must be at least 32'],
    ['development database', { DB_DATABASE: 'pet_care_db' }, 'DB_DATABASE must be a dedicated'],
    ['missing database host', { DB_HOST: '' }, 'DB_HOST is required'],
    ['superuser account', { DB_USERNAME: 'postgres' }, 'least-privilege role'],
    ['placeholder DB password', { DB_PASSWORD: 'your_postgres_password' }, 'DB_PASSWORD must be a real credential'],
    ['remote database without TLS', { DB_SSL: 'disable' }, 'DB_SSL=disable is allowed'],
    ['DB_SSL not set', { DB_SSL: undefined }, 'DB_SSL must be set explicitly'],
    ['invalid DB_SSL', { DB_SSL: 'maybe' }, 'DB_SSL must be'],
    ['TRUST_PROXY unset', { TRUST_PROXY: undefined }, 'TRUST_PROXY must be set explicitly'],
    ['TRUST_PROXY=true', { TRUST_PROXY: 'true' }, 'TRUST_PROXY=true would trust spoofed'],
    ['invalid TRUST_PROXY', { TRUST_PROXY: 'proxy.example.com' }, 'TRUST_PROXY entries must be'],
    ['CORS wildcard', { CORS_ORIGINS: 'https://*.pawflow.example' }, 'wildcards'],
    ['CORS http origin', { CORS_ORIGINS: 'http://staging.pawflow.example' }, 'must use https origins'],
    ['CORS localhost origin', { CORS_ORIGINS: 'https://localhost:3000' }, 'must not contain localhost'],
    ['CORS origin with a path', { CORS_ORIGINS: 'https://staging.pawflow.example/app' }, 'bare origins'],
    ['CORS malformed origin', { CORS_ORIGINS: 'staging.pawflow.example' }, 'absolute origins'],
    ['API rate limit disabled', { API_RATE_LIMIT: 'disabled' }, 'API_RATE_LIMIT=disabled is not allowed'],
    ['real push in staging without confirmation', { PUSH_DELIVERY_MODE: 'firebase' }, 'STAGING_ALLOW_REAL_PUSH=true'],
    ['invalid HSTS value', { HSTS_MAX_AGE_SECONDS: '-1' }, 'HSTS_MAX_AGE_SECONDS must be'],
    ['invalid Swagger flag', { SWAGGER_ENABLED: 'yes' }, 'SWAGGER_ENABLED must be'],
    ['invalid migrations check', { MIGRATIONS_CHECK: 'sometimes' }, 'MIGRATIONS_CHECK must be'],
    ['invalid health timeout', { HEALTH_DB_TIMEOUT_MS: '50' }, 'HEALTH_DB_TIMEOUT_MS must be'],
  ])('refuses %s', (_name, override, message) => {
    expect(errorOf({ ...STAGING, ...override })).toContain(message);
  });

  it('reports every violation at once, naming variables but never their values', () => {
    const message = errorOf({ NODE_ENV: 'staging', JWT_SECRET: 'tiny', DB_PASSWORD: 'hunter2', DB_DATABASE: 'pet_care_db', CORS_ORIGINS: 'http://evil.example' });
    expect(message.split('\n- ').length).toBeGreaterThanOrEqual(6);
    for (const value of ['tiny', 'hunter2', 'evil.example']) expect(message).not.toContain(value);
    expect(message).not.toContain(DB_PASSWORD);
  });

  it('allows DB_SSL=disable only for a same-host database; allows explicit direct exposure (TRUST_PROXY=false)', () => {
    expect(loadReleaseConfig({ ...STAGING, DB_HOST: '127.0.0.1', DB_SSL: 'disable' }).dbSsl).toBe('disable');
    expect(loadReleaseConfig({ ...STAGING, TRUST_PROXY: 'false' }).deployed).toBe(true);
    expect(loadReleaseConfig({ ...STAGING, PUSH_DELIVERY_MODE: 'firebase', STAGING_ALLOW_REAL_PUSH: 'true' }).nodeEnv).toBe('staging');
    expect(loadReleaseConfig({ ...STAGING, NODE_ENV: 'production', PUSH_DELIVERY_MODE: 'firebase' }).nodeEnv).toBe('production');
  });

  it('Swagger can be enabled explicitly in staging', () => {
    expect(loadReleaseConfig({ ...STAGING, SWAGGER_ENABLED: 'true' }).swaggerEnabled).toBe(true);
  });

  // P3-BE12 regression: e-mail links fell back to http://localhost:3000 in staging/production.
  describe('e-mail link base with MAIL_TRANSPORT=smtp', () => {
    const SMTP = { ...STAGING, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com' };
    it.each([
      ['unset (fallback http://localhost:3000)', {}],
      ['http', { MAIL_LINK_BASE_URL: 'http://staging.example.com' }],
      ['localhost', { MAIL_LINK_BASE_URL: 'https://localhost:3000' }],
      ['loopback IP', { FRONTEND_URL: 'https://127.0.0.1' }],
      ['not a URL', { MAIL_LINK_BASE_URL: 'staging.example.com' }],
      ['with credentials', { MAIL_LINK_BASE_URL: 'https://u:p@staging.example.com' }],
    ])('refuses a link base that is %s', (_name, extra) => {
      expect(() => loadReleaseConfig({ ...SMTP, ...extra })).toThrow('MAIL_LINK_BASE_URL (or FRONTEND_URL) must be the https URL');
    });
    it('accepts an https frontend URL (MAIL_LINK_BASE_URL or FRONTEND_URL, with or without a path)', () => {
      expect(loadReleaseConfig({ ...SMTP, MAIL_LINK_BASE_URL: 'https://staging.example.com' }).deployed).toBe(true);
      expect(loadReleaseConfig({ ...SMTP, FRONTEND_URL: 'https://staging.example.com/app' }).deployed).toBe(true);
    });
    it('does not apply when e-mail is disabled, nor outside deployed environments', () => {
      expect(loadReleaseConfig({ ...STAGING, MAIL_TRANSPORT: 'disabled' }).deployed).toBe(true);
      expect(loadReleaseConfig({ NODE_ENV: 'development', MAIL_TRANSPORT: 'smtp' }).deployed).toBe(false);
    });
  });
});

describe('origin parsing', () => {
  it('normalizes and de-duplicates exact origins', () => {
    expect(parseOrigins('https://A.example.com, https://a.example.com/, https://b.example.com:8443', 'X', true)).toEqual(['https://a.example.com', 'https://b.example.com:8443']);
  });

  it.each(['https://user:pw@a.example.com', 'https://a.example.com?x=1', 'ftp://a.example.com', 'null', 'https://a.example.com#frag'])('rejects %s', (origin) => {
    expect(() => parseOrigins(origin, 'X', false)).toThrow();
  });
});

describe('postgres TLS option', () => {
  it('maps DB_SSL to the pg ssl option', () => {
    expect(postgresSslOption('disable')).toBe(false);
    expect(postgresSslOption('require')).toEqual({ rejectUnauthorized: true });
    expect(postgresSslOption('no-verify')).toEqual({ rejectUnauthorized: false });
  });
});

/**
 * Regression for the BE11 configuration defect: these fail-closed rules
 * compared NODE_ENV with "production" only, so NODE_ENV=staging silently
 * started with bot protection off, rate limiting off, Cloudflare test
 * secrets, file mail, text logs and development push-registration keys.
 */
describe('staging is fail-closed like production (regression)', () => {
  const cfg = (values: Record<string, string>) => ({ get: (k: string) => values[k], getOrThrow: (k: string) => values[k] }) as unknown as ConfigService;

  it('bot protection must be enforced, with a real secret and the action check', () => {
    expect(() => loadTurnstileConfig(cfg({ NODE_ENV: 'staging' }))).toThrow('when NODE_ENV=staging');
    expect(() => loadTurnstileConfig(cfg({ NODE_ENV: 'staging', TURNSTILE_MODE: 'disabled' }))).toThrow('not allowed when NODE_ENV=staging');
    expect(() => loadTurnstileConfig(cfg({ NODE_ENV: 'staging', TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', TURNSTILE_EXPECTED_HOSTNAMES: 'staging.pawflow.example' }))).toThrow('Cloudflare test secret');
  });

  it('auth and API rate limits cannot be disabled', () => {
    expect(() => loadAuthRateLimitConfig(cfg({ NODE_ENV: 'staging', AUTH_RATE_LIMIT: 'disabled' }))).toThrow('not allowed when NODE_ENV=staging');
    expect(() => loadApiRateLimitConfig(cfg({ NODE_ENV: 'staging', API_RATE_LIMIT: 'disabled' }))).toThrow('not allowed when NODE_ENV=staging');
  });

  it('file mail transport, text logs and derived push keys are refused', () => {
    expect(() => createMailTransport(cfg({ NODE_ENV: 'staging', MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: '.' }))).toThrow('not allowed when NODE_ENV=staging');
    expect(() => loadLoggingConfig({ NODE_ENV: 'staging', LOG_FORMAT: 'text' })).toThrow('not allowed when NODE_ENV=staging');
    expect(() => loadPushRegistrationKeys(cfg({ NODE_ENV: 'staging', JWT_SECRET: SECRET }))).toThrow('required when NODE_ENV=staging');
  });
});
