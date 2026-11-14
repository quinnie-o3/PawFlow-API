/**
 * Pet Type Entity
 *
 * Responsibilities:
 * - Maps the `pet_types` table in PostgreSQL to a TypeScript class
 *   used by TypeORM.
 * - Represents the supported types of pets in the system,
 *   such as Dog, Cat, Bird, etc.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `name`: Unique name of the pet type.
 * - `status`: Current pet type status (ACTIVE or INACTIVE).
 * - `createdAt`: Timestamp when the record was created.
 * - `updatedAt`: Timestamp when the record was last updated.
 *
 * Constraints:
 * - `name` must be unique.
 * - `status` must be either ACTIVE or INACTIVE.
 *
 * Notes:
 * - Relationships use the existing foreign-key columns owned by Pet.
 * - The existing database schema/migrations remain the source of truth.
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Pet } from './pet.entity';

@Entity({ name: 'pet_types' })
@Check(
  'chk_pet_types_status',
  `"status" IN ('ACTIVE', 'INACTIVE')`,
)
export class PetType {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Column({
    type: 'varchar',
    length: 100,
    unique: true,
  })
  name!: string;

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

  @OneToMany(() => Pet, (pet) => pet.petType)
  pets!: Pet[];
}