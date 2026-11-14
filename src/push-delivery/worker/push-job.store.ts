import type { DataSource } from 'typeorm';

import type { DeviceFinalOutcome } from '../entities/notification-push-send.entity';
import type { ClaimedJob, DeviceOutcomeRecord, RecordResult } from './delivery-job.types';

/** Returns the instant every comparison uses: null = the database clock (production default; one authority for all instances). */
export type PushClock = () => Date | null;
export const DATABASE_CLOCK: PushClock = () => null;

interface ClaimRow {
  id: string;
  notification_id: string;
  recipient_user_id: string;
  attempt_count: number;
  expires_at: Date;
  lease_owner: string;
}

/** TypeORM returns [rows, rowCount] for UPDATE/DELETE and rows otherwise. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return (Array.isArray(result) ? result : []) as T[];
}

/**
 * P3-BE06-05: every job-state statement of the worker. Each statement is a
 * single auto-committed SQL statement; no transaction is held while a job
 * executes.
 *
 * Fencing: each claim writes a NEW unique token into `lease_owner`
 * (`<workerId>:<random>`). Every later write for that attempt requires
 * `status = 'PROCESSING' AND lease_owner = <token>`, so a worker whose lease
 * expired and was reclaimed (new token) can never renew, complete, retry,
 * fail or expire the job again. The guard trigger additionally enforces
 * legal transitions and immutability of terminal jobs.
 *
 * Time: `COALESCE($now, now())`. Production passes null (the database
 * clock, so instances with skewed clocks agree); tests inject a clock.
 */
