import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { ClaimedJob, DeliveryJobExecutor, JobExecutionOutcome, JobFinalState } from './delivery-job.types';
import { MAX_POLL_BACKOFF_MS, type PushWorkerConfig } from './push-worker.config';
import type { PushJobStore } from './push-job.store';
import { decideTransition } from './retry-policy';

export interface TickResult {
  expiredOverdue: number;
  claimed: number;
  outcomes: Record<JobFinalState, number>;
}

export interface PushDeliveryWorkerOptions {
  random?: () => number;
  /** Used only for the pre-execution deadline check (persistence uses the store's clock). */
  now?: () => number;
  workerId?: string;
}

const emptyOutcomes = (): Record<JobFinalState, number> => ({ DONE: 0, PENDING: 0, FAILED: 0, EXPIRED: 0, LOST_LEASE: 0, PERSIST_FAILED: 0 });

/** Error diagnostics without messages (they may contain SQL parameters or provider details). */
const errorTag = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const e = error as { name?: unknown; code?: unknown };
  const code = typeof e.code === 'string' && /^[A-Za-z0-9/._:-]{1,60}$/.test(e.code) ? e.code : '';
  return `${typeof e.name === 'string' ? e.name.slice(0, 40) : 'Error'}${code ? `(${code})` : ''}`;
};

/**
 * P3-BE06-05 durable delivery worker (one per application instance; any
 * number of instances may run it concurrently).
 *
 * Tick: expire overdue jobs -> claim <= batchSize due jobs (SKIP LOCKED,
 * fresh lease token each) -> execute them concurrently through the
 * DeliveryJobExecutor (no DB transaction is open meanwhile; leases are
 * renewed every lease/3; each attempt is bounded by jobTimeoutMs) -> persist
 * each result with a lease-fenced update -> schedule the next tick (at once
 * when the batch was full, after pollMs otherwise, with exponential back-off
 * after failed ticks such as a database outage).
 *
 * Disabled unless PUSH_WORKER_ENABLED=true, and it refuses to start without
 * an executor: BE06-05 provides none (BE06-06 adds the real one), so no job
 * can be processed by a running application yet.
 *
 * Delivery is AT LEAST ONCE: a crash or lost lease after the executor sent
 * something but before the result was persisted makes another worker run
 * the job again (BE06-06 must skip destinations whose outcome is already
 * persisted; FCM duplicates collapse on the device via the notification tag).
 */
