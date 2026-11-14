/**
 * Complaint Entity
 *
 * Responsibilities:
 * - Maps the `complaints` table in PostgreSQL to a TypeScript class
 *   used by TypeORM.
 * - Represents a complaint created in relation to a booking.
 * - Stores complaint details, current status, administrative notes,
 *   resolution information, and timestamps.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `bookingId`: ID of the booking related to the complaint.
 * - `createdBy`: ID of the user who created the complaint.
 * - `reason`: Reason or description of the complaint.
 * - `status`: Current complaint status.
 * - `adminNote`: Optional administrative note.
 * - `resolvedBy`: Optional ID of the user/admin who resolved the complaint.
 * - `resolvedAt`: Optional timestamp when the complaint was resolved.
 * - `createdAt`: Timestamp when the complaint was created.
 * - `updatedAt`: Timestamp when the complaint was last updated.
 *
 * Constraints:
 * - `status` must be OPEN, IN_REVIEW, RESOLVED, or REJECTED.
 *
 * Notes:
 * - `booking_id` is a foreign key to `bookings.id`.
 * - `created_by` is a foreign key to `users.id`.
 * - `resolved_by` is an optional foreign key to `users.id`.
 * - If the resolver user is deleted, `resolved_by` becomes NULL.
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
  UpdateDateColumn,
} from 'typeorm';

// src/complaints/entities/complaint.entity.ts
import { Booking } from '../../bookings/entities/booking.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'complaints' })
@Check(
  'chk_complaints_status',
  `"status" IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED')`,
)
export class Complaint {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Index('idx_complaints_booking')
  @Column({
    name: 'booking_id',
    type: 'bigint',
  })
  bookingId!: string;

  @Index('idx_complaints_created_by')
  @Column({
    name: 'created_by',
    type: 'bigint',
  })
  createdBy!: string;

  @Column({
    type: 'text',
  })
  reason!: string;

  @Index('idx_complaints_status')
  @Column({
    type: 'varchar',
    length: 20,
    default: 'OPEN',
  })
  status!: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'REJECTED';

  @Column({
    name: 'admin_note',
    type: 'text',
    nullable: true,
  })
  adminNote!: string | null;

  @Column({
    name: 'resolved_by',
    type: 'bigint',
    nullable: true,
  })
  resolvedBy!: string | null;

  @Column({
    name: 'resolved_at',
    type: 'timestamptz',
    nullable: true,
  })
  resolvedAt!: Date | null;

  @Index('idx_complaints_created_at')
  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  updatedAt!: Date;

  @ManyToOne(() => Booking, (booking) => booking.complaints, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'booking_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_complaints_booking',
  })
  booking!: Booking;

  @ManyToOne(() => User, (user) => user.createdComplaints, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'created_by',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_complaints_creator',
  })
  creator!: User;

  @ManyToOne(() => User, (user) => user.resolvedComplaints, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'resolved_by',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_complaints_resolver',
  })
  resolver!: User | null;
}
