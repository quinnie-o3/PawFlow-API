import { Logger } from '@nestjs/common';

import { StructuredLogger } from '../../common/observability/structured-logger';
import type { ClaimedJob, DeliveryJobContext, JobExecutionOutcome } from './delivery-job.types';
import { PushDeliveryWorker } from './push-delivery.worker';
import type { PushJobStore } from './push-job.store';
import type { PushWorkerConfig } from './push-worker.config';

const WORKER: PushWorkerConfig = { enabled: true, batchSize: 5, pollMs: 200, leaseSeconds: 30, jobTimeoutMs: 1_000, maxAttempts: 4, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 200 };
const FCM_TOKEN = 'fcm_cVxq3f8mT0uYhL2s9pQ1zA:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338';
const LEASE_PREFIX = 'obs-worker-1';

/** Minimal PushJobStore: every claimed job is due; every lease-fenced write succeeds. */
class MiniStore {
  private seq = 0;
  constructor(private readonly ids: string[]) {}
  claim(workerId: string): Promise<ClaimedJob[]> {
    const jobs = this.ids.splice(0).map((id) => ({ id, notificationId: `9${id}`, recipientUserId: '7', attempt: 1, expiresAt: new Date(Date.now() + 3_600_000), leaseToken: `${workerId}:${++this.seq}` }));
    return Promise.resolve(jobs);
  }
  expireOverdue = () => Promise.resolve(0);
  renew = (jobs: ClaimedJob[]) => Promise.resolve(new Set(jobs.map((j) => j.id)));
  complete = () => Promise.resolve(true);
  fail = () => Promise.resolve(true);
  scheduleRetry = () => Promise.resolve('PENDING' as const);
}

describe('P3-BE09 push worker job observability', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    Logger.overrideLogger(new StructuredLogger({ format: 'json', minLevel: 'debug' }, (line) => lines.push(line)));
  });

  it('runs each job in its own correlation context and emits one structured completion event per job', async () => {
    const executorLogger = new Logger('PushDispatchExecutor');
    const outcomes: Record<string, JobExecutionOutcome> = {
      '11': { kind: 'DELIVERED', accepted: 1, failedFinal: 0 },
      '12': { kind: 'RETRY', category: 'TRANSIENT', code: 'messaging/server-unavailable' },
      '13': { kind: 'TERMINAL', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' },
    };
    const executor = {
      execute: async (ctx: DeliveryJobContext): Promise<JobExecutionOutcome> => {
        // Interleave the three jobs so a shared context would be visible.
        await new Promise((resolve) => setTimeout(resolve, 30 - Number(ctx.jobId)));
        executorLogger.warn(`executor step for job ${ctx.jobId} device token ${FCM_TOKEN}`);
        return outcomes[ctx.jobId];
      },
    };
    const worker = new PushDeliveryWorker(new MiniStore(['11', '12', '13']) as unknown as PushJobStore, WORKER, executor, { random: () => 0.5, workerId: LEASE_PREFIX });

    const tick = await worker.runOnce();
    expect(tick).toMatchObject({ claimed: 3, outcomes: { DONE: 1, PENDING: 1, FAILED: 1 } });

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const id of ['11', '12', '13']) {
      const step = records.find((r) => r.context === 'PushDispatchExecutor' && String(r.message).includes(`job ${id} `));
      expect(step).toMatchObject({ event: 'app.log', jobId: id, attempt: 1 });
      expect(records.filter((r) => r.event === 'push.job.completed' && r.jobId === id)).toHaveLength(1);
    }

    const done = records.find((r) => r.event === 'push.job.completed' && r.jobId === '11');
    expect(done).toMatchObject({ level: 'info', context: 'PushDeliveryWorker', attempt: 1, notificationId: '911', outcome: 'DELIVERED', state: 'DONE' });
    expect(done).not.toHaveProperty('code');
    expect(typeof done?.durationMs).toBe('number');
    expect(done?.message).toBe('Push job 11 (notification 911, attempt 1): DELIVERED -> DONE');

    expect(records.find((r) => r.event === 'push.job.completed' && r.jobId === '12')).toMatchObject({
      level: 'info', outcome: 'RETRY', state: 'PENDING', category: 'TRANSIENT', code: 'messaging/server-unavailable', retryDelayMs: 30_000,
    });
    expect(records.find((r) => r.event === 'push.job.completed' && r.jobId === '13')).toMatchObject({
      level: 'warn', outcome: 'TERMINAL', state: 'FAILED', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large',
    });

    // Worker-level lines (start/stop/tick) carry no job context; no destination token or lease token is logged.
    const text = lines.join('\n');
    expect(text).not.toContain(FCM_TOKEN);
    expect(text).not.toMatch(new RegExp(`${LEASE_PREFIX}:\\d`));
  });
});
