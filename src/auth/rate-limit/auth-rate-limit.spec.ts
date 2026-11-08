import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { loadAuthRateLimitConfig } from './auth-rate-limit.config';
import { AuthRateLimitService, normalizeClientIp } from './auth-rate-limit.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** In-memory model of the atomic upsert (one counter per policy/bucket/window). */
function fakeDataSource(nowSeconds: () => number) {
  const counters = new Map<string, number>();
  const queries: { sql: string; params: unknown[] }[] = [];
  let failWith: Error | null = null;
  return {
    counters,
    queries,
    fail: (e: Error | null) => (failWith = e),
    dataSource: {
      query: (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (failWith) return Promise.reject(failWith);
        const out = [];
        for (let i = 0; i < params.length; i += 3) {
          const [policy, bucket, window] = params.slice(i, i + 3) as [string, string, number];
          const start = Math.floor(nowSeconds() / window) * window;
          const key = `${policy}|${bucket}|${start}`;
          counters.set(key, (counters.get(key) ?? 0) + 1);
          out.push({ policy, hits: counters.get(key), retry_after: String(start + window - nowSeconds()) });
        }
        return Promise.resolve(out);
      },
    } as unknown as DataSource,
  };
}

async function status(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (e) {
    return e instanceof HttpException ? { status: e.getStatus(), body: e.getResponse() } : e;
  }
}

describe('Auth rate-limit configuration (P3-BE03)', () => {
  it('enabled by default with the documented policies', () => {
    const c = loadAuthRateLimitConfig(config({ JWT_SECRET: 's' }));
    expect(c.mode).toBe('enabled');
    if (c.mode !== 'enabled') return;
    expect(c.policies.login).toEqual([
      { name: 'login_ip', key: 'ip', limit: 20, windowSeconds: 300 },
      { name: 'login_email', key: 'email', limit: 10, windowSeconds: 900 },
    ]);
    expect(c.policies['forgot-password'].map((p) => p.name)).toEqual(['forgot_ip', 'forgot_email']);
    expect(c.policies.register).toEqual([{ name: 'register_ip', key: 'ip', limit: 10, windowSeconds: 3600 }]);
    expect(c.policies['reset-password']).toEqual([{ name: 'reset_ip', key: 'ip', limit: 10, windowSeconds: 900 }]);
  });

  it('accepts overrides and rejects malformed ones', () => {
    const c = loadAuthRateLimitConfig(config({ JWT_SECRET: 's', RATE_LIMIT_LOGIN_IP: '3/60' }));
    expect(c.mode === 'enabled' && c.policies.login[0]).toMatchObject({ limit: 3, windowSeconds: 60 });
    for (const bad of ['3', '0/60', '3/0', '3/100000', 'abc/60', '-1/60']) {
      expect(() => loadAuthRateLimitConfig(config({ JWT_SECRET: 's', RATE_LIMIT_LOGIN_IP: bad }))).toThrow('RATE_LIMIT_LOGIN_IP');
    }
  });

  it('disabled only outside production; unknown values rejected; needs a hash secret', () => {
    expect(loadAuthRateLimitConfig(config({ AUTH_RATE_LIMIT: 'disabled' }))).toEqual({ mode: 'disabled' });
    expect(() => loadAuthRateLimitConfig(config({ AUTH_RATE_LIMIT: 'disabled', NODE_ENV: 'production' }))).toThrow('not allowed');
    expect(() => loadAuthRateLimitConfig(config({ AUTH_RATE_LIMIT: 'off', JWT_SECRET: 's' }))).toThrow('"enabled" or "disabled"');
    expect(() => loadAuthRateLimitConfig(config({}))).toThrow('RATE_LIMIT_HASH_SECRET or JWT_SECRET');
  });
});

describe('normalizeClientIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:0db8:abcd:0012::/64'],
    ['2001:db8:abcd:12::99', '2001:0db8:abcd:0012::/64'],
    ['::1', '0000:0000:0000:0000::/64'],
    [undefined, 'unknown'],
    ['not-an-ip', 'unknown'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });
});

