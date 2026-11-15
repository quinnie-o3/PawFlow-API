import { type ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { RetryAfterFilter } from '../../common/filters/retry-after.filter';
import { parseTrustProxy } from '../../common/utils/trust-proxy';
import type { AccountRecoveryService } from '../account-recovery.service';
import { AuthController } from '../auth.controller';
import type { AuthService } from '../auth.service';
import type { EmailVerificationService } from '../email-verification.service';
import { RateLimitedException } from '../rate-limit/auth-rate-limit.service';
import { BotProtectionException, TurnstileService, type TurnstileFetch } from './turnstile.service';

const ENFORCE = { TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: 'secret-for-spec', TURNSTILE_EXPECTED_HOSTNAMES: 'app.pawflow.vn' };
const REQ = { ip: '203.0.113.9', headers: {} } as unknown as Request;

function controller(values: Record<string, string>, reply: { success: boolean; action?: string; 'error-codes'?: string[] }) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl: TurnstileFetch = (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(JSON.stringify({ hostname: 'app.pawflow.vn', ...reply }), { status: 200 }));
  };
  const turnstile = new TurnstileService({ get: (k: string) => values[k] } as unknown as ConfigService, fetchImpl);
  const auth = { login: jest.fn().mockResolvedValue({ ok: true }), register: jest.fn().mockResolvedValue({ ok: true }) };
  const recovery = { requestPasswordReset: jest.fn().mockResolvedValue(undefined), resetPassword: jest.fn().mockResolvedValue(undefined) };
  const ctrl = new AuthController(auth as unknown as AuthService, recovery as unknown as AccountRecoveryService, {} as EmailVerificationService, turnstile);
  return { ctrl, auth, recovery, sent };
}

const TOKEN = 'token-from-widget';

describe('Bot protection on auth endpoints (P3-BE03)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const calls = [
    ['login', (c: AuthController) => c.login({ email: 'a@x.test', password: 'Password123', turnstileToken: TOKEN }, REQ), 'login'],
    ['register', (c: AuthController) => c.register({ fullName: 'A B', email: 'a@x.test', password: 'Password123', turnstileToken: TOKEN }, REQ), 'register'],
    ['forgot-password', (c: AuthController) => c.forgotPassword({ email: 'a@x.test', turnstileToken: TOKEN }, REQ), 'forgot_password'],
    ['reset-password', (c: AuthController) => c.resetPassword({ token: 'A'.repeat(43), newPassword: 'Password123', turnstileToken: TOKEN }, REQ), 'reset_password'],
  ] as const;
  const downstream = (h: ReturnType<typeof controller>) => [h.auth.login, h.auth.register, h.recovery.requestPasswordReset, h.recovery.resetPassword];

  it.each(calls)('%s: a rejected challenge never reaches the auth/recovery service (no session, no account, no token consumed)', async (_name, call) => {
    const h = controller(ENFORCE, { success: false, 'error-codes': ['invalid-input-response'] });
    await expect(call(h.ctrl)).rejects.toBeInstanceOf(BotProtectionException);
    for (const fn of downstream(h)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(calls)('%s: a token issued for another action is rejected before the service', async (_name, call, action) => {
    const h = controller(ENFORCE, { success: true, action: action === 'login' ? 'register' : 'login' });
    await expect(call(h.ctrl)).rejects.toMatchObject({ code: 'TURNSTILE_INVALID' });
    for (const fn of downstream(h)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(calls)('%s: a valid challenge for the right action proceeds; the client IP is forwarded as remoteip', async (_name, call, action) => {
    const h = controller(ENFORCE, { success: true, action });
    await call(h.ctrl); // resolves (reset-password returns void -> 204)
    expect(h.sent).toEqual([expect.objectContaining({ response: TOKEN, remoteip: '203.0.113.9' })]);
    expect(downstream(h).filter((fn) => fn.mock.calls.length === 1)).toHaveLength(1);
  });

  it('enforcement: a missing token is rejected (403 TURNSTILE_REQUIRED); client flags cannot bypass it', async () => {
    const h = controller(ENFORCE, { success: true, action: 'login' });
    const sneaky = { email: 'a@x.test', password: 'Password123', turnstileBypass: true, role: 'ADMIN' } as never;
    await expect(h.ctrl.login(sneaky, { ...REQ, headers: { 'x-turnstile-bypass': '1' } } as unknown as Request)).rejects.toMatchObject({ code: 'TURNSTILE_REQUIRED' });
    expect(h.auth.login).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  it('disabled mode (development): requests without a token proceed unchanged', async () => {
    const h = controller({}, { success: false });
    await expect(h.ctrl.login({ email: 'a@x.test', password: 'Password123' }, REQ)).resolves.toEqual({ ok: true });
    expect(h.sent).toHaveLength(0);
  });

  it('forgot-password: the challenge outcome does not depend on the e-mail (verified before any lookup)', async () => {
    const h = controller(ENFORCE, { success: false, 'error-codes': ['timeout-or-duplicate'] });
    const errors = await Promise.all(['exists@x.test', 'nobody@x.test'].map((email) => h.ctrl.forgotPassword({ email, turnstileToken: TOKEN }, REQ).catch((e: HttpException) => [e.getStatus(), e.getResponse()])));
    expect(errors[0]).toEqual(errors[1]);
    expect(h.recovery.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe('RetryAfterFilter', () => {
  function host() {
    const headers: Record<string, string> = {};
    const response = { headersSent: false, setHeader: (k: string, v: string) => (headers[k] = v) };
    return { headers, host: { getType: () => 'http', switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost };
  }

  it('sets Retry-After from retryAfterSeconds (429 and 503) and delegates rendering', () => {
    const filter = new RetryAfterFilter();
    const render = jest.spyOn(Object.getPrototypeOf(RetryAfterFilter.prototype), 'catch').mockImplementation(() => undefined);
    const a = host();
    filter.catch(new RateLimitedException(42), a.host);
    const b = host();
    filter.catch(new BotProtectionException('TURNSTILE_UNAVAILABLE'), b.host);
    const c = host();
    filter.catch(new BotProtectionException('TURNSTILE_INVALID'), c.host);
    expect(a.headers).toEqual({ 'Retry-After': '42' });
    expect(b.headers).toEqual({ 'Retry-After': '5' });
    expect(c.headers).toEqual({});
    expect(render).toHaveBeenCalledTimes(3);
  });
});

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', 1],
    ['loopback', ['loopback']],
    ['10.0.0.0/8, 172.16.0.5, loopback', ['10.0.0.0/8', '172.16.0.5', 'loopback']],
    ['fd00::/8', ['fd00::/8']],
  ])('%s -> %j', (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });

  it.each(['true', 'TRUE', '0', '11', '10.0.0.0/33', 'proxy.example.com', '*'])('rejects %s', (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow('TRUST_PROXY');
  });
});
