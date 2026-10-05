/**
 * User Entity
 *
 * Responsibilities:
 * - Maps the `users` table in PostgreSQL to a TypeScript class used by TypeORM.
 * - Represents an account in the system.
 * - Stores authentication information, user role, account status,
 *   and basic profile information.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `fullName`: Full name of the user.
 * - `email`: User email address.
 * - `phone`: Optional phone number.
 * - `passwordHash`: Hashed password used for authentication.
 * - `role`: User role in the system
 *   (CUSTOMER, PROVIDER_OWNER, PROVIDER_STAFF, ADMIN).
 * - `status`: Current account status
 *   (ACTIVE, INACTIVE, SUSPENDED).
 * - `createdAt`: Timestamp when the account was created.
 * - `updatedAt`: Timestamp when the account was last updated.
 *
 * Constraints:
 * - `role` must be one of the supported user roles.
 * - `status` must be ACTIVE, INACTIVE, or SUSPENDED.
 * - Email uniqueness is enforced case-insensitively by the database
 *   through the `uq_users_email_lower` functional unique index.
 *
 * Notes:
 * - Passwords must never be stored directly. Only password hashes are stored.
 * - Relationships with Pet, Provider, ProviderStaff, Booking, Review, etc.
 *   use the existing foreign-key columns owned by those entities.
 * - The existing database schema/migrations remain the source of truth.
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Booking } from '../../bookings/entities/booking.entity';
import { BookingStatusLog } from '../../bookings/entities/booking-status-log.entity';
import { Complaint } from '../../complaints/entities/complaint.entity';
import { Pet } from '../../pets/entities/pet.entity';
import { Provider } from '../../providers/entities/provider.entity';
import { ProviderStaff } from '../../providers/entities/provider-staff.entity';
import { Review } from '../../reviews/entities/review.entity';

@Entity({ name: 'users' })
@Check(
  'chk_users_role',
  `"role" IN ('CUSTOMER', 'PROVIDER_OWNER', 'PROVIDER_STAFF', 'ADMIN')`,
)
@Check(
  'chk_users_status',
  `"status" IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')`,
)
@Index('uq_users_email_lower', { synchronize: false })
export class User {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Column({
    name: 'full_name',
    type: 'varchar',
    length: 150,
  })
  fullName!: string;

  @Column({
    type: 'varchar',
    length: 255,
  })
  email!: string;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  phone!: string | null;

  @Column({
    name: 'password_hash',
    type: 'text',
  })
  passwordHash!: string;

  @Column({
    type: 'varchar',
    length: 30,
  })
  role!: 'CUSTOMER' | 'PROVIDER_OWNER' | 'PROVIDER_STAFF' | 'ADMIN';

  @Column({
    type: 'varchar',
    length: 20,
    default: 'ACTIVE',
  })
  status!: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

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

  @OneToMany(() => Pet, (pet) => pet.owner)
  pets!: Pet[];

  @OneToOne(() => Provider, (provider) => provider.owner)
  provider!: Provider | null;

  @OneToOne(() => ProviderStaff, (providerStaff) => providerStaff.user)
  providerStaff!: ProviderStaff | null;

  @OneToMany(() => Booking, (booking) => booking.customer)
  bookings!: Booking[];

  @OneToMany(() => BookingStatusLog, (statusLog) => statusLog.changedByUser)
  bookingStatusChanges!: BookingStatusLog[];

  @OneToMany(() => Review, (review) => review.respondedByUser)
  reviewResponses!: Review[];

  @OneToMany(() => Complaint, (complaint) => complaint.creator)
  createdComplaints!: Complaint[];

  @OneToMany(() => Complaint, (complaint) => complaint.resolver)
  resolvedComplaints!: Complaint[];
}