import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import type { PushSendTarget } from '../../push-devices/push-devices.service';
import type { DeviceFinalOutcome } from '../entities/notification-push-send.entity';
import type { DeliveryResult, PushDestination, PushProvider } from '../provider/push-provider.types';
import type { DeliveryJobContext, RecordResult } from '../worker/delivery-job.types';
import { decideTransition } from '../worker/retry-policy';
import { type DispatchConsent, type DispatchDevices, PushDispatchExecutor } from './push-dispatch.executor';

const NOW = 1_800_000_000_000;
const NOTIFICATION = { id: '42', type: 'BOOKING_CONFIRMED', title: 'Booking confirmed', body: 'Confirmed.', target_type: 'BOOKING', target_id: '9' };
const FID = (c: string) => `${c.repeat(20)}${c.toUpperCase()}1`;
const target = (id: string, value: string): PushSendTarget => ({ deviceId: id, registrationKind: 'FID', registrationValue: value, platform: 'WEB', lastSeenAt: new Date(NOW) });
const ALLOW = { optedIn: true, inCurrentEpoch: true };
const OFF = { optedIn: false, inCurrentEpoch: false };

/** consentSeq: one entry per consent read (start + one per device); a function may throw or hang. */
function harness(opts: { targets: PushSendTarget[]; consentSeq: unknown[]; results?: Record<string, DeliveryResult>; finalized?: Record<string, DeviceFinalOutcome>; concurrency?: number; consentTimeoutMs?: number }) {
  const sends: PushDestination[] = [];
  const provider: PushProvider = { name: 'mock', send: (dest) => (sends.push(dest), Promise.resolve(opts.results?.[dest.value] ?? { outcome: 'ACCEPTED', providerMessageId: 'm' })) };
  const devices: DispatchDevices = { findSendTargets: jest.fn().mockResolvedValue(opts.targets), isSendEligible: jest.fn().mockResolvedValue(true), markInvalid: jest.fn() };
  let i = 0;
  const consentCalls: unknown[][] = [];
  const consent: DispatchConsent = {
    getPushConsentForNotification: jest.fn((...args: unknown[]) => {
      consentCalls.push(args);
      const next = opts.consentSeq[Math.min(i++, opts.consentSeq.length - 1)];
      return typeof next === 'function' ? (next as () => Promise<never>)() : Promise.resolve(next as never);
    }),
  };
  const finalized = new Map<string, DeviceFinalOutcome>(Object.entries(opts.finalized ?? {}));
  const records: string[] = [];
  const ctx: DeliveryJobContext = {
    jobId: '7',
    notificationId: '42',
    recipientUserId: '5',
    attempt: 2,
    expiresAt: new Date(NOW + 3_600_000),
    signal: new AbortController().signal,
    renewLease: () => Promise.resolve(true),
    finalizedDevices: () => Promise.resolve(new Map(finalized)),
    recordDeviceOutcome: (r): Promise<RecordResult> => (records.push(`${r.pushDeviceId}:${r.outcome}`), finalized.set(r.pushDeviceId, r.outcome), Promise.resolve('RECORDED')),
  };
  const ds = { query: jest.fn().mockResolvedValue([NOTIFICATION]) } as unknown as DataSource;
  const executor = new PushDispatchExecutor(ds, devices, provider, consent, { now: () => NOW, concurrency: opts.concurrency ?? 1, consentTimeoutMs: opts.consentTimeoutMs ?? 2_000 });
  return { executor, ctx, sends, records, devices, consentCalls, finalized };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  }
});
afterEach(() => jest.restoreAllMocks());

