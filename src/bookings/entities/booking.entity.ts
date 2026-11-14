/**
 * Booking Entity
 *
 * Responsibilities:
 * - Maps the `bookings` table in PostgreSQL to a TypeScript class
 *   used by TypeORM.
 * - Represents a customer's booking for a specific pet, provider,
 *   service, and availability slot.
 * - Stores the booking status, booked price, customer note,
 *   and timestamps.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `customerId`: ID of the customer who created the booking.
 * - `petId`: ID of the pet included in the booking.
 * - `providerId`: ID of the selected provider.
 * - `serviceId`: ID of the selected service.
 * - `slotId`: ID of the selected availability slot.
 * - `status`: Current booking status.
 * - `bookedPrice`: Price recorded at the time of booking.
 * - `customerNote`: Optional note from the customer.
 * - `createdAt`: Timestamp when the booking was created.
 * - `updatedAt`: Timestamp when the booking was last updated.
 *
 * Constraints:
 * - `status` must be one of the supported booking statuses.
 * - `booked_price` must be greater than or equal to 0.
 *
 * Notes:
 * - `customer_id` references `users.id`.
 * - (`pet_id`, `customer_id`) references (`pets.id`, `pets.owner_id`).
 * - `provider_id` references `providers.id`.
 * - (`service_id`, `provider_id`) references
 *   (`services.id`, `services.provider_id`).
 * - (`slot_id`, `provider_id`, `service_id`) references
 *   (`availability_slots.id`, `availability_slots.provider_id`,
 *   `availability_slots.service_id`).
 * - Relationships use the existing foreign-key columns, including composite keys.
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
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { AvailabilitySlot } from '../../availability/entities/availability-slot.entity';
import { Complaint } from '../../complaints/entities/complaint.entity';
import { Payment } from '../../payments/entities/payment.entity';
import { Pet } from '../../pets/entities/pet.entity';
import { Provider } from '../../providers/entities/provider.entity';
import { Review } from '../../reviews/entities/review.entity';
import { Service } from '../../services/entities/service.entity';
import { User } from '../../users/entities/user.entity';
import { BookingStatusLog } from './booking-status-log.entity';

@Entity({ name: 'bookings' })
@Check(
  'chk_bookings_status',
  `"status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
)
@Check('chk_bookings_price', `"booked_price" >= 0`)
@Index('idx_bookings_provider_status', ['providerId', 'status'])
export class Booking {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Index('idx_bookings_customer')
  @Column({
    name: 'customer_id',
    type: 'bigint',
  })
  customerId!: string;

  @Index('idx_bookings_pet')
  @Column({
    name: 'pet_id',
    type: 'bigint',
  })
  petId!: string;

  @Index('idx_bookings_provider')
  @Column({
    name: 'provider_id',
    type: 'bigint',
  })
  providerId!: string;

  @Index('idx_bookings_service')
  @Column({
    name: 'service_id',
    type: 'bigint',
  })
  serviceId!: string;

  @Index('idx_bookings_slot')
  @Column({
    name: 'slot_id',
    type: 'bigint',
  })
  slotId!: string;

  @Index('idx_bookings_status')
  @Column({
    type: 'varchar',
    length: 30,
    default: 'PENDING_CONFIRMATION',
  })
  status!:
    | 'PENDING_CONFIRMATION'
    | 'CONFIRMED'
    | 'REJECTED'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'NO_SHOW';

  @Column({
    name: 'booked_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
  })
  bookedPrice!: string;

  @Column({
    name: 'customer_note',
    type: 'text',
    nullable: true,
  })
  customerNote!: string | null;

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

  @ManyToOne(() => User, (user) => user.bookings, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'customer_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_bookings_customer',
  })
  customer!: User;

  @ManyToOne(() => Pet, (pet) => pet.bookings, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'pet_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_bookings_pet_owner',
    },
    {
      name: 'customer_id',
      referencedColumnName: 'ownerId',
      foreignKeyConstraintName: 'fk_bookings_pet_owner',
    },
  ])
  pet!: Pet;

  @ManyToOne(() => Provider, (provider) => provider.bookings, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'provider_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_bookings_provider',
  })
  provider!: Provider;

  @ManyToOne(() => Service, (service) => service.bookings, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'service_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_bookings_service_provider',
    },
    {
      name: 'provider_id',
      referencedColumnName: 'providerId',
      foreignKeyConstraintName: 'fk_bookings_service_provider',
    },
  ])
  service!: Service;

  @ManyToOne(() => AvailabilitySlot, (slot) => slot.bookings, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'slot_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_bookings_slot_context',
    },
    {
      name: 'provider_id',
      referencedColumnName: 'providerId',
      foreignKeyConstraintName: 'fk_bookings_slot_context',
    },
    {
      name: 'service_id',
      referencedColumnName: 'serviceId',
      foreignKeyConstraintName: 'fk_bookings_slot_context',
    },
  ])
  slot!: AvailabilitySlot;

  @OneToMany(() => BookingStatusLog, (statusLog) => statusLog.booking)
  statusLogs!: BookingStatusLog[];

  @OneToOne(() => Payment, (payment) => payment.booking)
  payment!: Payment | null;

  @OneToOne(() => Review, (review) => review.booking)
  review!: Review | null;

  @OneToMany(() => Complaint, (complaint) => complaint.booking)
  complaints!: Complaint[];
}
