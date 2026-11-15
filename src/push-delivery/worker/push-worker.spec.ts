import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { loadPushDeliveryConfig } from '../push-delivery.config';
import type { ClaimedJob, DeliveryJobContext, DeliveryJobExecutor, JobExecutionOutcome } from './delivery-job.types';
import { PushDeliveryWorker } from './push-delivery.worker';
import type { PushJobStore } from './push-job.store';
import { CONFIGURATION_MIN_RETRY_MS, loadPushWorkerConfig, type PushWorkerConfig, QUOTA_MIN_RETRY_MS } from './push-worker.config';
import { computeRetryDelayMs, decideTransition, safeCode } from './retry-policy';

/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http') as typeof import('node:http');
const https = require('node:https') as typeof import('node:https');
const http2 = require('node:http2') as typeof import('node:http2');
const net = require('node:net') as typeof import('node:net');
/* eslint-enable @typescript-eslint/no-require-imports */

const cfg = (v: Record<string, string | undefined>) => ({ get: (k: string) => v[k] }) as unknown as ConfigService;
const POLICY = { maxAttempts: 4, retryBaseMs: 30_000, retryMaxMs: 3_600_000 };
const MID = () => 0.5; // no jitter

const WORKER: PushWorkerConfig = { enabled: true, batchSize: 3, pollMs: 200, leaseSeconds: 30, jobTimeoutMs: 1_000, maxAttempts: 4, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 200 };

/** In-memory store with the PushJobStore contract (SQL semantics are covered by test/qa/push-worker.cjs). */
class FakeStore {
  jobs: Array<{ id: string; status: string; attempt: number; expiresAt: Date; token: string | null; category?: string | null; code?: string | null; delayMs?: number }> = [];
  down = false;
  seq = 0;
  calls: string[] = [];
  private guard() {
    if (this.down) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret'), { name: 'QueryFailedError', code: 'ECONNREFUSED' });
  }
  add(id: string, expiresInMs = 3_600_000) {
    this.jobs.push({ id, status: 'PENDING', attempt: 0, expiresAt: new Date(Date.now() + expiresInMs), token: null });
  }
  claim(workerId: string, limit: number): Promise<ClaimedJob[]> {
    this.calls.push('claim');
    this.guard();
    const due = this.jobs.filter((j) => j.status === 'PENDING').slice(0, limit);
    return Promise.resolve(
      due.map((j) => {
        j.status = 'PROCESSING';
        j.attempt++;
        j.token = `${workerId}:${++this.seq}`;
        return { id: j.id, notificationId: `n${j.id}`, recipientUserId: '7', attempt: j.attempt, expiresAt: j.expiresAt, leaseToken: j.token };
      }),
    );
  }
  renew(jobs: ClaimedJob[]): Promise<Set<string>> {
    this.guard();
    return Promise.resolve(new Set(jobs.filter((x) => this.jobs.find((j) => j.id === x.id && j.token === x.leaseToken)).map((x) => x.id)));
  }
  private fence(job: Pick<ClaimedJob, 'id' | 'leaseToken'>) {
    this.guard();
    const j = this.jobs.find((x) => x.id === job.id && x.token === job.leaseToken && x.status === 'PROCESSING');
    if (j) j.token = null;
    return j;
  }
  complete(job: ClaimedJob, category: string | null, code: string | null) {
    const j = this.fence(job);
    if (j) Object.assign(j, { status: 'DONE', category, code });
    return Promise.resolve(Boolean(j));
  }
  fail(job: ClaimedJob, category: string, code: string) {
    const j = this.fence(job);
    if (j) Object.assign(j, { status: 'FAILED', category, code });
    return Promise.resolve(Boolean(j));
  }
  expire(job: ClaimedJob) {
    const j = this.fence(job);
    if (j) j.status = 'EXPIRED';
    return Promise.resolve(Boolean(j));
  }
  scheduleRetry(job: ClaimedJob, delayMs: number, category: string, code: string) {
    const j = this.fence(job);
    if (!j) return Promise.resolve(null);
    const status = Date.now() + delayMs >= j.expiresAt.getTime() ? 'EXPIRED' : 'PENDING';
    Object.assign(j, { status, delayMs, category, code });
    return Promise.resolve(status as 'PENDING' | 'EXPIRED');
  }
  expireOverdue() {
    this.calls.push('expireOverdue');
    this.guard();
    return Promise.resolve(0);
  }
  /** Simulates another worker reclaiming after lease expiry. */
  steal(id: string) {
    const j = this.jobs.find((x) => x.id === id)!;
    j.token = `other:${++this.seq}`;
  }
}

