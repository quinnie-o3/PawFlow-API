import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { PushSendTarget } from '../../push-devices/push-devices.service';
import type { DeviceFinalOutcome } from '../entities/notification-push-send.entity';
import type { DeliveryResult, PushDestination, PushMessage, PushProvider } from '../provider/push-provider.types';
import type { DeliveryJobContext, DeviceOutcomeRecord, RecordResult } from '../worker/delivery-job.types';
import { type DispatchDevices, PushDispatchExecutor } from './push-dispatch.executor';

const NOW = 1_800_000_000_000;
const NOTIFICATION = { id: '42', type: 'BOOKING_CONFIRMED', title: 'Booking confirmed', body: 'Your booking was confirmed.', target_type: 'BOOKING', target_id: '9' };
const target = (id: string, value: string, kind: 'FID' | 'FCM_TOKEN' = 'FID'): PushSendTarget => ({ deviceId: id, registrationKind: kind, registrationValue: value, platform: 'WEB', lastSeenAt: new Date(NOW) });

function harness(opts: {
  targets: PushSendTarget[];
  results: Record<string, DeliveryResult | ((n: number) => DeliveryResult)>;
  finalized?: Record<string, DeviceFinalOutcome>;
  ineligible?: string[];
  notification?: object | null;
  providerName?: PushProvider['name'];
  expiresInMs?: number;
}) {
  const sends: { dest: PushDestination; msg: PushMessage }[] = [];
  const calls = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const provider: PushProvider = {
    name: opts.providerName ?? 'mock',
    send: async (dest, msg) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sends.push({ dest, msg });
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const n = (calls.get(dest.value) ?? 0) + 1;
      calls.set(dest.value, n);
      const r = opts.results[dest.value] ?? { outcome: 'ACCEPTED', providerMessageId: 'm' };
      return typeof r === 'function' ? r(n) : r;
    },
  };
  const markInvalid = jest.fn().mockResolvedValue({ revoked: true });
  const devices: DispatchDevices = {
    findSendTargets: jest.fn().mockResolvedValue(opts.targets),
    isSendEligible: jest.fn((id: string) => Promise.resolve(!(opts.ineligible ?? []).includes(id))),
    markInvalid,
  };
  const ds = { query: jest.fn().mockResolvedValue(opts.notification === null ? [] : [opts.notification ?? NOTIFICATION]) } as unknown as DataSource;
  const finalized = new Map<string, DeviceFinalOutcome>(Object.entries(opts.finalized ?? {}));
  const records: DeviceOutcomeRecord[] = [];
  const controller = new AbortController();
  const lease = { owned: true };
  const ctx: DeliveryJobContext = {
    jobId: '7',
    notificationId: '42',
    recipientUserId: '5',
    attempt: 1,
    expiresAt: new Date(NOW + (opts.expiresInMs ?? 3_600_000)),
    signal: controller.signal,
    renewLease: () => Promise.resolve(lease.owned),
    finalizedDevices: () => Promise.resolve(new Map(finalized)),
    recordDeviceOutcome: (r): Promise<RecordResult> => {
      if (!lease.owned) return Promise.resolve('LEASE_LOST');
      if (finalized.has(r.pushDeviceId)) return Promise.resolve('ALREADY_FINAL');
      finalized.set(r.pushDeviceId, r.outcome);
      records.push(r);
      return Promise.resolve('RECORDED');
    },
  };
  const executor = new PushDispatchExecutor(ds, devices, provider, { now: () => NOW, concurrency: 2 });
  return { executor, ctx, sends, records, finalized, markInvalid, devices, controller, lease, calls, maxInFlight: () => maxInFlight };
}

const ACCEPTED: DeliveryResult = { outcome: 'ACCEPTED', providerMessageId: 'projects/p/messages/1' };
const FID_A = 'aaaaaaaaaaaaaaaaaaaaA1';
const FID_B = 'bbbbbbbbbbbbbbbbbbbbB2';
const FID_C = 'ccccccccccccccccccccC3';

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  }
});
afterEach(() => jest.restoreAllMocks());