describe('AuthRateLimitService (P3-BE03)', () => {
  let now = 1_800_000_000;
  let f: ReturnType<typeof fakeDataSource>;
  let warn: jest.SpyInstance;
  const create = (values: Record<string, string> = {}) => new AuthRateLimitService(config({ JWT_SECRET: 'hash-secret', RATE_LIMIT_LOGIN_IP: '3/60', RATE_LIMIT_LOGIN_EMAIL: '2/60', ...values }), f.dataSource);

  beforeEach(() => {
    now = 1_800_000_000;
    f = fakeDataSource(() => now);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('allows up to the limit, then 429 with RATE_LIMITED and retryAfterSeconds until the window ends', async () => {
    const s = create();
    for (let i = 0; i < 2; i++) expect(await status(s.consume('login', { ip: '1.1.1.1', email: `u${i}@x.test` }))).toBe(200);
    expect(await status(s.consume('login', { ip: '1.1.1.1', email: 'u9@x.test' }))).toBe(200);
    now += 15;
    const blocked = await status(s.consume('login', { ip: '1.1.1.1', email: 'u10@x.test' }));
    expect(blocked).toEqual({ status: 429, body: { statusCode: 429, error: 'Too Many Requests', message: expect.any(String), code: 'RATE_LIMITED', retryAfterSeconds: 45 } });
  });

  it('a new window starts a new count (window expiry)', async () => {
    const s = create();
    for (let i = 0; i < 3; i++) await s.consume('login', { ip: '1.1.1.1' });
    expect(await status(s.consume('login', { ip: '1.1.1.1' }))).toMatchObject({ status: 429 });
    now += 60;
    expect(await status(s.consume('login', { ip: '1.1.1.1' }))).toBe(200);
  });

  it('clients are counted separately (per IP)', async () => {
    const s = create();
    for (let i = 0; i < 3; i++) await s.consume('login', { ip: '1.1.1.1' });
    expect(await status(s.consume('login', { ip: '1.1.1.1' }))).toMatchObject({ status: 429 });
    expect(await status(s.consume('login', { ip: '2.2.2.2' }))).toBe(200);
  });

  it('the per-e-mail limit applies across IPs, normalized, whether or not an account exists', async () => {
    const s = create();
    expect(await status(s.consume('login', { ip: '1.1.1.1', email: 'Victim@X.test' }))).toBe(200);
    expect(await status(s.consume('login', { ip: '2.2.2.2', email: ' victim@x.test ' }))).toBe(200);
    expect(await status(s.consume('login', { ip: '3.3.3.3', email: 'victim@x.test' }))).toMatchObject({ status: 429 });
  });

  it('a body without an e-mail is only IP-limited', async () => {
    const s = create();
    await s.consume('login', { ip: '1.1.1.1', email: 42 });
    expect(f.queries[0].params).toHaveLength(3);
  });

  it('stores only HMAC buckets: no raw IP or e-mail in the query parameters', async () => {
    const s = create();
    await s.consume('forgot-password', { ip: '198.51.100.23', email: 'private@x.test' });
    const params = JSON.stringify(f.queries[0].params);
    expect(params).not.toContain('198.51.100.23');
    expect(params).not.toContain('private@x.test');
    expect(f.queries[0].params.filter((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))).toHaveLength(2);
    expect(f.queries[0].sql).toMatch(/ON CONFLICT \(policy, bucket, window_start\) DO UPDATE SET hits = auth_rate_limits\.hits \+ 1/);
  });

  it('logs policy names only when blocking', async () => {
    const s = create();
    for (let i = 0; i < 4; i++) await s.consume('login', { ip: '1.1.1.1', email: 'who@x.test' }).catch(() => undefined);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('Rate limit exceeded (login: login_ip,login_email)');
    expect(logged).not.toMatch(/1\.1\.1\.1|who@x\.test/);
  });

  it('fails closed with 503 RATE_LIMIT_UNAVAILABLE when the store cannot be written', async () => {
    const s = create();
    f.fail(new Error('relation "auth_rate_limits" does not exist'));
    expect(await status(s.consume('login', { ip: '1.1.1.1' }))).toMatchObject({ status: 503, body: { code: 'RATE_LIMIT_UNAVAILABLE', retryAfterSeconds: 5 } });
  });

  it('disabled mode never touches the store', async () => {
    const s = create({ AUTH_RATE_LIMIT: 'disabled' });
    for (let i = 0; i < 50; i++) expect(await status(s.consume('login', { ip: '1.1.1.1' }))).toBe(200);
    expect(f.queries).toHaveLength(0);
  });
});