describe('BE07-03 consent gate in PushDispatchExecutor', () => {
  it('1 + 2 + 7. not opted in (missing row / OFF) at attempt start -> SUPPRESSED; no device lookup, no send', async () => {
    const h = harness({ targets: [target('1', FID('a'))], consentSeq: [OFF] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' });
    expect(h.devices.findSendTargets).not.toHaveBeenCalled();
    expect(h.sends).toHaveLength(0);
  });

  it('5. opted in, but the notification predates the current consent period -> SUPPRESSED', async () => {
    const h = harness({ targets: [target('1', FID('a'))], consentSeq: [{ optedIn: true, inCurrentEpoch: false }] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' });
    expect(h.sends).toHaveLength(0);
  });

  it('3. opted in within the period -> delivered; consent re-read before EVERY send, always for the job recipient and notification', async () => {
    const h = harness({ targets: [target('1', FID('a')), target('2', FID('b'))], consentSeq: [ALLOW] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DELIVERED', accepted: 2, failedFinal: 0 });
    expect(h.consentCalls).toEqual([['5', '42'], ['5', '42'], ['5', '42']]); // start + 2 devices
  });

  it('9. opt-out observed between selection and send: earlier sends kept, no further send -> SUPPRESSED', async () => {
    const h = harness({ targets: [target('1', FID('a')), target('2', FID('b')), target('3', FID('c'))], consentSeq: [ALLOW, ALLOW, OFF] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' });
    expect(h.sends.map((d) => d.value)).toEqual([FID('a')]);
    expect(h.records).toEqual(['1:ACCEPTED']);
  });

  it('10 + 28. opt-out during a retry: finalized rows untouched, unresolved devices never sent', async () => {
    const h = harness({ targets: [target('1', FID('a')), target('2', FID('b'))], finalized: { '1': 'ACCEPTED' }, consentSeq: [OFF] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' });
    expect(h.sends).toHaveLength(0);
    expect(Object.fromEntries(h.finalized)).toEqual({ '1': 'ACCEPTED' });
  });

  it('an authoritative opt-out wins over a transient failure in the same attempt (terminal, not retried)', async () => {
    const h = harness({ targets: [target('1', FID('a')), target('2', FID('b'))], consentSeq: [ALLOW, ALLOW, OFF], results: { [FID('a')]: { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: false, retryAfterMs: null } } });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' });
  });

  it('15 + 17 + 18 + 19. consent read error at start -> retryable RETRY (consent-unavailable), not ambiguous; no device lookup, no send, never SUPPRESSED', async () => {
    for (const error of [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), Object.assign(new Error('relation "notification_preferences" does not exist'), { code: '42P01' })]) {
      const h = harness({ targets: [target('1', FID('a'))], consentSeq: [() => Promise.reject(error)] });
      await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'RETRY', category: 'TRANSIENT', code: 'pawflow/consent-unavailable', ambiguous: false });
      expect(h.devices.findSendTargets).not.toHaveBeenCalled();
      expect(h.sends).toHaveLength(0);
    }
  });

  it('16. consent read hangs -> bounded by the timeout -> RETRY, nothing sent', async () => {
    const h = harness({ targets: [target('1', FID('a'))], consentSeq: [() => new Promise(() => undefined)], consentTimeoutMs: 50 });
    const t = Date.now();
    await expect(h.executor.execute(h.ctx)).resolves.toMatchObject({ kind: 'RETRY', code: 'pawflow/consent-unavailable' });
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(h.sends).toHaveLength(0);
  });

  it('consent read error before the 2nd device: 1st device result kept, 2nd not sent, RETRY (not SUPPRESSED, not DONE)', async () => {
    const h = harness({ targets: [target('1', FID('a')), target('2', FID('b'))], consentSeq: [ALLOW, ALLOW, () => Promise.reject(new Error('timeout'))] });
    await expect(h.executor.execute(h.ctx)).resolves.toMatchObject({ kind: 'RETRY', code: 'pawflow/consent-unavailable' });
    expect(h.sends.map((d) => d.value)).toEqual([FID('a')]);
    expect(h.records).toEqual(['1:ACCEPTED']);
  });

  it('notification deleted mid-attempt (consent read returns null) -> TERMINAL NOTIFICATION_MISSING, no send', async () => {
    const h = harness({ targets: [target('1', FID('a'))], consentSeq: [ALLOW, null] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'TERMINAL', category: 'NOTIFICATION_MISSING', code: 'pawflow/notification-missing' });
    expect(h.sends).toHaveLength(0);
  });

  it('30. logs: no destination values, no notification content', async () => {
    const h = harness({ targets: [target('1', FID('a')), target('2', FID('b'))], consentSeq: [ALLOW, ALLOW, () => Promise.reject(Object.assign(new Error(`bad ${FID('b')}`), { code: 'XX000' }))] });
    await h.executor.execute(h.ctx);
    const text = logged.join('\n');
    expect(text).not.toContain(FID('a'));
    expect(text).not.toContain(FID('b'));
    expect(text).not.toContain('Booking confirmed');
    expect(text).toMatch(/Push consent for job 7 unavailable \(Error\(XX000\)\); not sending, will retry/);
  });
});

describe('worker transition for SUPPRESSED', () => {
  it('maps to DONE with category PUSH_OPTED_OUT (never FAILED, never retried, independent of attempts)', () => {
    for (const attempt of [1, 8]) {
      expect(decideTransition({ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' }, attempt, { maxAttempts: 8, retryBaseMs: 30_000, retryMaxMs: 3_600_000 })).toEqual({ to: 'DONE', category: 'PUSH_OPTED_OUT', code: 'pawflow/push-opted-out' });
    }
  });
});

describe('NotificationPreferencesService.getPushConsentForNotification', () => {
  it('compares created_at with the consent epoch INSIDE PostgreSQL (microsecond precision); missing preference row = not opted in', async () => {
    const query = jest.fn().mockResolvedValue([{ opted_in: true, in_epoch: false }]);
    const svc = new NotificationPreferencesService({ query } as unknown as DataSource, { get: () => undefined } as unknown as ConfigService);
    await expect(svc.getPushConsentForNotification('5', '42')).resolves.toEqual({ optedIn: true, inCurrentEpoch: false });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ')).toMatch(/LEFT JOIN notification_preferences p ON p\.user_id = n\.recipient_user_id/);
    expect(sql).toMatch(/COALESCE\(p\.push_enabled AND n\.created_at >= p\.push_enabled_at, false\)/);
    expect(sql).toMatch(/WHERE n\.id = \$1 AND n\.recipient_user_id = \$2/);
    expect(params).toEqual(['42', '5']);
    query.mockResolvedValueOnce([]);
    await expect(svc.getPushConsentForNotification('5', '999')).resolves.toBeNull();
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.getPushConsentForNotification('5', '42')).rejects.toThrow('db down');
  });
});
