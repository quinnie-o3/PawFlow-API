/**
 * P3-BE06 transactional outbox: `notification_deliveries`.
 *
 * One delivery job per inbox notification (= one recipient), inserted in the
 * same transaction as the notification. A job never stores a device, a
 * registration value, a credential or notification content: the future
 * worker re-reads the notification and resolves destinations at send time
 * (P3-BE05 findSendTargets). Per-device outcomes are a separate table
 * (BE06-05).
 *
 * Invariants (database):
 * - uq_notification_deliveries_notification: at most one job per notification.
 * - fk_notification_deliveries_notification: (notification_id, recipient_user_id)
 *   must be an existing notification of that recipient; deleting the
 *   notification (or its recipient) deletes the job.
 * - status PENDING | PROCESSING (claimed, leased) | DONE | FAILED | EXPIRED;
 *   lease columns set iff PROCESSING; completed_at set iff terminal.
 * - trg_notification_deliveries_guard: inserts start PENDING with 0 attempts;
 *   only legal transitions; terminal rows are immutable; identity columns,
 *   created_at and expires_at never change; attempt_count never decreases.
 * The migration is the source of truth (partial indexes, trigger).
 */
import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { Notification } from '../../notifications/entities/notification.entity';

export const DELIVERY_STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'FAILED', 'EXPIRED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

@Entity({ name: 'notification_deliveries' })
@Unique('uq_notification_deliveries_notification', ['notificationId'])
// P3-BE06-06: target of fk_notification_push_sends_delivery (per-device rows pinned to the job's recipient).
@Unique('uq_notification_deliveries_id_recipient', ['id', 'recipientUserId'])
@Check('chk_notification_deliveries_status', `"status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'EXPIRED')`)
@Check('chk_notification_deliveries_lease', `("status" = 'PROCESSING') = ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)`)
@Check('chk_notification_deliveries_completed', `("status" IN ('DONE', 'FAILED', 'EXPIRED')) = ("completed_at" IS NOT NULL)`)
@Check('chk_notification_deliveries_attempts', `"attempt_count" BETWEEN 0 AND 1000`)
@Check('chk_notification_deliveries_expiry', `"expires_at" > "created_at"`)
@Check('chk_notification_deliveries_lease_owner', `"lease_owner" IS NULL OR "lease_owner" ~ '^[A-Za-z0-9:._-]{1,64}$'`)
@Check('chk_notification_deliveries_error_category', `"last_error_category" IS NULL OR "last_error_category" ~ '^[A-Z][A-Z_]{0,31}$'`)
@Check('chk_notification_deliveries_error_code', `"last_error_code" IS NULL OR "last_error_code" ~ '^[A-Za-z0-9/._:-]{1,100}$'`)
@Index('idx_notification_deliveries_due', { synchronize: false })
@Index('idx_notification_deliveries_lease', { synchronize: false })
@Index('idx_notification_deliveries_finished', { synchronize: false })
export class NotificationDelivery {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'notification_id', type: 'bigint' })
  notificationId!: string;

  @Column({ name: 'recipient_user_id', type: 'bigint' })
  recipientUserId!: string;

  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status!: DeliveryStatus;

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'NOW()' })
  nextAttemptAt!: Date;

  /** Delivery deadline: never sent after this instant (-> EXPIRED). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'lease_owner', type: 'varchar', length: 64, nullable: true })
  leaseOwner!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  /** Coarse category (e.g. UNAVAILABLE, QUOTA); never a message or identifier. */
  @Column({ name: 'last_error_category', type: 'varchar', length: 32, nullable: true })
  lastErrorCategory!: string | null;

  /** Provider error code token (e.g. messaging/server-unavailable); pattern-restricted. */
  @Column({ name: 'last_error_code', type: 'varchar', length: 100, nullable: true })
  lastErrorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'notification_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_notification_deliveries_notification' },
    { name: 'recipient_user_id', referencedColumnName: 'recipientUserId' },
  ])
  notification!: Notification;
}
