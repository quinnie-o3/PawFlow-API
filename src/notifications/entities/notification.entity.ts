/**
 * Notification Entity (P3-BE04)
 *
 * Maps `notifications`: one row per (recipient, event). Content is a
 * snapshot taken at creation (title/body/payload), so it stays readable
 * when the underlying business record changes or is deleted; the target
 * is a plain (type, id) pair with no foreign key for the same reason.
 *
 * Immutable except `read_at`, which can only go from NULL to a timestamp
 * (enforced by trigger `trg_notifications_guard_update`). The recipient
 * cannot change after creation. Deleting the user deletes its inbox.
 * The migration remains the source of truth (partial/descending indexes,
 * trigger).
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import type { NotificationPayload, NotificationTargetType, NotificationType } from '../notification-types';

@Entity({ name: 'notifications' })
@Unique('uq_notifications_recipient_event', ['recipientUserId', 'eventKey'])
@Check(
  'chk_notifications_type',
  `"type" IN ('BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'BOOKING_COMPLETED', 'BOOKING_NO_SHOW', 'PAYMENT_STATUS_CHANGED', 'REVIEW_RECEIVED', 'COMPLAINT_CREATED', 'COMPLAINT_STATUS_CHANGED', 'PROVIDER_APPROVED', 'PROVIDER_REJECTED', 'PROVIDER_SUSPENDED', 'SYSTEM_ANNOUNCEMENT')`,
)
@Check('chk_notifications_target_type', `"target_type" IS NULL OR "target_type" IN ('BOOKING', 'COMPLAINT', 'REVIEW', 'PROVIDER')`)
@Check('chk_notifications_target_pair', `("target_type" IS NULL) = ("target_id" IS NULL)`)
@Check('chk_notifications_title', `char_length(btrim("title")) BETWEEN 1 AND 150`)
@Check('chk_notifications_body', `char_length(btrim("body")) BETWEEN 1 AND 1000`)
@Check('chk_notifications_payload', `jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 4096`)
@Check('chk_notifications_event_key', `"event_key" IS NULL OR "event_key" ~ '^[A-Za-z0-9:._-]{1,200}$'`)
@Check('chk_notifications_read_after_create', `"read_at" IS NULL OR "read_at" >= "created_at"`)
// (recipient_user_id, id DESC) and the partial unread index: migration only.
@Index('idx_notifications_recipient_id', { synchronize: false })
@Index('idx_notifications_recipient_unread', { synchronize: false })
export class Notification {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'recipient_user_id', type: 'bigint' })
  recipientUserId!: string;

  @Column({ type: 'varchar', length: 40 })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 150 })
  title!: string;

  @Column({ type: 'varchar', length: 1000 })
  body!: string;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  payload!: NotificationPayload;

  @Column({ name: 'target_type', type: 'varchar', length: 20, nullable: true })
  targetType!: NotificationTargetType | null;

  @Column({ name: 'target_id', type: 'bigint', nullable: true })
  targetId!: string | null;

  @Column({ name: 'event_key', type: 'varchar', length: 200, nullable: true })
  eventKey!: string | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'recipient_user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_notifications_recipient',
  })
  recipient!: User;
}
