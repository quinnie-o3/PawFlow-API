/**
 * Pet Entity
 *
 * Responsibilities:
 * - Maps the `pets` table in PostgreSQL to a TypeScript class used by TypeORM.
 * - Represents a pet registered by a user in the system.
 * - Stores basic pet information, type, physical information,
 *   health notes, and current status.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `ownerId`: ID of the user who owns the pet.
 * - `petTypeId`: ID of the pet type.
 * - `name`: Pet name.
 * - `breed`: Optional breed information.
 * - `birthDate`: Optional date of birth.
 * - `weight`: Optional pet weight.
 * - `healthNote`: Optional health-related notes.
 * - `status`: Current pet status (ACTIVE or INACTIVE).
 * - `createdAt`: Timestamp when the record was created.
 * - `updatedAt`: Timestamp when the record was last updated.
 *
 * Constraints:
 * - `weight` must be greater than 0 when provided.
 * - `status` must be either ACTIVE or INACTIVE.
 * - The combination of `id` and `owner_id` is unique according to
 *   the current database schema.
 *
 * Notes:
 * - `owner_id` is a foreign key to `users.id`.
 * - `pet_type_id` is a foreign key to `pet_types.id`.
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
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Booking } from '../../bookings/entities/booking.entity';
import { PetType } from './pet-type.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'pets' })
@Check(
  'chk_pets_weight',
  `"weight" IS NULL OR "weight" > 0`,
)
@Check(
  'chk_pets_status',
  `"status" IN ('ACTIVE', 'INACTIVE')`,
)
@Unique(
  'uq_pets_id_owner',
  ['id', 'ownerId'],
)
export class Pet {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Index('idx_pets_owner')
  @Column({
    name: 'owner_id',
    type: 'bigint',
  })
  ownerId!: string;

  @Index('idx_pets_type')
  @Column({
    name: 'pet_type_id',
    type: 'bigint',
  })
  petTypeId!: string;

  @Column({
    type: 'varchar',
    length: 100,
  })
  name!: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  breed!: string | null;

  @Column({
    name: 'birth_date',
    type: 'date',
    nullable: true,
  })
  birthDate!: string | null;

  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
  })
  weight!: string | null;

  @Column({
    name: 'health_note',
    type: 'text',
    nullable: true,
  })
  healthNote!: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'ACTIVE',
  })
  status!: 'ACTIVE' | 'INACTIVE';

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

  @ManyToOne(() => User, (user) => user.pets, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'owner_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_pets_owner',
  })
  owner!: User;

  @ManyToOne(() => PetType, (petType) => petType.pets, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'pet_type_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_pets_pet_type',
  })
  petType!: PetType;

  @OneToMany(() => Booking, (booking) => booking.pet)
  bookings!: Booking[];
}