class FakeExecutor implements DeliveryJobExecutor {
  calls: DeliveryJobContext[] = [];
  constructor(private readonly impl: (ctx: DeliveryJobContext) => Promise<JobExecutionOutcome> | JobExecutionOutcome) {}
  execute(ctx: DeliveryJobContext): Promise<JobExecutionOutcome> {
    this.calls.push(ctx);
    return Promise.resolve().then(() => this.impl(ctx));
  }
}

const worker = (store: FakeStore, executor: DeliveryJobExecutor | null, config: Partial<PushWorkerConfig> = {}) =>
  new PushDeliveryWorker(store as unknown as PushJobStore, { ...WORKER, ...config }, executor, { random: MID, workerId: 'test-1-abcdef' });

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  }
});
afterEach(() => jest.restoreAllMocks());

describe('retry policy', () => {
  it('11. exponential backoff from the base, capped', () => {
    expect([1, 2, 3, 4].map((a) => computeRetryDelayMs(a, 'TRANSIENT', null, POLICY, MID))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(computeRetryDelayMs(20, 'TRANSIENT', null, POLICY, MID)).toBe(3_600_000);
  });

  it('11. bounded jitter (+/- 20 %), never above the cap', () => {
    expect(computeRetryDelayMs(1, 'TRANSIENT', null, POLICY, () => 0)).toBe(24_000);
    expect(computeRetryDelayMs(1, 'TRANSIENT', null, POLICY, () => 1)).toBe(36_000);
    expect(computeRetryDelayMs(30, 'TRANSIENT', null, POLICY, () => 1)).toBe(3_600_000);
    for (let i = 0; i < 200; i++) {
      const d = computeRetryDelayMs(2, 'TRANSIENT', null, POLICY);
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(72_000);
    }
  });

  it('12. Retry-After wins when larger (even above the cap); a smaller one does not shorten the backoff', () => {
    expect(computeRetryDelayMs(1, 'TRANSIENT', 90_000, POLICY, MID)).toBe(90_000);
    expect(computeRetryDelayMs(1, 'TRANSIENT', 5_000, POLICY, MID)).toBe(30_000);
    expect(computeRetryDelayMs(1, 'TRANSIENT', 7_200_000, POLICY, MID)).toBe(7_200_000);
  });

  it('13. quota waits at least 60 s; configuration at least 5 min; never below 1 s', () => {
    const fast = { ...POLICY, retryBaseMs: 1_000 };
    expect(computeRetryDelayMs(1, 'RATE_LIMITED', null, fast, MID)).toBe(QUOTA_MIN_RETRY_MS);
    expect(computeRetryDelayMs(1, 'RATE_LIMITED', 120_000, fast, MID)).toBe(120_000);
    expect(computeRetryDelayMs(1, 'CONFIGURATION', null, fast, MID)).toBe(CONFIGURATION_MIN_RETRY_MS);
    expect(computeRetryDelayMs(1, 'TRANSIENT', null, { ...POLICY, retryBaseMs: 1_000 }, () => 0)).toBe(1_000);
  });

  it('maps executor outcomes to transitions (10, 14, 15)', () => {
    expect(decideTransition({ kind: 'DELIVERED', accepted: 2, failedFinal: 1 }, 1, POLICY, MID)).toEqual({ to: 'DONE', category: null, code: null });
    expect(decideTransition({ kind: 'NO_DESTINATIONS' }, 1, POLICY, MID)).toEqual({ to: 'DONE', category: 'NO_DESTINATIONS', code: 'pawflow/no-destinations' });
    expect(decideTransition({ kind: 'RETRY', category: 'TRANSIENT', code: 'messaging/server-unavailable' }, 1, POLICY, MID)).toEqual({ to: 'RETRY', delayMs: 30_000, category: 'TRANSIENT', code: 'messaging/server-unavailable' });
    expect(decideTransition({ kind: 'RETRY', category: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 1_000 }, 1, POLICY, MID)).toMatchObject({ to: 'RETRY', delayMs: 60_000, category: 'RATE_LIMITED' });
    expect(decideTransition({ kind: 'CONFIGURATION', code: 'app/invalid-credential' }, 1, POLICY, MID)).toMatchObject({ to: 'RETRY', delayMs: 300_000, category: 'CONFIGURATION' });
    expect(decideTransition({ kind: 'RETRY', category: 'TRANSIENT', code: 'x/y' }, 4, POLICY, MID)).toEqual({ to: 'FAILED', category: 'TRANSIENT', code: 'x/y' });
    expect(decideTransition({ kind: 'CONFIGURATION', code: 'app/invalid-credential' }, 4, POLICY, MID)).toEqual({ to: 'FAILED', category: 'CONFIGURATION', code: 'app/invalid-credential' });
    expect(decideTransition({ kind: 'TERMINAL', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' }, 1, POLICY, MID)).toEqual({ to: 'FAILED', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' });
    expect(decideTransition({ kind: 'DISABLED' }, 1, POLICY, MID)).toEqual({ to: 'FAILED', category: 'PUSH_DISABLED', code: 'pawflow/push-disabled' });
    expect(decideTransition({ kind: 'BOGUS' } as never, 1, POLICY, MID)).toMatchObject({ to: 'RETRY', code: 'pawflow/invalid-executor-outcome' });
  });

  it('24. codes from executors are sanitized before persisting/logging', () => {
    expect(safeCode('messaging/server-unavailable')).toBe('messaging/server-unavailable');
    expect(safeCode('token fid=cVxq3f8mT0uYhL2s9pQ1zA leaked')).toBe('pawflow/unknown-error');
    expect(safeCode(undefined)).toBe('pawflow/unknown-error');
  });
});

describe('worker configuration', () => {
  const delivery = (v: Record<string, string>) => loadPushDeliveryConfig(cfg(v));

  it('22. disabled by default', () => {
    expect(loadPushWorkerConfig(cfg({}), delivery({})).enabled).toBe(false);
    expect(loadPushWorkerConfig(cfg({ PUSH_DELIVERY_MODE: 'mock' }), delivery({ PUSH_DELIVERY_MODE: 'mock' })).enabled).toBe(false);
  });

  it('rejects unsafe or inconsistent settings', () => {
    expect(() => loadPushWorkerConfig(cfg({ PUSH_WORKER_ENABLED: 'true' }), delivery({}))).toThrow('requires PUSH_DELIVERY_MODE');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_WORKER_ENABLED: 'yes' }), delivery({}))).toThrow('true or false');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_WORKER_LEASE_SECONDS: '20' }), delivery({ PUSH_SEND_TIMEOUT_MS: '10000' }))).toThrow('3 x PUSH_SEND_TIMEOUT_MS');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_WORKER_JOB_TIMEOUT_MS: '5000' }), delivery({ PUSH_SEND_TIMEOUT_MS: '10000' }))).toThrow('at least PUSH_SEND_TIMEOUT_MS');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_RETRY_BASE_MS: '500' }), delivery({}))).toThrow('PUSH_RETRY_BASE_MS');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_RETRY_BASE_MS: '60000', PUSH_RETRY_MAX_MS: '30000' }), delivery({}))).toThrow('PUSH_RETRY_MAX_MS');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_WORKER_BATCH_SIZE: '51' }), delivery({}))).toThrow('PUSH_WORKER_BATCH_SIZE');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_WORKER_POLL_MS: '50' }), delivery({}))).toThrow('PUSH_WORKER_POLL_MS');
    expect(() => loadPushWorkerConfig(cfg({ PUSH_DELIVERY_MAX_ATTEMPTS: '0' }), delivery({}))).toThrow('PUSH_DELIVERY_MAX_ATTEMPTS');
  });
});