export class PushJobStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: PushClock = DATABASE_CLOCK,
  ) {}

  private now(): Date | null {
    return this.clock();
  }

  /**
   * Atomically claims up to `limit` due jobs: PENDING with next_attempt_at
   * reached, or PROCESSING whose lease expired (crashed / stalled worker).
   * Jobs past their deadline are never claimed. FOR UPDATE SKIP LOCKED: any
   * number of workers can claim concurrently without blocking or
   * double-claiming. attempt_count += 1 per claim.
   */
  async claim(workerId: string, limit: number, leaseSeconds: number): Promise<ClaimedJob[]> {
    const result = await this.dataSource.query(
      `WITH t AS (SELECT COALESCE($1::timestamptz, now()) AS now),
            due AS (
              SELECT d.id FROM notification_deliveries d, t
               WHERE d.expires_at > t.now
                 AND ((d.status = 'PENDING' AND d.next_attempt_at <= t.now)
                   OR (d.status = 'PROCESSING' AND d.lease_expires_at <= t.now))
               ORDER BY d.next_attempt_at, d.id
               LIMIT $3
               FOR UPDATE OF d SKIP LOCKED)
       UPDATE notification_deliveries d
          SET status = 'PROCESSING',
              lease_owner = $2 || ':' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
              lease_expires_at = (SELECT now FROM t) + make_interval(secs => $4),
              attempt_count = d.attempt_count + 1
         FROM due
        WHERE d.id = due.id
       RETURNING d.id::text AS id, d.notification_id::text AS notification_id, d.recipient_user_id::text AS recipient_user_id,
                 d.attempt_count, d.expires_at, d.lease_owner`,
      [this.now(), workerId, limit, leaseSeconds],
    );
    return rowsOf<ClaimRow>(result).map((r) => ({
      id: r.id,
      notificationId: r.notification_id,
      recipientUserId: r.recipient_user_id,
      attempt: r.attempt_count,
      expiresAt: new Date(r.expires_at),
      leaseToken: r.lease_owner,
    }));
  }

  /** Extends the leases this worker still holds; returns the job ids whose lease was renewed. */
  async renew(jobs: Pick<ClaimedJob, 'id' | 'leaseToken'>[], leaseSeconds: number): Promise<Set<string>> {
    if (jobs.length === 0) return new Set();
    const result = await this.dataSource.query(
      `UPDATE notification_deliveries d
          SET lease_expires_at = COALESCE($3::timestamptz, now()) + make_interval(secs => $4)
         FROM unnest($1::bigint[], $2::text[]) AS h(id, token)
        WHERE d.id = h.id AND d.lease_owner = h.token AND d.status = 'PROCESSING'
       RETURNING d.id::text AS id`,
      [jobs.map((j) => j.id), jobs.map((j) => j.leaseToken), this.now(), leaseSeconds],
    );
    return new Set(rowsOf<{ id: string }>(result).map((r) => r.id));
  }

  /** PROCESSING -> DONE (fenced). */
  async complete(job: Pick<ClaimedJob, 'id' | 'leaseToken'>, category: string | null, code: string | null): Promise<boolean> {
    return this.fenced(job, `status = 'DONE', completed_at = COALESCE($3::timestamptz, now()), last_error_category = $4, last_error_code = $5`, [category, code]);
  }

  /** PROCESSING -> FAILED (fenced, terminal). */
  async fail(job: Pick<ClaimedJob, 'id' | 'leaseToken'>, category: string, code: string): Promise<boolean> {
    return this.fenced(job, `status = 'FAILED', completed_at = COALESCE($3::timestamptz, now()), last_error_category = $4, last_error_code = $5`, [category, code]);
  }

  /** PROCESSING -> EXPIRED (fenced, terminal): the deadline passed; nothing more may be sent. */
  async expire(job: Pick<ClaimedJob, 'id' | 'leaseToken'>): Promise<boolean> {
    return this.fenced(job, `status = 'EXPIRED', completed_at = COALESCE($3::timestamptz, now()), last_error_category = 'EXPIRED', last_error_code = 'pawflow/deadline-passed'`, []);
  }

  /**
   * PROCESSING -> PENDING at now + delay (fenced). If that instant is at or
   * after the delivery deadline the job becomes EXPIRED instead (decided in
   * the same statement). Returns the written status, or null if the lease
   * was lost.
   */
  async scheduleRetry(job: Pick<ClaimedJob, 'id' | 'leaseToken'>, delayMs: number, category: string, code: string): Promise<'PENDING' | 'EXPIRED' | null> {
    const result = await this.dataSource.query(
      `WITH t AS (SELECT COALESCE($3::timestamptz, now()) AS now)
       UPDATE notification_deliveries d
          SET status = CASE WHEN t.now + make_interval(secs => $4::double precision / 1000) >= d.expires_at THEN 'EXPIRED' ELSE 'PENDING' END,
              next_attempt_at = CASE WHEN t.now + make_interval(secs => $4::double precision / 1000) >= d.expires_at THEN d.next_attempt_at
                                     ELSE t.now + make_interval(secs => $4::double precision / 1000) END,
              completed_at = CASE WHEN t.now + make_interval(secs => $4::double precision / 1000) >= d.expires_at THEN t.now ELSE NULL END,
              lease_owner = NULL, lease_expires_at = NULL,
              last_error_category = $5, last_error_code = $6
         FROM t
        WHERE d.id = $1 AND d.lease_owner = $2 AND d.status = 'PROCESSING'
       RETURNING d.status`,
      [job.id, job.leaseToken, this.now(), delayMs, category, code],
    );
    const [row] = rowsOf<{ status: 'PENDING' | 'EXPIRED' }>(result);
    return row?.status ?? null;
  }

  /**
   * Expires overdue jobs that no live worker holds: PENDING past the
   * deadline, and PROCESSING past the deadline whose lease also expired
   * (a crashed worker). SKIP LOCKED, bounded.
   */
  async expireOverdue(limit = 500): Promise<number> {
    const result = await this.dataSource.query(
      `WITH t AS (SELECT COALESCE($1::timestamptz, now()) AS now),
            overdue AS (
              SELECT d.id FROM notification_deliveries d, t
               WHERE d.expires_at <= t.now
                 AND (d.status = 'PENDING' OR (d.status = 'PROCESSING' AND d.lease_expires_at <= t.now))
               ORDER BY d.expires_at, d.id
               LIMIT $2
               FOR UPDATE OF d SKIP LOCKED)
       UPDATE notification_deliveries d
          SET status = 'EXPIRED', lease_owner = NULL, lease_expires_at = NULL,
              completed_at = (SELECT now FROM t), last_error_category = 'EXPIRED', last_error_code = 'pawflow/deadline-passed'
         FROM overdue
        WHERE d.id = overdue.id
       RETURNING d.id`,
      [this.now(), limit],
    );
    return rowsOf(result).length;
  }

  /** BE06-06: final per-device outcomes already persisted for a job (read-only, any attempt). */
  async finalizedDevices(jobId: string): Promise<Map<string, DeviceFinalOutcome>> {
    const rows = (await this.dataSource.query(
      `SELECT push_device_id::text AS device, outcome FROM notification_push_sends WHERE delivery_id = $1`,
      [jobId],
    )) as { device: string; outcome: DeviceFinalOutcome }[];
    return new Map(rows.map((r) => [r.device, r.outcome]));
  }

  /**
   * BE06-06: fenced, idempotent insert of one final per-device outcome. The
   * job row is locked FOR SHARE in the same statement and must still be
   * PROCESSING under this claim's token, so a worker whose lease was taken
   * over writes nothing (LEASE_LOST). An existing row for (job, device) is
   * kept as is (ALREADY_FINAL). The recipient comes from the job; the
   * composite FK rejects a device of another user.
   */
  async recordDeviceOutcome(job: Pick<ClaimedJob, 'id' | 'leaseToken' | 'attempt'>, record: DeviceOutcomeRecord): Promise<RecordResult> {
    const result = await this.dataSource.query(
      `WITH j AS (
         SELECT id, recipient_user_id FROM notification_deliveries
          WHERE id = $1 AND lease_owner = $2 AND status = 'PROCESSING'
          FOR SHARE),
       ins AS (
         INSERT INTO notification_push_sends (delivery_id, recipient_user_id, push_device_id, outcome, provider_code, attempt, attempted_at)
         SELECT j.id, j.recipient_user_id, $3, $4, $5, $6, $7 FROM j
         ON CONFLICT (delivery_id, push_device_id) DO NOTHING
         RETURNING id)
       SELECT (SELECT count(*) FROM j)::int AS owned, (SELECT count(*) FROM ins)::int AS inserted`,
      [job.id, job.leaseToken, record.pushDeviceId, record.outcome, record.providerCode, job.attempt, record.attemptedAt],
    );
    const [row] = rowsOf<{ owned: number; inserted: number }>(result);
    if (!row || row.owned === 0) return 'LEASE_LOST';
    return row.inserted === 1 ? 'RECORDED' : 'ALREADY_FINAL';
  }

  private async fenced(job: Pick<ClaimedJob, 'id' | 'leaseToken'>, set: string, extra: unknown[]): Promise<boolean> {
    const result = await this.dataSource.query(
      `UPDATE notification_deliveries
          SET ${set}, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_owner = $2 AND status = 'PROCESSING'
       RETURNING id`,
      [job.id, job.leaseToken, this.now(), ...extra],
    );
    return rowsOf(result).length === 1;
  }
}
