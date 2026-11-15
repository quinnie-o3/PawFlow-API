import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';

import { loadPushDeliveryConfig, type PushDeliveryConfig } from './push-delivery.config';

const BIGINT_ID = /^[1-9]\d{0,18}$/;
export const MAX_ENQUEUE_BATCH = 500;

export interface EnqueueResult {
  /** Jobs created by this call. */
  enqueued: string[];
  /** Notifications that already had a job (repeated / concurrent enqueue). */
  alreadyQueued: string[];
  /** Set when nothing was written because push is disabled by configuration. */
  skipped: 'PUSH_DISABLED' | null;
}

/** A programming error in the caller (wrong usage or input); never caused by an end user. */
export class OutboxUsageError extends Error {
  constructor(message: string) {
    super(`Push outbox: ${message}`);
    this.name = 'OutboxUsageError';
  }
}

/** One or more notification ids do not exist (or are not visible in the caller's transaction). Nothing was written. */
export class OutboxNotificationNotFoundError extends Error {
  constructor(readonly missingIds: string[]) {
    super(`Push outbox: notification(s) not found: ${missingIds.join(', ')}`);
    this.name = 'OutboxNotificationNotFoundError';
  }
}

/**
 * P3-BE06-02 transactional outbox writer (internal; no HTTP endpoint).
 *
 * `enqueue(manager, notificationIds)` records push-delivery intent for
 * existing inbox notifications INSIDE the caller's transaction: the jobs
 * commit or roll back with the business change and the notifications.
 *
 * - Deterministic deduplication: one job per notification
 *   (uq_notification_deliveries_notification + ON CONFLICT DO NOTHING), so
 *   repeated and concurrent calls are idempotent. A concurrent transaction
 *   enqueuing the same notification waits for the first one; if that one
 *   rolls back, the waiter creates the job. Rows are inserted in ascending
 *   notification id order, so concurrent overlapping batches cannot
 *   deadlock on the unique index.
 * - All or nothing: if any id is missing, nothing is written and
 *   OutboxNotificationNotFoundError is thrown (the caller's transaction
 *   should abort).
 * - The recipient is taken from the notification itself (the composite FK
 *   makes any other value impossible).
 * - PUSH_DELIVERY_MODE=disabled: no-op (`skipped: 'PUSH_DISABLED'`). No work
 *   accumulates, so enabling push later never sends old messages.
 * - Every job carries a delivery deadline (expires_at = now + TTL); the
 *   worker (later subtask) must expire, not send, a job past its deadline.
 */
@Injectable()
export class PushOutboxService {
  private readonly logger = new Logger(PushOutboxService.name);
  readonly config: PushDeliveryConfig;

  constructor(configService: ConfigService) {
    this.config = loadPushDeliveryConfig(configService);
    if (this.config.mode === 'disabled') {
      this.logger.warn(`PUSH_DELIVERY_MODE=${this.config.modeExplicit ? 'disabled' : '(not set) -> disabled'}: inbox only, no push delivery jobs are recorded`);
    } else {
      this.logger.log(`Push outbox enabled (mode=${this.config.mode}, delivery TTL ${this.config.ttlSeconds}s)`);
    }
  }

  get enabled(): boolean {
    return this.config.mode !== 'disabled';
  }

  async enqueue(manager: EntityManager, notificationIds: readonly string[]): Promise<EnqueueResult> {
    if (!manager?.queryRunner?.isTransactionActive) {
      throw new OutboxUsageError("enqueue must run inside the caller's transaction (pass the transaction's EntityManager)");
    }
    if (!Array.isArray(notificationIds)) throw new OutboxUsageError('notificationIds must be an array');
    const ids = [...new Set(notificationIds)];
    if (ids.length > MAX_ENQUEUE_BATCH) throw new OutboxUsageError(`at most ${MAX_ENQUEUE_BATCH} notifications per call`);
    if (ids.some((id) => typeof id !== 'string' || !BIGINT_ID.test(id))) {
      throw new OutboxUsageError('notification ids must be positive integer strings');
    }

    if (!this.enabled) return { enqueued: [], alreadyQueued: [], skipped: 'PUSH_DISABLED' };
    if (ids.length === 0) return { enqueued: [], alreadyQueued: [], skipped: null };

    // One statement: verify every notification exists (in the caller's
    // snapshot) and insert only if all do. The recipient comes from the
    // notification row.
    const [row] = (await manager.query(
      `WITH req AS (SELECT DISTINCT unnest($1::bigint[]) AS id),
            found AS (SELECT n.id, n.recipient_user_id FROM notifications n JOIN req ON req.id = n.id),
            complete AS (SELECT (SELECT count(*) FROM found) = (SELECT count(*) FROM req) AS ok),
            ins AS (
              INSERT INTO notification_deliveries (notification_id, recipient_user_id, expires_at)
              SELECT f.id, f.recipient_user_id, now() + make_interval(secs => $2::int)
                FROM found f, complete c
               WHERE c.ok
               ORDER BY f.id -- fixed order: overlapping concurrent batches wait, never deadlock
              ON CONFLICT (notification_id) DO NOTHING
              RETURNING notification_id)
       SELECT (SELECT ok FROM complete) AS ok,
              COALESCE((SELECT array_agg(r.id::text ORDER BY r.id) FROM req r WHERE r.id NOT IN (SELECT id FROM found)), '{}') AS missing,
              COALESCE((SELECT array_agg(notification_id::text ORDER BY notification_id) FROM ins), '{}') AS inserted`,
      [ids, this.config.ttlSeconds],
    )) as { ok: boolean; missing: string[]; inserted: string[] }[];

    if (!row.ok) throw new OutboxNotificationNotFoundError(row.missing);
    const inserted = new Set(row.inserted);
    return {
      enqueued: ids.filter((id) => inserted.has(id)),
      alreadyQueued: ids.filter((id) => !inserted.has(id)),
      skipped: null,
    };
  }
}