export class PushDeliveryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('PushDeliveryWorker');
  readonly workerId: string;
  private readonly random: () => number;
  private readonly nowMs: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult | null> | null = null;
  private started = false;
  private stopping = false;
  private consecutiveFailures = 0;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly store: PushJobStore,
    readonly config: PushWorkerConfig,
    private readonly executor: DeliveryJobExecutor | null,
    options: PushDeliveryWorkerOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.nowMs = options.now ?? Date.now;
    const host = hostname().replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'host';
    this.workerId = options.workerId ?? `${host}-${process.pid}-${randomBytes(3).toString('hex')}`;
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(this.workerId)) throw new Error('worker id must match [A-Za-z0-9._-]{1,40}');
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Push delivery worker disabled (PUSH_WORKER_ENABLED is not true); no jobs are processed by this instance');
      return;
    }
    this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Starts the polling loop. Requires an executor. */
  start(): void {
    if (!this.executor) {
      throw new Error('PUSH_WORKER_ENABLED=true but no delivery executor is registered (provided by P3-BE06-06); refusing to start');
    }
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.logger.log(`Push delivery worker ${this.workerId} started (batch ${this.config.batchSize}, lease ${this.config.leaseSeconds}s, max attempts ${this.config.maxAttempts})`);
    this.schedule(0);
  }

  /**
   * Graceful stop: no new claims; waits up to shutdownGraceMs for in-flight
   * jobs, then aborts them (their leases expire and another worker
   * reclaims them).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const current = this.running;
    if (current) {
      let graceTimer: NodeJS.Timeout | undefined;
      const graceful = await Promise.race([
        current.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), this.config.shutdownGraceMs);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!graceful) {
        this.logger.warn(`Push worker stopping with ${this.inFlight.size} job(s) still running; aborting them (leases expire and are reclaimed)`);
        for (const controller of this.inFlight.values()) controller.abort(new Error('worker shutdown'));
      }
    }
    if (this.started) this.logger.log(`Push delivery worker ${this.workerId} stopped`);
    this.started = false;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runOnce().finally(() => (this.running = null));
      void this.running.then((tick) => {
        if (this.stopping) return;
        if (tick === null) {
          const backoff = Math.min(MAX_POLL_BACKOFF_MS, this.config.pollMs * 2 ** Math.min(this.consecutiveFailures, 10));
          this.schedule(backoff);
        } else {
          this.schedule(tick.claimed >= this.config.batchSize ? 0 : this.config.pollMs);
        }
      });
    }, delayMs);
    this.timer.unref();
  }

  /**
   * One tick (also callable directly by tests / tools). Never throws: a
   * failed tick (e.g. database unavailable) is logged and returns null.
   */
  async runOnce(): Promise<TickResult | null> {
    if (!this.executor) throw new Error('no delivery executor is registered');
    if (this.stopping && this.started) return { expiredOverdue: 0, claimed: 0, outcomes: emptyOutcomes() };
    let expiredOverdue = 0;
    let jobs: ClaimedJob[];
    try {
      expiredOverdue = await this.store.expireOverdue();
      jobs = await this.store.claim(this.workerId, this.config.batchSize, this.config.leaseSeconds);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      this.logger.error(`Push worker tick failed (${errorTag(error)}); retrying with back-off (failure #${this.consecutiveFailures})`);
      return null;
    }

    const outcomes = emptyOutcomes();
    if (jobs.length === 0) return { expiredOverdue, claimed: 0, outcomes };

    const controllers = new Map(jobs.map((job) => [job.id, new AbortController()]));
    for (const [id, c] of controllers) this.inFlight.set(id, c);
    const active = new Map(jobs.map((job) => [job.id, job]));
    const heartbeat = setInterval(() => void this.heartbeat(active, controllers), Math.max(1_000, Math.floor((this.config.leaseSeconds * 1000) / 3)));
    heartbeat.unref();
    try {
      const states = await Promise.all(
        jobs.map((job) =>
          this.processJob(job, controllers.get(job.id)!).finally(() => {
            active.delete(job.id);
            this.inFlight.delete(job.id);
          }),
        ),
      );
      for (const state of states) outcomes[state]++;
    } finally {
      clearInterval(heartbeat);
    }
    return { expiredOverdue, claimed: jobs.length, outcomes };
  }

  private async heartbeat(active: Map<string, ClaimedJob>, controllers: Map<string, AbortController>): Promise<void> {
    const jobs = [...active.values()];
    if (jobs.length === 0) return;
    try {
      const renewed = await this.store.renew(jobs, this.config.leaseSeconds);
      for (const job of jobs) {
        if (!renewed.has(job.id) && active.has(job.id)) {
          this.logger.warn(`Push job ${job.id}: lease lost while running; aborting the attempt`);
          controllers.get(job.id)?.abort(new Error('lease lost'));
        }
      }
    } catch (error) {
      // Leases stay valid until they expire; the next heartbeat retries.
      this.logger.warn(`Push worker lease renewal failed (${errorTag(error)})`);
    }
  }

  private async processJob(job: ClaimedJob, controller: AbortController): Promise<JobFinalState> {
    const label = `Push job ${job.id} (notification ${job.notificationId}, attempt ${job.attempt})`;
    try {
      if (job.expiresAt.getTime() <= this.nowMs()) {
        const ok = await this.store.expire(job);
        this.logger.warn(`${label}: deadline passed before sending -> ${ok ? 'EXPIRED' : 'LOST_LEASE'}`);
        return ok ? 'EXPIRED' : 'LOST_LEASE';
      }

      const outcome = await this.execute(job, controller);
      if (controller.signal.aborted && this.isLeaseLoss(controller)) {
        this.logger.warn(`${label}: lease lost during execution; result discarded (another worker owns the job)`);
        return 'LOST_LEASE';
      }

      const transition = decideTransition(outcome, job.attempt, this.config, this.random);
      let state: JobFinalState;
      if (transition.to === 'DONE') state = (await this.store.complete(job, transition.category, transition.code)) ? 'DONE' : 'LOST_LEASE';
      else if (transition.to === 'FAILED') state = (await this.store.fail(job, transition.category, transition.code)) ? 'FAILED' : 'LOST_LEASE';
      else state = (await this.store.scheduleRetry(job, transition.delayMs, transition.category, transition.code)) ?? 'LOST_LEASE';

      const detail = transition.to === 'DONE' ? (transition.category ?? '') : `${transition.category} ${transition.code}`;
      const retry = transition.to === 'RETRY' && state === 'PENDING' ? ` in ${Math.round(transition.delayMs / 1000)}s` : '';
      const line = `${label}: ${outcome.kind}${detail ? ` [${detail}]` : ''} -> ${state}${retry}`;
      if (state === 'DONE' || state === 'PENDING') this.logger.log(line);
      else this.logger.warn(line);
      return state;
    } catch (error) {
      // Persisting failed (e.g. database down): the job stays PROCESSING until
      // its lease expires and is then reclaimed (the attempt may be repeated).
      this.logger.error(`${label}: result could not be persisted (${errorTag(error)}); the lease will expire and the job will be retried`);
      return 'PERSIST_FAILED';
    }
  }

  private isLeaseLoss(controller: AbortController): boolean {
    const reason: unknown = controller.signal.reason;
    return reason instanceof Error && (reason.message === 'lease lost' || reason.message === 'worker shutdown');
  }

  /** Runs the executor bounded by jobTimeoutMs; executor errors and timeouts are ambiguous transient failures. */
  private async execute(job: ClaimedJob, controller: AbortController): Promise<JobExecutionOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const leaseLost = () => {
        if (!controller.signal.aborted) controller.abort(new Error('lease lost'));
      };
      const running = Promise.resolve().then(() =>
        this.executor!.execute({
          jobId: job.id,
          notificationId: job.notificationId,
          recipientUserId: job.recipientUserId,
          attempt: job.attempt,
          expiresAt: job.expiresAt,
          signal: controller.signal,
          // Capabilities bound to THIS claim (fenced on its lease token, which the executor never sees).
          renewLease: async () => {
            if (controller.signal.aborted) return false;
            const ok = (await this.store.renew([job], this.config.leaseSeconds)).has(job.id);
            if (!ok) leaseLost();
            return ok;
          },
          finalizedDevices: () => this.store.finalizedDevices(job.id),
          recordDeviceOutcome: async (record) => {
            const result = await this.store.recordDeviceOutcome(job, record);
            if (result === 'LEASE_LOST') leaseLost();
            return result;
          },
        }),
      );
      running.catch(() => undefined);
      const timeout = new Promise<JobExecutionOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error('job timeout'));
          resolve({ kind: 'RETRY', category: 'TRANSIENT', code: 'pawflow/job-timeout', ambiguous: true });
        }, this.config.jobTimeoutMs);
      });
      return await Promise.race([running, timeout]);
    } catch (error) {
      this.logger.warn(`Push job ${job.id}: executor error (${errorTag(error)}); treated as a transient, possibly ambiguous failure`);
      return { kind: 'RETRY', category: 'TRANSIENT', code: 'pawflow/executor-error', ambiguous: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
