import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { DEFAULT_API_RATE_LIMIT_POLICIES, loadApiRateLimitConfig, loadAuthRateLimitConfig } from './auth-rate-limit.config';
import { AuthRateLimitService } from './auth-rate-limit.service';

const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;

/** DataSource whose upsert returns `hits` for every policy row it receives. */
function store(hits: number | Error, retryAfter = 42) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: jest.fn((sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (hits instanceof Error) return Promise.reject(hits);
      const policies = params.filter((_, i) => i % 3 === 0) as string[];
      return Promise.resolve(policies.map((policy) => ({ policy, hits, retry_after: String(retryAfter) })));
    }),
  } as unknown as DataSource;
  return { dataSource, calls };
}

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return e instanceof HttpException ? { status: e.getStatus(), body: e.getResponse() } : e;
  }
};

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('API-wide rate-limit configuration (P3-BE11)', () => {
  it('enabled by default with the documented policies', () => {
    const c = loadApiRateLimitConfig(config({ JWT_SECRET: 's' }));
    expect(c).toEqual({ mode: 'enabled', hashSecret: 's', policies: DEFAULT_API_RATE_LIMIT_POLICIES });
    expect(DEFAULT_API_RATE_LIMIT_POLICIES).toEqual({
      api: { name: 'api_ip', key: 'ip', limit: 600, windowSeconds: 60 },
      public: { name: 'public_ip', key: 'ip', limit: 120, windowSeconds: 60 },
      'user-read': { name: 'user_read', key: 'user', limit: 300, windowSeconds: 60 },
      'user-write': { name: 'user_write', key: 'user', limit: 60, windowSeconds: 60 },
    });
  });

  it('overrides, validation, disabled only outside deployed environments', () => {
    const c = loadApiRateLimitConfig(config({ JWT_SECRET: 's', RATE_LIMIT_USER_WRITE: '5/10' }));
    expect(c.mode === 'enabled' && c.policies['user-write']).toMatchObject({ limit: 5, windowSeconds: 10 });
    for (const bad of ['5', '0/10', '5/0', '5/86401', 'x/10']) {
      expect(() => loadApiRateLimitConfig(config({ JWT_SECRET: 's', RATE_LIMIT_API_IP: bad }))).toThrow('RATE_LIMIT_API_IP');
    }
    expect(loadApiRateLimitConfig(config({ API_RATE_LIMIT: 'disabled' }))).toEqual({ mode: 'disabled' });
    for (const env of ['production', 'staging']) {
      expect(() => loadApiRateLimitConfig(config({ API_RATE_LIMIT: 'disabled', NODE_ENV: env }))).toThrow(`not allowed when NODE_ENV=${env}`);
    }
    expect(() => loadApiRateLimitConfig(config({ API_RATE_LIMIT: 'off', JWT_SECRET: 's' }))).toThrow('"enabled" or "disabled"');
  });

  it('new endpoint policies: refresh, e-mail verification, resend and password change', () => {
    const c = loadAuthRateLimitConfig(config({ JWT_SECRET: 's' }));
    expect(c.mode === 'enabled' && {
      refresh: c.policies.refresh, verify: c.policies['verify-email'], resend: c.policies['verify-email-resend'], change: c.policies['change-password'],
    }).toEqual({
      refresh: [{ name: 'refresh_ip', key: 'ip', limit: 60, windowSeconds: 300 }],
      verify: [{ name: 'verify_ip', key: 'ip', limit: 20, windowSeconds: 900 }],
      resend: [{ name: 'verify_resend_user', key: 'user', limit: 5, windowSeconds: 3600 }],
      change: [{ name: 'change_password_user', key: 'user', limit: 5, windowSeconds: 900 }],
    });
  });

  it('every policy name fits the auth_rate_limits.policy column (varchar 32)', () => {
    const c = loadAuthRateLimitConfig(config({ JWT_SECRET: 's' }));
    const names = [...Object.values(c.mode === 'enabled' ? c.policies : {}).flat().map((p) => p.name), ...Object.values(DEFAULT_API_RATE_LIMIT_POLICIES).map((p) => p.name)];
    expect(names.every((n) => n.length <= 32)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('AuthRateLimitService.consumeApi', () => {
  const service = (hits: number | Error, extra: Record<string, string> = {}) => {
    const s = store(hits);
    return { ...s, svc: new AuthRateLimitService(config({ JWT_SECRET: 'secret-for-hmac', ...extra }), s.dataSource) };
  };

  it('counts several scopes in ONE atomic statement with HMAC buckets (no raw IP or id)', async () => {
    const { svc, calls } = service(1);
    await svc.consumeApi(['api', 'public'], { ip: '203.0.113.9' });
    expect(calls).toHaveLength(1);
    expect(calls[0].params.filter((_, i) => i % 3 === 0)).toEqual(['api_ip', 'public_ip']);
    const buckets = calls[0].params.filter((_, i) => i % 3 === 1) as string[];
    expect(buckets.every((b) => /^[0-9a-f]{64}$/.test(b))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('203.0.113.9');
  });

  it('per-user policies use only a numeric verified id; anything else is not counted per user', async () => {
    const { svc, calls } = service(1);
    await svc.consumeApi(['user-read'], { userId: '42' });
    await svc.consumeApi(['user-read'], { userId: 'admin' });
    await svc.consumeApi(['user-read'], {});
    expect(calls).toHaveLength(1);
  });

  it('the same user from different IPs shares one bucket; different users do not', async () => {
    const { svc, calls } = service(1);
    await svc.consumeApi(['user-write'], { userId: '42', ip: '203.0.113.1' });
    await svc.consumeApi(['user-write'], { userId: '42', ip: '198.51.100.1' });
    await svc.consumeApi(['user-write'], { userId: '43' });
    const buckets = calls.map((c) => c.params[1]);
    expect(buckets[0]).toBe(buckets[1]);
    expect(buckets[2]).not.toBe(buckets[0]);
  });

  it('IPv6 clients are grouped per /64; IPv4-mapped addresses equal their IPv4 form', async () => {
    const { svc, calls } = service(1);
    for (const ip of ['2001:db8:0:1::1', '2001:db8:0:1:ffff::2', '2001:db8:0:2::1', '203.0.113.9', '::ffff:203.0.113.9']) await svc.consumeApi(['api'], { ip });
    const b = calls.map((c) => c.params[1]);
    expect(b[0]).toBe(b[1]);
    expect(b[2]).not.toBe(b[0]);
    expect(b[3]).toBe(b[4]);
  });

  it('first excess request -> 429 RATE_LIMITED with retryAfterSeconds; at the limit -> allowed', async () => {
    const limit = DEFAULT_API_RATE_LIMIT_POLICIES.api.limit;
    expect(await status(service(limit).svc.consumeApi(['api'], { ip: '203.0.113.9' }))).toBe(200);
    expect(await status(service(limit + 1).svc.consumeApi(['api'], { ip: '203.0.113.9' }))).toEqual({
      status: 429,
      body: { statusCode: 429, error: 'Too Many Requests', message: 'Too many requests; please try again later', code: 'RATE_LIMITED', retryAfterSeconds: 42 },
    });
  });

  it('fails closed: store unavailable -> 503 RATE_LIMIT_UNAVAILABLE (never let through unmetered)', async () => {
    const result = await status(service(new Error('connection refused')).svc.consumeApi(['api'], { ip: '203.0.113.9' }));
    expect(result).toMatchObject({ status: 503, body: { code: 'RATE_LIMIT_UNAVAILABLE', retryAfterSeconds: 5 } });
  });

  it('disabled (development/test only) -> no database access', async () => {
    const { svc, calls } = service(999, { API_RATE_LIMIT: 'disabled' });
    expect(await status(svc.consumeApi(['api'], { ip: '203.0.113.9' }))).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
