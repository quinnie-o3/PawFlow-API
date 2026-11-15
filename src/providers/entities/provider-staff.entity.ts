/**
 * Provider Staff Entity
 *
 * Responsibilities:
 * - Maps the `provider_staff` table in PostgreSQL to a TypeScript class
 *   used by TypeORM.
 * - Represents a user who works as a staff member for a provider.
 * - Defines database columns, indexes, and CHECK constraints for
 *   provider staff records.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `providerId`: ID of the provider that the staff member belongs to.
 * - `userId`: ID of the user account assigned as provider staff.
 * - `position`: Optional job position/title of the staff member.
 * - `status`: Current staff status (ACTIVE or INACTIVE).
 * - `createdAt`: Timestamp when the record was created.
 * - `updatedAt`: Timestamp when the record was last updated.
 *
 * Constraints:
 * - `user_id` is UNIQUE, so one user can belong to at most one
 *   provider staff record in the current schema.
 * - `status` must be either ACTIVE or INACTIVE.
 *
 * Notes:
 * - `provider_id` is a foreign key to `providers.id`.
 * - `user_id` is a foreign key to `users.id`.
 * - Relationships use the existing foreign-key columns.
 * - The database schema/migrations remain the source of truth.
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

import { Provider } from './provider.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'provider_staff' })
@Check('chk_provider_staff_status', `"status" IN ('ACTIVE', 'INACTIVE')`)
export class ProviderStaff {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Index('idx_provider_staff_provider')
  @Column({
    name: 'provider_id',
    type: 'bigint',
  })
  providerId!: string;

  @Column({
    name: 'user_id',
    type: 'bigint',
    unique: true,
  })
  userId!: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  position!: string | null;

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

  @ManyToOne(() => Provider, (provider) => provider.staff, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'provider_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_provider_staff_provider',
  })
  provider!: Provider;

  @OneToOne(() => User, (user) => user.providerStaff, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_provider_staff_user',
  })
  user!: User;
}
