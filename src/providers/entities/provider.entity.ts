/**
 * Provider Entity
 *
 * Responsibilities:
 * - Maps the `providers` table in PostgreSQL to a TypeScript class used by TypeORM.
 * - Defines how database columns correspond to properties in the backend code.
 * - Declares metadata for the primary key, columns, indexes, and CHECK constraints.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `ownerId`: ID of the user who owns the provider.
 * - `businessName`: Provider/business name.
 * - `address`: Provider address.
 * - `phone`: Optional phone number.
 * - `description`: Optional provider description.
 * - `approvalStatus`: Provider approval status
 *   (PENDING, APPROVED, REJECTED, SUSPENDED).
 * - `ratingAvg`: Average rating from 0 to 5.
 * - `ratingCount`: Total number of ratings.
 * - `createdAt`: Timestamp when the record was created.
 * - `updatedAt`: Timestamp when the record was last updated.
 *
 * Constraints:
 * - `owner_id` is UNIQUE in the current database schema.
 * - `approval_status` must be one of the allowed values.
 * - `rating_avg` must be between 0 and 5.
 * - `rating_count` cannot be negative.
 *
 * Notes:
 * - This entity does not automatically create or modify the database table
 *   because TypeORM is configured with `synchronize: false`.
 * - The existing migration/database schema is the source of truth.
 * - Relationships use the existing foreign keys and do not create additional
 *   database columns.
 */
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { AvailabilitySlot } from './availability-slot.entity';
import { Booking } from './booking.entity';
import { ProviderStaff } from './provider-staff.entity';
import { ProviderWorkingHour } from './provider-working-hour.entity';
import { Service } from './service.entity';
import { User } from './user.entity';

@Entity({ name: 'providers' })
@Check(
  'chk_provider_approval',
  `"approval_status" IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')`,
)
@Check('chk_provider_rating_avg', `"rating_avg" >= 0 AND "rating_avg" <= 5`)
@Check('chk_provider_rating_count', `"rating_count" >= 0`)
export class Provider {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Column({
    name: 'owner_id',
    type: 'bigint',
    unique: true,
  })
  ownerId!: string;

  @Column({
    name: 'business_name',
    type: 'varchar',
    length: 200,
  })
  businessName!: string;

  @Column({
    type: 'text',
  })
  address!: string;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  phone!: string | null;

  @Column({
    type: 'text',
    nullable: true,
  })
  description!: string | null;

  @Index('idx_providers_approval_status')
  @Column({
    name: 'approval_status',
    type: 'varchar',
    length: 20,
    default: 'PENDING',
  })
  approvalStatus!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

  @Column({
    name: 'rating_avg',
    type: 'numeric',
    precision: 3,
    scale: 2,
    default: 0,
  })
  ratingAvg!: string;

  @Column({
    name: 'rating_count',
    type: 'integer',
    default: 0,
  })
  ratingCount!: number;

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

  @OneToOne(() => User, (user) => user.provider, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'owner_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_providers_owner',
  })
  owner!: User;

  @OneToMany(() => ProviderStaff, (providerStaff) => providerStaff.provider)
  staff!: ProviderStaff[];

  @OneToMany(() => ProviderWorkingHour, (workingHour) => workingHour.provider)
  workingHours!: ProviderWorkingHour[];

  @OneToMany(() => Service, (service) => service.provider)
  services!: Service[];

  @OneToMany(() => AvailabilitySlot, (slot) => slot.provider)
  availabilitySlots!: AvailabilitySlot[];

  @OneToMany(() => Booking, (booking) => booking.provider)
  bookings!: Booking[];
}