describe('PushDispatchExecutor', () => {
  it('1. zero eligible devices -> NO_DESTINATIONS, no send', async () => {
    const h = harness({ targets: [], results: {} });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'NO_DESTINATIONS' });
    expect(h.sends).toHaveLength(0);
  });

  it('2 + 4 + 6. one FID device accepted -> recorded ACCEPTED, DELIVERED; message from the persisted notification with the remaining TTL', async () => {
    const h = harness({ targets: [target('1', FID_A)], results: { [FID_A]: ACCEPTED }, expiresInMs: 600_000 });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 });
    expect(h.sends[0].dest).toEqual({ kind: 'FID', value: FID_A });
    expect(h.sends[0].msg).toEqual({ notificationId: '42', type: 'BOOKING_CONFIRMED', title: 'Booking confirmed', body: 'Your booking was confirmed.', target: { type: 'BOOKING', id: '9' }, ttlSeconds: 600 });
    expect(h.records).toEqual([expect.objectContaining({ pushDeviceId: '1', outcome: 'ACCEPTED', providerCode: null })]);
  });

  it('3 + 5. multiple devices, FID and legacy token keep their kind', async () => {
    const token = `tok:APA91b${'x'.repeat(70)}`;
    const h = harness({ targets: [target('1', FID_A), target('2', token, 'FCM_TOKEN')], results: {} });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DELIVERED', accepted: 2, failedFinal: 0 });
    expect(h.sends.map((s) => s.dest.kind).sort()).toEqual(['FCM_TOKEN', 'FID']);
  });

  it('13. critical: A ACCEPTED, B TRANSIENT, C INVALID_DESTINATION -> RETRY; A and C final; only C revoked', async () => {
    const h = harness({
      targets: [target('1', FID_A), target('2', FID_B), target('3', FID_C)],
      results: { [FID_B]: { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: false, retryAfterMs: null }, [FID_C]: { outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' } },
    });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'RETRY', category: 'TRANSIENT', code: 'messaging/server-unavailable', retryAfterMs: null, ambiguous: false });
    expect(Object.fromEntries(h.finalized)).toEqual({ '1': 'ACCEPTED', '3': 'INVALID_DESTINATION' });
    expect(h.markInvalid).toHaveBeenCalledTimes(1);
    expect(h.markInvalid).toHaveBeenCalledWith('3', expect.any(Date));
  });

  it('14. retry attempt: finalized devices are not re-sent; B succeeds -> DELIVERED counting earlier outcomes', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B)], results: {}, finalized: { '1': 'ACCEPTED', '3': 'INVALID_DESTINATION' } });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DELIVERED', accepted: 2, failedFinal: 1 });
    expect(h.sends.map((s) => s.dest.value)).toEqual([FID_B]);
  });

  it('8. INVALID_REQUEST: final for the device, never revoked', async () => {
    const h = harness({ targets: [target('1', FID_A)], results: { [FID_A]: { outcome: 'INVALID_REQUEST', code: 'messaging/invalid-argument' } } });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DELIVERED', accepted: 0, failedFinal: 1 });
    expect(h.records[0]).toMatchObject({ outcome: 'INVALID_REQUEST', providerCode: 'messaging/invalid-argument' });
    expect(h.markInvalid).not.toHaveBeenCalled();
  });

  it('9. INVALID_PAYLOAD: shared terminal, stops further sends, nothing recorded or revoked', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B), target('3', FID_C)], results: { [FID_A]: { outcome: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' } } });
    const exec = new PushDispatchExecutor({ query: jest.fn().mockResolvedValue([NOTIFICATION]) } as unknown as DataSource, h.devices, { name: 'mock', send: () => Promise.resolve({ outcome: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' }) }, { now: () => NOW, concurrency: 1 });
    await expect(exec.execute(h.ctx)).resolves.toEqual({ kind: 'TERMINAL', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' });
    expect(h.records).toHaveLength(0);
    expect(h.markInvalid).not.toHaveBeenCalled();
  });

  it('11. RATE_LIMITED: stops new sends this attempt; returns the largest Retry-After', async () => {
    const h = harness({
      targets: [target('1', FID_A), target('2', FID_B), target('3', FID_C)],
      results: {
        [FID_A]: { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: true, retryAfterMs: 30_000 },
        [FID_B]: { outcome: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 120_000 },
      },
    });
    // Sequential (concurrency 1) so "no new send after quota" is deterministic.
    const sequential = new PushDispatchExecutor({ query: jest.fn().mockResolvedValue([NOTIFICATION]) } as unknown as DataSource, h.devices, {
      name: 'mock',
      send: (dest) => {
        h.sends.push({ dest, msg: {} as PushMessage });
        return Promise.resolve((dest.value === FID_A ? { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: true, retryAfterMs: 30_000 } : { outcome: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 120_000 }) as DeliveryResult);
      },
    }, { now: () => NOW, concurrency: 1 });
    const out = await sequential.execute(h.ctx);
    expect(out).toEqual({ kind: 'RETRY', category: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 120_000, ambiguous: true });
    expect(h.sends.map((s) => s.dest.value)).toEqual([FID_A, FID_B]); // C never started after the quota error
    expect(h.records).toHaveLength(0);
  });

  it('12. CONFIGURATION: shared, never revokes', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B)], results: { [FID_A]: { outcome: 'CONFIGURATION', code: 'app/invalid-credential' }, [FID_B]: { outcome: 'CONFIGURATION', code: 'app/invalid-credential' } } });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'CONFIGURATION', code: 'app/invalid-credential' });
    expect(h.markInvalid).not.toHaveBeenCalled();
  });

  it('DISABLED provider -> DISABLED without reading anything', async () => {
    const h = harness({ targets: [target('1', FID_A)], results: {}, providerName: 'disabled' });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DISABLED' });
    expect(h.devices.findSendTargets).not.toHaveBeenCalled();
  });

  it('notification missing (deleted) -> TERMINAL NOTIFICATION_MISSING', async () => {
    const h = harness({ targets: [target('1', FID_A)], results: {}, notification: null });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'TERMINAL', category: 'NOTIFICATION_MISSING', code: 'pawflow/notification-missing' });
    expect(h.sends).toHaveLength(0);
  });

  it('18-23. devices no longer eligible at send time are skipped (not sent, not recorded)', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B)], results: {}, ineligible: ['1'] });
    await expect(h.executor.execute(h.ctx)).resolves.toEqual({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 });
    expect(h.sends.map((s) => s.dest.value)).toEqual([FID_B]);
    const all = harness({ targets: [target('1', FID_A)], results: {}, ineligible: ['1'] });
    await expect(all.executor.execute(all.ctx)).resolves.toEqual({ kind: 'NO_DESTINATIONS' });
  });

  it('25. deadline: no send starts with < 1 s left; the worker expires the job', async () => {
    const h = harness({ targets: [target('1', FID_A)], results: {}, expiresInMs: 500 });
    await expect(h.executor.execute(h.ctx)).resolves.toMatchObject({ kind: 'RETRY', code: 'pawflow/deadline-reached' });
    expect(h.sends).toHaveLength(0);
  });

  it('26. aborted (shutdown / timeout): no new sends; saved outcomes stay', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B), target('3', FID_C)], results: {} });
    const exec = new PushDispatchExecutor({ query: jest.fn().mockResolvedValue([NOTIFICATION]) } as unknown as DataSource, h.devices, {
      name: 'mock',
      send: () => {
        h.controller.abort(new Error('worker shutdown'));
        return Promise.resolve(ACCEPTED);
      },
    }, { now: () => NOW, concurrency: 1 });
    await expect(exec.execute(h.ctx)).resolves.toMatchObject({ kind: 'RETRY', code: 'pawflow/dispatch-aborted' });
    expect(h.records.map((r) => r.pushDeviceId)).toEqual(['1']);
  });

  it('17. lease lost: nothing recorded after it, no further sends, no revocation', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_C)], results: { [FID_C]: { outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' } } });
    h.lease.owned = false;
    await expect(h.executor.execute(h.ctx)).resolves.toMatchObject({ kind: 'RETRY', code: 'pawflow/lease-lost' });
    expect(h.sends).toHaveLength(0); // renewLease fails before any send
    const h2 = harness({ targets: [target('3', FID_C)], results: {} });
    const exec = new PushDispatchExecutor({ query: jest.fn().mockResolvedValue([NOTIFICATION]) } as unknown as DataSource, h2.devices, {
      name: 'mock',
      send: () => {
        h2.lease.owned = false; // reclaimed while the provider call was in flight
        return Promise.resolve({ outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' });
      },
    }, { now: () => NOW });
    await expect(exec.execute(h2.ctx)).resolves.toMatchObject({ kind: 'RETRY', code: 'pawflow/lease-lost' });
    expect(h2.records).toHaveLength(0);
    expect(h2.markInvalid).not.toHaveBeenCalled();
  });

  it('per-device sends are bounded by the concurrency limit', async () => {
    const targets = Array.from({ length: 8 }, (_, i) => target(String(i + 1), `${'d'.repeat(20)}${i}x`));
    const h = harness({ targets, results: {} });
    await h.executor.execute(h.ctx);
    expect(h.sends).toHaveLength(8);
    expect(h.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it('errors (e.g. database) stop new sends and propagate (worker: ambiguous transient retry)', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B)], results: {} });
    (h.devices.isSendEligible as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
    await expect(h.executor.execute(h.ctx)).rejects.toThrow('connection lost');
  });

  it('28. logs contain counts and ids only, never destination values or content', async () => {
    const h = harness({ targets: [target('1', FID_A), target('2', FID_B)], results: { [FID_B]: { outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' } } });
    await h.executor.execute(h.ctx);
    const text = logged.join('\n');
    expect(text).toMatch(/Push dispatch job 7 \(notification 42, attempt 1\): devices=2 .* -> DELIVERED/);
    for (const secret of [FID_A, FID_B, 'Booking confirmed', 'Your booking']) expect(text).not.toContain(secret);
  });
});
