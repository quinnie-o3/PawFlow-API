/**
 * Booking Idempotency Key Entity
 *
 * Responsibilities:
 * - Maps the `booking_idempotency_keys` table in PostgreSQL to a TypeScript
 *   class used by TypeORM.
 * - Records which booking a customer's `Idempotency-Key` produced, together
 *   with a fingerprint of the normalized request, so a retried
 *   `POST /bookings` returns the original booking instead of a new one.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `customerId`: Customer that owns the key (keys are scoped per customer).
 * - `idempotencyKey`: Client-generated key from the `Idempotency-Key` header.
 * - `requestFingerprint`: SHA-256 hex of the normalized booking request.
 * - `bookingId`: Booking created under this key.
 * - `createdAt`: Timestamp when the key was first used.
 *
 * Constraints:
 * - (`customer_id`, `idempotency_key`) is unique; it also serializes
 *   concurrent requests that reuse a key.
 * - `booking_id` is unique.
 * - `idempotency_key` must match `^[A-Za-z0-9_-]{16,128}$`.
 * - `request_fingerprint` must be 64 lowercase hex characters.
 *
 * Notes:
 * - `customer_id` references `users.id`; `booking_id` references
 *   `bookings.id`. Both cascade on delete.
 * - `booking_id` is NULL only inside the creating transaction.
 * - The existing database schema/migrations remain the source of truth.
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { Booking } from './booking.entity';

@Entity({ name: 'booking_idempotency_keys' })
@Unique('uq_booking_idempotency_customer_key', ['customerId', 'idempotencyKey'])
@Unique('uq_booking_idempotency_booking', ['bookingId'])
@Check(
  'chk_booking_idempotency_key_format',
  `"idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'`,
)
@Check(
  'chk_booking_idempotency_fingerprint',
  `"request_fingerprint" ~ '^[0-9a-f]{64}$'`,
)
export class BookingIdempotencyKey {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Column({
    name: 'customer_id',
    type: 'bigint',
  })
  customerId!: string;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 128,
  })
  idempotencyKey!: string;

  @Column({
    name: 'request_fingerprint',
    type: 'varchar',
    length: 64,
  })
  requestFingerprint!: string;

  @Column({
    name: 'booking_id',
    type: 'bigint',
    nullable: true,
  })
  bookingId!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'customer_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_booking_idempotency_customer',
  })
  customer!: User;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'booking_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_booking_idempotency_booking',
  })
  booking!: Booking | null;
}