describe('PushDeliveryWorker', () => {
  it('22. not enabled -> bootstrap does nothing (no claims, no timer)', async () => {
    const store = new FakeStore();
    store.add('1');
    const w = worker(store, new FakeExecutor(() => ({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 })), { enabled: false });
    w.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.calls).toEqual([]);
    expect(logged.join('\n')).toMatch(/worker disabled/);
  });

  it('enabled without an executor -> refuses to start (no production fake executor exists)', () => {
    const w = worker(new FakeStore(), null);
    expect(() => w.onApplicationBootstrap()).toThrow('no delivery executor is registered');
    return expect(w.runOnce()).rejects.toThrow('no delivery executor');
  });

  it('3. empty queue -> nothing claimed, executor not called', async () => {
    const ex = new FakeExecutor(() => ({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 }));
    await expect(worker(new FakeStore(), ex).runOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(ex.calls).toHaveLength(0);
  });

  it('1 + 2 + 9. claims up to the batch size and completes successful jobs', async () => {
    const store = new FakeStore();
    for (const id of ['1', '2', '3', '4']) store.add(id);
    const ex = new FakeExecutor(() => ({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 }));
    const tick = await worker(store, ex).runOnce();
    expect(tick).toMatchObject({ claimed: 3, outcomes: { DONE: 3 } });
    expect(store.jobs.map((j) => j.status)).toEqual(['DONE', 'DONE', 'DONE', 'PENDING']);
    expect(ex.calls[0]).toEqual(expect.objectContaining({ jobId: '1', notificationId: 'n1', recipientUserId: '7', attempt: 1 }));
    expect(ex.calls[0]).not.toHaveProperty('leaseToken');
  });

  it('10 + 14 + 15. retryable failure reschedules; exhausted attempts and terminal failures fail', async () => {
    const store = new FakeStore();
    store.add('1');
    store.add('2');
    const ex = new FakeExecutor((ctx) => (ctx.jobId === '1' ? { kind: 'RETRY', category: 'TRANSIENT', code: 'messaging/server-unavailable' } : { kind: 'TERMINAL', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' }));
    const w = worker(store, ex, { maxAttempts: 2 });
    await w.runOnce();
    expect(store.jobs[0]).toMatchObject({ status: 'PENDING', delayMs: 30_000, category: 'TRANSIENT' });
    expect(store.jobs[1]).toMatchObject({ status: 'FAILED', category: 'INVALID_PAYLOAD' });
    await w.runOnce();
    expect(store.jobs[0]).toMatchObject({ status: 'FAILED', attempt: 2, category: 'TRANSIENT', code: 'messaging/server-unavailable' });
    expect(ex.calls.filter((c) => c.jobId === '2')).toHaveLength(1); // terminal never retried
  });

  it('16. a claimed job already past its deadline is expired, not executed; a retry beyond the deadline expires', async () => {
    const store = new FakeStore();
    store.add('1', -1);
    store.add('2', 10_000);
    const ex = new FakeExecutor(() => ({ kind: 'RETRY', category: 'TRANSIENT', code: 'x/y' }));
    await worker(store, ex).runOnce();
    expect(store.jobs[0].status).toBe('EXPIRED');
    expect(ex.calls.map((c) => c.jobId)).toEqual(['2']);
    expect(store.jobs[1].status).toBe('EXPIRED'); // 30 s retry > 10 s remaining
  });

  it('8. a stale worker cannot complete: lease taken over during execution -> LOST_LEASE, nothing written', async () => {
    const store = new FakeStore();
    store.add('1');
    const ex = new FakeExecutor(() => {
      store.steal('1');
      return { kind: 'DELIVERED', accepted: 1, failedFinal: 0 };
    });
    const tick = await worker(store, ex).runOnce();
    expect(tick?.outcomes.LOST_LEASE).toBe(1);
    expect(store.jobs[0].status).toBe('PROCESSING');
  });

  it('long-running execution: bounded by jobTimeoutMs, aborted, retried as ambiguous transient', async () => {
    const store = new FakeStore();
    store.add('1');
    let aborted = false;
    const ex = new FakeExecutor(
      (ctx) =>
        new Promise<JobExecutionOutcome>((resolve) => {
          ctx.signal.addEventListener('abort', () => (aborted = true));
          setTimeout(() => resolve({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 }), 5_000).unref();
        }),
    );
    const t = Date.now();
    await worker(store, ex, { jobTimeoutMs: 300 }).runOnce();
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    expect(store.jobs[0]).toMatchObject({ status: 'PENDING', code: 'pawflow/job-timeout' });
  });

  it('executor throwing -> transient ambiguous retry (never DONE)', async () => {
    const store = new FakeStore();
    store.add('1');
    await worker(store, new FakeExecutor(() => Promise.reject(new Error('boom')))).runOnce();
    expect(store.jobs[0]).toMatchObject({ status: 'PENDING', code: 'pawflow/executor-error' });
  });

  it('20. database outage: tick returns null and logs a safe diagnostic; persistence failure leaves the job leased', async () => {
    const store = new FakeStore();
    store.add('1');
    store.down = true;
    const w = worker(store, new FakeExecutor(() => ({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 })));
    await expect(w.runOnce()).resolves.toBeNull();
    store.down = false;
    const ex = new FakeExecutor(() => {
      store.down = true; // the database goes away after the send
      return { kind: 'DELIVERED', accepted: 1, failedFinal: 0 };
    });
    const w2 = worker(store, ex);
    await expect(w2.runOnce()).resolves.toMatchObject({ outcomes: { PERSIST_FAILED: 1 } });
    expect(store.jobs[0].status).toBe('PROCESSING'); // reclaimed after lease expiry (QA)
    expect(logged.join('\n')).toMatch(/tick failed \(QueryFailedError\(ECONNREFUSED\)\)/);
    expect(logged.join('\n')).not.toMatch(/password|secret|127\.0\.0\.1/);
  });

  it('21. graceful shutdown: no new claims after stop; in-flight finishes within the grace period', async () => {
    const store = new FakeStore();
    for (const id of ['1', '2']) store.add(id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ex = new FakeExecutor(async () => {
      await gate;
      return { kind: 'DELIVERED', accepted: 1, failedFinal: 0 };
    });
    const w = worker(store, ex, { batchSize: 1, shutdownGraceMs: 2_000, pollMs: 200 });
    w.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ex.calls).toHaveLength(1);
    const stopping = w.stop();
    release();
    await stopping;
    await new Promise((r) => setTimeout(r, 400));
    expect(store.jobs.map((j) => j.status)).toEqual(['DONE', 'PENDING']);
    expect(store.calls.filter((c) => c === 'claim')).toHaveLength(1);
  });

  it('21. shutdown grace exceeded: in-flight jobs are aborted and their results discarded (lease expiry -> reclaim)', async () => {
    const store = new FakeStore();
    store.add('1');
    const ex = new FakeExecutor(
      (ctx) =>
        new Promise<JobExecutionOutcome>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve({ kind: 'DELIVERED', accepted: 1, failedFinal: 0 }));
        }),
    );
    const w = worker(store, ex, { shutdownGraceMs: 100, jobTimeoutMs: 60_000 });
    w.start();
    await new Promise((r) => setTimeout(r, 50));
    await w.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.jobs[0].status).toBe('PROCESSING');
    expect(logged.join('\n')).toMatch(/aborting them/);
  });

  it('23 + 24. no network activity; logs carry ids, outcome, category and code only', async () => {
    const spies = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request'), jest.spyOn(http2, 'connect'), jest.spyOn(net, 'connect'), jest.spyOn(globalThis, 'fetch')];
    const store = new FakeStore();
    for (const id of ['1', '2']) store.add(id);
    const ex = new FakeExecutor((ctx) => (ctx.jobId === '1' ? { kind: 'DELIVERED', accepted: 1, failedFinal: 0 } : { kind: 'RETRY', category: 'TRANSIENT', code: 'fid cVxq3f8mT0uYhL2s9pQ1zA' }));
    await worker(store, ex).runOnce();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const text = logged.join('\n');
    expect(text).not.toMatch(/cVxq3f8mT0uYhL2s9pQ1zA|test-1-abcdef:\d/);
    expect(text).toMatch(/Push job 1 \(notification n1, attempt 1\): DELIVERED -> DONE/);
    expect(text).toMatch(/Push job 2 \(notification n2, attempt 1\): RETRY \[TRANSIENT pawflow\/unknown-error\] -> PENDING in 30s/);
  });
});
