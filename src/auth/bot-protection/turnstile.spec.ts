import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { loadTurnstileConfig, TURNSTILE_SITEVERIFY_URL } from './turnstile.config';
import { BotProtectionException, TurnstileService, type TurnstileFetch } from './turnstile.service';

const SECRET = 'real-looking-secret-0123456789abcdef';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX-' + 'a'.repeat(40);
const ENFORCE = { TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_EXPECTED_HOSTNAMES: 'app.pawflow.vn, Staging.PawFlow.vn' };

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Siteverify stub: one queued reply per call ({ status, json } | 'timeout' | 'network' | raw text). */
function stub(...replies: unknown[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchImpl: TurnstileFetch = (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const reply = replies.shift() ?? { status: 200, json: { success: true, hostname: 'app.pawflow.vn', action: 'login' } };
    if (reply === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (reply === 'timeout') {
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    if (typeof reply === 'string') return Promise.resolve(new Response(reply, { status: 200 }));
    const { status, json } = reply as { status: number; json: unknown };
    return Promise.resolve(new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } }));
  };
  return { calls, fetchImpl };
}

const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, json: { success: true, 'error-codes': [], hostname: 'app.pawflow.vn', action: 'login', challenge_ts: '2026-12-04T00:00:00Z', ...extra } });
const fail = (...codes: string[]) => ({ status: 200, json: { success: false, 'error-codes': codes } });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    if (!(error instanceof BotProtectionException)) throw error;
    return `${error.getStatus()} ${error.code}`;
  }
}

