/**
 * Booking Status Log Entity
 *
 * Responsibilities:
 * - Maps the `booking_status_logs` table in PostgreSQL to a TypeScript
 *   class used by TypeORM.
 * - Stores the history of booking status changes.
 * - Records who changed the booking status, the previous status,
 *   the new status, the reason, and the time of the change.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `bookingId`: ID of the booking whose status was changed.
 * - `oldStatus`: Previous booking status. It may be null for the first log.
 * - `newStatus`: New booking status after the change.
 * - `changedBy`: Optional ID of the user who performed the change.
 * - `reason`: Optional explanation for the status change.
 * - `createdAt`: Timestamp when the status change was recorded.
 *
 * Constraints:
 * - `old_status`, when present, must be a supported booking status.
 * - `new_status` must be a supported booking status.
 *
 * Notes:
 * - `booking_id` references `bookings.id`.
 * - `changed_by` references `users.id`.
 * - Deleting a booking cascades to its status logs.
 * - If the user referenced by `changed_by` is deleted, the database
 *   sets `changed_by` to NULL.
 * - Relationships use the existing foreign-key columns.
 * - The existing database schema/migrations remain the source of truth.
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
} from 'typeorm';

import { Booking } from './booking.entity';
import { User } from './user.entity';

@Entity({ name: 'booking_status_logs' })
@Check(
  'chk_booking_logs_old_status',
  `"old_status" IS NULL OR "old_status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
)
@Check(
  'chk_booking_logs_new_status',
  `"new_status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
)
export class BookingStatusLog {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Index('idx_booking_logs_booking')
  @Column({
    name: 'booking_id',
    type: 'bigint',
  })
  bookingId!: string;

  @Column({
    name: 'old_status',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  oldStatus!:
    | 'PENDING_CONFIRMATION'
    | 'CONFIRMED'
    | 'REJECTED'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'NO_SHOW'
    | null;

  @Column({
    name: 'new_status',
    type: 'varchar',
    length: 30,
  })
  newStatus!:
    | 'PENDING_CONFIRMATION'
    | 'CONFIRMED'
    | 'REJECTED'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'NO_SHOW';

  @Column({
    name: 'changed_by',
    type: 'bigint',
    nullable: true,
  })
  changedBy!: string | null;

  @Column({
    type: 'text',
    nullable: true,
  })
  reason!: string | null;

  @Index('idx_booking_logs_created_at')
  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @ManyToOne(() => Booking, (booking) => booking.statusLogs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'booking_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_booking_logs_booking',
  })
  booking!: Booking;

  @ManyToOne(() => User, (user) => user.bookingStatusChanges, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'changed_by',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_booking_logs_user',
  })
  changedByUser!: User | null;
}
