/**
 * P3-BE06-06: final outcome of one delivery job for one push device
 * (`notification_push_sends`, insert-only; migration 1796500000000).
 *
 * - UNIQUE (delivery_id, push_device_id): one final outcome per job and
 *   registration generation. A push_devices row never changes its
 *   registration (P3-BE05 guard trigger) and rotation / transfer always
 *   insert a NEW row, so the device id identifies the registration exactly.
 * - Composite FKs pin both the job (delivery_id, recipient_user_id) and the
 *   device (push_device_id, recipient_user_id) to the same recipient.
 * - Holds no FID / token value, no message content, no provider message id.
 * - Written only by the lease holder of the job (fenced insert in PushJobStore).
 */
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { PushDevice } from '../../push-devices/entities/push-device.entity';
import { NotificationDelivery } from './notification-delivery.entity';

export const DEVICE_FINAL_OUTCOMES = ['ACCEPTED', 'INVALID_DESTINATION', 'INVALID_REQUEST'] as const;
export type DeviceFinalOutcome = (typeof DEVICE_FINAL_OUTCOMES)[number];

@Entity({ name: 'notification_push_sends' })
@Unique('uq_notification_push_sends_delivery_device', ['deliveryId', 'pushDeviceId'])
@Check('chk_notification_push_sends_outcome', `"outcome" IN ('ACCEPTED', 'INVALID_DESTINATION', 'INVALID_REQUEST')`)
@Check('chk_notification_push_sends_code', `"provider_code" IS NULL OR "provider_code" ~ '^[A-Za-z0-9/._:-]{1,100}$'`)
@Check('chk_notification_push_sends_code_outcome', `("outcome" = 'ACCEPTED') = ("provider_code" IS NULL)`)
@Check('chk_notification_push_sends_attempt', `"attempt" BETWEEN 1 AND 1000`)
@Index('idx_notification_push_sends_device', ['pushDeviceId'])
export class NotificationPushSend {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'delivery_id', type: 'bigint' })
  deliveryId!: string;

  @Column({ name: 'recipient_user_id', type: 'bigint' })
  recipientUserId!: string;

  @Column({ name: 'push_device_id', type: 'bigint' })
  pushDeviceId!: string;

  @Column({ type: 'varchar', length: 24 })
  outcome!: DeviceFinalOutcome;

  /** Sanitized provider code for failures (null for ACCEPTED). */
  @Column({ name: 'provider_code', type: 'varchar', length: 100, nullable: true })
  providerCode!: string | null;

  @Column({ type: 'integer' })
  attempt!: number;

  /** When the send was started (used for markInvalid's re-registration guard). */
  @Column({ name: 'attempted_at', type: 'timestamptz' })
  attemptedAt!: Date;

  @Column({ name: 'finalized_at', type: 'timestamptz', default: () => 'NOW()' })
  finalizedAt!: Date;

  @ManyToOne(() => NotificationDelivery, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'delivery_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_notification_push_sends_delivery' },
    { name: 'recipient_user_id', referencedColumnName: 'recipientUserId' },
  ])
  delivery!: NotificationDelivery;

  @ManyToOne(() => PushDevice, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'push_device_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_notification_push_sends_device' },
    { name: 'recipient_user_id', referencedColumnName: 'userId' },
  ])
  device!: PushDevice;
}