describe('Turnstile configuration (P3-BE03)', () => {
  it('development: unset or explicit disabled -> disabled', () => {
    expect(loadTurnstileConfig(config({}))).toEqual({ mode: 'disabled', reason: 'unset' });
    expect(loadTurnstileConfig(config({ TURNSTILE_MODE: 'disabled' }))).toEqual({ mode: 'disabled', reason: 'explicit' });
  });

  it('production: refuses unset or disabled mode (no silent fallback)', () => {
    expect(() => loadTurnstileConfig(config({ NODE_ENV: 'production' }))).toThrow('TURNSTILE_MODE must be set to "enforce"');
    expect(() => loadTurnstileConfig(config({ NODE_ENV: 'production', TURNSTILE_MODE: 'disabled' }))).toThrow('not allowed when NODE_ENV=production');
  });

  it('rejects unknown modes and incomplete enforcement', () => {
    expect(() => loadTurnstileConfig(config({ TURNSTILE_MODE: 'on' }))).toThrow('"disabled" or "enforce"');
    expect(() => loadTurnstileConfig(config({ TURNSTILE_MODE: 'enforce', TURNSTILE_EXPECTED_HOSTNAMES: 'a.b' }))).toThrow('TURNSTILE_SECRET_KEY is required');
    expect(() => loadTurnstileConfig(config({ TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: SECRET }))).toThrow('TURNSTILE_EXPECTED_HOSTNAMES');
    expect(() => loadTurnstileConfig(config({ ...ENFORCE, TURNSTILE_EXPECTED_HOSTNAMES: 'https://app.pawflow.vn' }))).toThrow('bare hostnames');
    expect(() => loadTurnstileConfig(config({ ...ENFORCE, TURNSTILE_TIMEOUT_MS: '60000' }))).toThrow('TURNSTILE_TIMEOUT_MS');
    expect(() => loadTurnstileConfig(config({ ...ENFORCE, TURNSTILE_CHECK_ACTION: 'maybe' }))).toThrow('true or false');
  });

  it('production: rejects the Cloudflare dummy secrets, disabling the action check and a custom Siteverify URL', () => {
    for (const dummy of ['1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA', '3x0000000000000000000000000000000AA']) {
      expect(() => loadTurnstileConfig(config({ ...ENFORCE, NODE_ENV: 'production', TURNSTILE_SECRET_KEY: dummy }))).toThrow('Cloudflare test secret');
    }
    expect(() => loadTurnstileConfig(config({ ...ENFORCE, NODE_ENV: 'production', TURNSTILE_CHECK_ACTION: 'false' }))).toThrow('TURNSTILE_CHECK_ACTION=false');
    expect(() => loadTurnstileConfig(config({ ...ENFORCE, NODE_ENV: 'production', TURNSTILE_SITEVERIFY_URL: 'http://evil.test/x' }))).toThrow('cannot be overridden');
  });

  it('production enforce: official URL, normalized hostnames, action check on, testing-key results rejected', () => {
    expect(loadTurnstileConfig(config({ ...ENFORCE, NODE_ENV: 'production' }))).toEqual({
      mode: 'enforce',
      secret: SECRET,
      expectedHostnames: new Set(['app.pawflow.vn', 'staging.pawflow.vn']),
      checkAction: true,
      siteverifyUrl: TURNSTILE_SITEVERIFY_URL,
      timeoutMs: 3000,
      rejectTestingKeyResults: true,
    });
  });

  it('the dummy secret is allowed outside production (automated tests)', () => {
    expect(loadTurnstileConfig(config({ ...ENFORCE, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' })).mode).toBe('enforce');
  });
});

describe('TurnstileService (P3-BE03)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const service = (values: Record<string, string | undefined>, fetchImpl: TurnstileFetch) => new TurnstileService(config(values), fetchImpl);

  it('disabled mode skips verification without calling Cloudflare (and warns at startup)', async () => {
    const s = stub();
    await expect(service({}, s.fetchImpl).verify(undefined, 'login')).resolves.toEqual({ verified: false, skipped: true });
    expect(s.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bot verification is DISABLED'));
  });

  it('valid token: POSTs JSON to the fixed URL with secret, response, idempotency_key and remoteip; never follows redirects', async () => {
    const s = stub(ok());
    const result = await service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login', '203.0.113.7');

    expect(result).toEqual({ verified: true, skipped: false, hostname: 'app.pawflow.vn', action: 'login', challengeTs: '2026-12-04T00:00:00Z' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(s.calls[0].init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(s.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(s.calls[0].body).toEqual({ secret: SECRET, response: TOKEN, idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/), remoteip: '203.0.113.7' });
  });

  it('hostnames are compared case-insensitively against the allowlist only', async () => {
    const s = stub(ok({ hostname: 'STAGING.pawflow.vn' }), ok({ hostname: 'evil.example' }));
    const svc = service(ENFORCE, s.fetchImpl);
    await expect(svc.verify(TOKEN, 'login')).resolves.toMatchObject({ verified: true });
    expect(await code(svc.verify(TOKEN, 'login'))).toBe('403 TURNSTILE_INVALID');
  });

  it.each([
    ['missing', undefined, '403 TURNSTILE_REQUIRED'],
    ['null', null, '403 TURNSTILE_REQUIRED'],
    ['empty', '', '403 TURNSTILE_REQUIRED'],
    ['blank', '   ', '403 TURNSTILE_REQUIRED'],
    ['not a string', 12345, '403 TURNSTILE_REQUIRED'],
    ['oversized (2049 chars)', 'a'.repeat(2049), '403 TURNSTILE_INVALID'],
  ])('%s token is rejected without calling Cloudflare', async (_label, token, expected) => {
    const s = stub();
    expect(await code(service(ENFORCE, s.fetchImpl).verify(token, 'login'))).toBe(expected);
    expect(s.calls).toHaveLength(0);
  });

  it('a 2048-character token is accepted (boundary)', async () => {
    const s = stub(ok());
    await expect(service(ENFORCE, s.fetchImpl).verify('a'.repeat(2048), 'login')).resolves.toMatchObject({ verified: true });
  });

  it.each([
    ['invalid-input-response', '403 TURNSTILE_INVALID'],
    ['missing-input-response', '403 TURNSTILE_INVALID'],
    ['timeout-or-duplicate', '403 TURNSTILE_EXPIRED'],
    ['some-future-code', '403 TURNSTILE_INVALID'],
    ['invalid-input-secret', '503 TURNSTILE_UNAVAILABLE'],
    ['missing-input-secret', '503 TURNSTILE_UNAVAILABLE'],
    ['bad-request', '503 TURNSTILE_UNAVAILABLE'],
    ['internal-error', '503 TURNSTILE_UNAVAILABLE'],
  ])('success=false with %s -> %s, without retry', async (cfCode, expected) => {
    const s = stub(fail(cfCode));
    expect(await code(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login'))).toBe(expected);
    expect(s.calls).toHaveLength(1);
  });

  it('wrong action -> 403; the action check can be disabled outside production', async () => {
    const s = stub(ok({ action: 'register' }), ok({ action: 'register' }), ok({ action: undefined }));
    expect(await code(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login'))).toBe('403 TURNSTILE_INVALID');
    await expect(service({ ...ENFORCE, TURNSTILE_CHECK_ACTION: 'false' }, s.fetchImpl).verify(TOKEN, 'login')).resolves.toMatchObject({ verified: true, action: 'register' });
    expect(await code(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login'))).toBe('403 TURNSTILE_INVALID');
  });

  it('a success without hostname is rejected', async () => {
    const s = stub(ok({ hostname: '' }));
    expect(await code(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login'))).toBe('403 TURNSTILE_INVALID');
  });

  it('production rejects results produced by Cloudflare testing keys', async () => {
    const s = stub(ok({ metadata: { result_with_testing_key: true } }));
    expect(await code(service({ ...ENFORCE, NODE_ENV: 'production' }, s.fetchImpl).verify(TOKEN, 'login'))).toBe('403 TURNSTILE_INVALID');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('testing key'));
  });

  it('transient failure then success: exactly one retry with the SAME idempotency key', async () => {
    const s = stub({ status: 502, json: {} }, ok());
    await expect(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login')).resolves.toMatchObject({ verified: true });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1].body.idempotency_key).toBe(s.calls[0].body.idempotency_key);
  });

  it.each([
    ['network error', ['network', 'network']],
    ['HTTP 500', [{ status: 500, json: {} }, { status: 503, json: {} }]],
    ['HTTP 429 from Cloudflare', [{ status: 429, json: {} }, { status: 429, json: {} }]],
    ['non-JSON body', ['<html>oops</html>', '<html>oops</html>']],
    ['malformed JSON (success not boolean)', [{ status: 200, json: { success: 'yes' } }, { status: 200, json: { success: 'yes' } }]],
    ['malformed JSON (error-codes not strings)', [{ status: 200, json: { success: false, 'error-codes': [1] } }, { status: 200, json: { success: false, 'error-codes': [1] } }]],
    ['JSON array', [{ status: 200, json: [] }, { status: 200, json: [] }]],
  ])('%s twice -> 503 TURNSTILE_UNAVAILABLE after 2 bounded attempts (fail closed)', async (_label, replies) => {
    const s = stub(...replies);
    expect(await code(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login'))).toBe('503 TURNSTILE_UNAVAILABLE');
    expect(s.calls).toHaveLength(2);
    expect(new Set(s.calls.map((c) => c.body.idempotency_key)).size).toBe(1);
  });

  it('timeout: each attempt is aborted after TURNSTILE_TIMEOUT_MS; total time bounded', async () => {
    const s = stub('timeout', 'timeout');
    const started = Date.now();
    expect(await code(service({ ...ENFORCE, TURNSTILE_TIMEOUT_MS: '500' }, s.fetchImpl).verify(TOKEN, 'login'))).toBe('503 TURNSTILE_UNAVAILABLE');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(2500);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('timeout after 500 ms'));
  });

  it('an unexpected 4xx without a Siteverify body fails closed without retry', async () => {
    const s = stub({ status: 404, json: { error: 'not found' } });
    expect(await code(service(ENFORCE, s.fetchImpl).verify(TOKEN, 'login'))).toBe('503 TURNSTILE_UNAVAILABLE');
    expect(s.calls).toHaveLength(1);
  });

  it('public error bodies carry only status, message and code (no Cloudflare diagnostics); 503 adds retryAfterSeconds', async () => {
    const s = stub(fail('timeout-or-duplicate'), fail('invalid-input-secret'));
    const svc = service(ENFORCE, s.fetchImpl);
    const expired = await svc.verify(TOKEN, 'login').catch((e: BotProtectionException) => e.getResponse());
    const unavailable = await svc.verify(TOKEN, 'login').catch((e: BotProtectionException) => e.getResponse());
    expect(expired).toEqual({ statusCode: 403, error: 'Forbidden', message: expect.stringContaining('expired or was already used'), code: 'TURNSTILE_EXPIRED' });
    expect(unavailable).toEqual({ statusCode: 503, error: 'Service Unavailable', message: expect.any(String), code: 'TURNSTILE_UNAVAILABLE', retryAfterSeconds: 5 });
    expect(JSON.stringify([expired, unavailable])).not.toMatch(/duplicate|secret/);
  });

  it('never logs the token or the secret', async () => {
    const s = stub(fail('invalid-input-response'), ok({ hostname: 'evil.example' }), 'network', 'network', fail('invalid-input-secret'));
    const svc = service(ENFORCE, s.fetchImpl);
    for (let i = 0; i < 4; i++) await svc.verify(TOKEN, 'register').catch(() => undefined);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...(Logger.prototype.log as jest.Mock).mock.calls]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain('Turnstile rejected register: TURNSTILE_INVALID (invalid-input-response)');
  });

  it('does not cache successes: every call verifies again', async () => {
    const s = stub(ok(), fail('timeout-or-duplicate'));
    const svc = service(ENFORCE, s.fetchImpl);
    await svc.verify(TOKEN, 'login');
    expect(await code(svc.verify(TOKEN, 'login'))).toBe('403 TURNSTILE_EXPIRED');
    expect(s.calls).toHaveLength(2);
  });
});
