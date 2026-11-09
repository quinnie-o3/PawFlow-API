/**
 * P3-BE06-05 worker <-> executor contract.
 *
 * The worker (claiming, leases, retries, deadlines) is generic; the
 * DeliveryJobExecutor does the actual delivery of ONE job (BE06-06: re-read
 * the notification, select and re-check destinations, call the provider per
 * device, persist per-device outcomes, revoke invalid devices). BE06-05 ships
 * NO production executor: the worker refuses to start without one.
 */

/** A job claimed by this worker (one notification for one recipient). */
export interface ClaimedJob {
  id: string;
  notificationId: string;
  recipientUserId: string;
  /** 1-based number of this attempt (attempt_count after the claim). */
  attempt: number;
  /** Delivery deadline: nothing may be sent after it. */
  expiresAt: Date;
  /** Fencing token of this claim (lease_owner). Internal: never log it. */
  leaseToken: string;
}

/** What the executor receives. No lease token: persistence belongs to the worker. */
export interface DeliveryJobContext {
  jobId: string;
  notificationId: string;
  recipientUserId: string;
  attempt: number;
  expiresAt: Date;
  /** Aborted when the lease is lost, the job times out or the worker shuts down: stop sending. */
  signal: AbortSignal;
}

/**
 * Aggregate result of one job attempt (all destinations of the recipient).
 *
 * - DELIVERED: every eligible destination now has a FINAL per-device outcome
 *   (accepted, invalid destination, invalid request/payload). Some may have
 *   failed finally; nothing is left to retry. -> DONE.
 * - NO_DESTINATIONS: the recipient has no eligible destination. -> DONE.
 * - RETRY: at least one destination still needs another attempt (transient
 *   or quota). Destinations already final must NOT be re-sent next attempt
 *   (BE06-06 persists per-device outcomes). -> PENDING with backoff, or
 *   FAILED / EXPIRED when attempts or the deadline are exhausted.
 * - CONFIGURATION: provider credentials / project / permissions broken.
 *   Retried slowly (>= 5 min) until attempts or the deadline run out.
 * - TERMINAL: the job itself can never succeed (e.g. invalid payload for
 *   every destination, notification missing). -> FAILED.
 * - DISABLED: push disabled by configuration. -> FAILED (never sent later).
 */
export type JobExecutionOutcome =
  | { kind: 'DELIVERED'; accepted: number; failedFinal: number }
  | { kind: 'NO_DESTINATIONS' }
  | { kind: 'RETRY'; category: 'TRANSIENT' | 'RATE_LIMITED'; code: string; retryAfterMs?: number | null; ambiguous?: boolean }
  | { kind: 'CONFIGURATION'; code: string }
  | { kind: 'TERMINAL'; category: 'INVALID_PAYLOAD' | 'INVALID_REQUEST' | 'NOTIFICATION_MISSING'; code: string }
  | { kind: 'DISABLED' };

export interface DeliveryJobExecutor {
  execute(job: DeliveryJobContext): Promise<JobExecutionOutcome>;
}

/** Nest token of the executor. Not provided in BE06-05 (BE06-06 provides the real one). */
export const DELIVERY_JOB_EXECUTOR = Symbol('DELIVERY_JOB_EXECUTOR');

/** Final state written by the worker for one attempt. */
export type JobFinalState = 'DONE' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'LOST_LEASE' | 'PERSIST_FAILED';
