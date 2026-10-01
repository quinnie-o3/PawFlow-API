/**
 * Review Entity
 *
 * Responsibilities:
 * - Maps the `reviews` table in PostgreSQL to a TypeScript class
 *   used by TypeORM.
 * - Represents a customer's review associated with a completed booking.
 * - Stores rating, comment, provider response, visibility,
 *   and response information.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `bookingId`: ID of the booking associated with the review.
 * - `rating`: Rating from 1 to 5.
 * - `comment`: Optional review comment.
 * - `providerResponse`: Optional response from the provider.
 * - `respondedBy`: Optional ID of the user who responded to the review.
 * - `respondedAt`: Optional timestamp when the response was created.
 * - `isVisible`: Indicates whether the review is publicly visible.
 * - `createdAt`: Timestamp when the review was created.
 * - `updatedAt`: Timestamp when the review was last updated.
 *
 * Constraints:
 * - `booking_id` is UNIQUE, so each booking can have at most one review.
 * - `rating` must be between 1 and 5.
 *
 * Notes:
 * - `booking_id` is a foreign key to `bookings.id`.
 * - `responded_by` is an optional foreign key to `users.id`.
 * - If the responding user is deleted, `responded_by` becomes NULL.
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
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Booking } from './booking.entity';
import { User } from './user.entity';

@Entity({ name: 'reviews' })
@Check(
  'chk_reviews_rating',
  `"rating" BETWEEN 1 AND 5`,
)
export class Review {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Column({
    name: 'booking_id',
    type: 'bigint',
    unique: true,
  })
  bookingId!: string;

  @Column({
    type: 'smallint',
  })
  rating!: number;

  @Column({
    type: 'text',
    nullable: true,
  })
  comment!: string | null;

  @Column({
    name: 'provider_response',
    type: 'text',
    nullable: true,
  })
  providerResponse!: string | null;

  @Column({
    name: 'responded_by',
    type: 'bigint',
    nullable: true,
  })
  respondedBy!: string | null;

  @Column({
    name: 'responded_at',
    type: 'timestamptz',
    nullable: true,
  })
  respondedAt!: Date | null;

  @Index('idx_reviews_visible')
  @Column({
    name: 'is_visible',
    type: 'boolean',
    default: true,
  })
  isVisible!: boolean;

  @Index('idx_reviews_created_at')
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

  @OneToOne(() => Booking, (booking) => booking.review, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'booking_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_reviews_booking',
  })
  booking!: Booking;

  @ManyToOne(() => User, (user) => user.reviewResponses, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'responded_by',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_reviews_responder',
  })
  respondedByUser!: User | null;
}