/**
 * P3-BE07 user-level push preference (`notification_preferences`).
 *
 * - One row per user (PK = user_id); a MISSING row means push OFF.
 * - `push_enabled_at` marks the start of the CURRENT continuous opt-in
 *   period (PostgreSQL time of the opt-in statement). It is set when push
 *   goes OFF -> ON, kept while ON, cleared on ON -> OFF.
 *   CHECK: push_enabled  <=>  push_enabled_at IS NOT NULL.
 * - `updated_at` changes only on an actual state change.
 * - Deleting the user deletes the row.
 */
import { Check, Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';

import { User } from '../../users/entities/user.entity';

@Entity({ name: 'notification_preferences' })
@Check('chk_notification_preferences_push_enabled_at', `"push_enabled" = ("push_enabled_at" IS NOT NULL)`)
export class NotificationPreference {
  @PrimaryColumn({ name: 'user_id', type: 'bigint', primaryKeyConstraintName: 'pk_notification_preferences' })
  userId!: string;

  @Column({ name: 'push_enabled', type: 'boolean', default: false })
  pushEnabled!: boolean;

  @Column({ name: 'push_enabled_at', type: 'timestamptz', nullable: true })
  pushEnabledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  /** Set explicitly by the service on state changes only (not @UpdateDateColumn). */
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_notification_preferences_user' })
  user!: User;
}
