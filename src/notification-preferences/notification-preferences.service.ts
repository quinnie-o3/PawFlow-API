import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { loadPushDeliveryConfig } from '../push-delivery/push-delivery.config';
import { loadPushWorkerConfig } from '../push-delivery/worker/push-worker.config';

/** Stored preference of one user (defaults when no row exists). */
export interface NotificationPreferenceState {
  pushEnabled: boolean;
  /** Start of the current continuous opt-in period; null while opted out. */
  pushEnabledAt: Date | null;
  /** Last actual state change; null if the user never changed it. */
  updatedAt: Date | null;
}

/**
 * BE07-03 contract: what the push dispatcher needs to decide consent.
 * A notification may be pushed only if `optedIn` and
 * `notification.created_at >= optedInSince` (both PostgreSQL `now()` values).
 */
export interface PushConsent {
  optedIn: boolean;
  optedInSince: Date | null;
}

/** BE07-03 per-notification consent, computed in PostgreSQL (microsecond precision). */
export interface NotificationPushConsent {
  optedIn: boolean;
  /** optedIn AND notification.created_at >= push_enabled_at (inclusive). */
  inCurrentEpoch: boolean;
}

interface Row {
  push_enabled: boolean;
  push_enabled_at: Date | null;
  updated_at: Date;
}

const OFF: NotificationPreferenceState = { pushEnabled: false, pushEnabledAt: null, updatedAt: null };

function rowsOf<T>(result: unknown): T[] {
  // TypeORM returns [rows, rowCount] for UPDATE and rows for INSERT/SELECT.
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return (Array.isArray(result) ? result : []) as T[];
}

/**
 * P3-BE07 user-level push preference.
 *
 * Policy (approved): one global switch per user; OFF by default (missing row
 * = OFF, no backfill); opting in needs no device; opting out keeps devices
 * and the inbox; re-enabling never re-sends older notifications; the
 * preference belongs to the account.
 *
 * Writes are single atomic statements serialized by the row (PK) lock:
 * - enable:  INSERT ... ON CONFLICT DO UPDATE ... WHERE NOT push_enabled
 *            -> sets push_enabled_at = now() only on OFF -> ON; a repeated
 *               enable writes nothing (timestamp and updated_at preserved).
 * - disable: UPDATE ... WHERE push_enabled -> clears push_enabled_at only
 *            on ON -> OFF; disabling an OFF or missing row writes nothing.
 * Concurrent requests are applied in database lock order: last committed
 * write wins; no duplicate rows; the CHECK always holds.
 *
 * Timestamps are PostgreSQL `now()` (transaction start of the statement),
 * the same clock as `notifications.created_at`, never the app clock.
 */
@Injectable()
export class NotificationPreferencesService {
  private readonly logger = new Logger(NotificationPreferencesService.name);
  /** Real push is offered only with the Firebase provider AND a delivery worker on this instance (mock is not real push). */
  readonly pushAvailable: boolean;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    const delivery = loadPushDeliveryConfig(configService);
    const worker = loadPushWorkerConfig(configService, delivery);
    this.pushAvailable = delivery.mode === 'firebase' && worker.enabled;
  }

  /** Read-only; never creates a row. */
  async getForUser(userId: string): Promise<NotificationPreferenceState> {
    const [row] = (await this.dataSource.query(
      `SELECT push_enabled, push_enabled_at, updated_at FROM notification_preferences WHERE user_id = $1`,
      [userId],
    )) as Row[];
    return row ? { pushEnabled: row.push_enabled, pushEnabledAt: row.push_enabled_at, updatedAt: row.updated_at } : { ...OFF };
  }

  /** Idempotent, atomic; returns the state after the request (latest committed). */
  async updateForUser(userId: string, pushEnabled: boolean): Promise<NotificationPreferenceState> {
    let changed: boolean;
    if (pushEnabled) {
      const result = await this.dataSource.query(
        `INSERT INTO notification_preferences AS p (user_id, push_enabled, push_enabled_at, updated_at)
         VALUES ($1, true, now(), now())
         ON CONFLICT (user_id) DO UPDATE
            SET push_enabled = true, push_enabled_at = now(), updated_at = now()
          WHERE NOT p.push_enabled
         RETURNING p.user_id`,
        [userId],
      );
      changed = rowsOf(result).length === 1;
    } else {
      const result = await this.dataSource.query(
        `UPDATE notification_preferences
            SET push_enabled = false, push_enabled_at = NULL, updated_at = now()
          WHERE user_id = $1 AND push_enabled
         RETURNING user_id`,
        [userId],
      );
      changed = rowsOf(result).length === 1;
    }
    if (changed) this.logger.log(`Push preference of user ${userId} -> ${pushEnabled ? 'ON' : 'OFF'}`);
    return this.getForUser(userId);
  }

  /**
   * Consent state (fresh read; no cache). NOTE: JavaScript Dates have
   * millisecond precision while PostgreSQL keeps microseconds, so do NOT
   * compare `optedInSince` with a notification time in JavaScript; use
   * getPushConsentForNotification, which compares inside PostgreSQL.
   */
  async getPushConsentForDelivery(userId: string): Promise<PushConsent> {
    const state = await this.getForUser(userId);
    return { optedIn: state.pushEnabled, optedInSince: state.pushEnabledAt };
  }

  /**
   * BE07-03 dispatcher gate (fresh read; no cache): is this notification
   * inside the recipient's CURRENT consent period? Evaluated in PostgreSQL
   * at full microsecond precision:
   *   optedIn       = push_enabled (missing row = false)
   *   inCurrentEpoch = push_enabled AND notification.created_at >= push_enabled_at
   * Returns null when the notification does not exist for that recipient.
   * Throws on any database error: callers must treat that as "consent
   * unknown" and never as permission (fail closed).
   */
  async getPushConsentForNotification(userId: string, notificationId: string): Promise<NotificationPushConsent | null> {
    const [row] = (await this.dataSource.query(
      `SELECT COALESCE(p.push_enabled, false) AS opted_in,
              COALESCE(p.push_enabled AND n.created_at >= p.push_enabled_at, false) AS in_epoch
         FROM notifications n
         LEFT JOIN notification_preferences p ON p.user_id = n.recipient_user_id
        WHERE n.id = $1 AND n.recipient_user_id = $2`,
      [notificationId, userId],
    )) as { opted_in: boolean; in_epoch: boolean }[];
    return row ? { optedIn: row.opted_in, inCurrentEpoch: row.in_epoch } : null;
  }
}
