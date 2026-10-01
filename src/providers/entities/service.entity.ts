/**
 * Service Entity
 *
 * Responsibilities:
 * - Maps the `services` table in PostgreSQL to a TypeScript class
 *   used by TypeORM.
 * - Represents a service offered by a provider.
 * - Stores pricing, duration, category, description, and service status.
 *
 * Main fields:
 * - `id`: Auto-increment BIGINT primary key.
 * - `providerId`: ID of the provider that offers the service.
 * - `categoryId`: ID of the category this service belongs to.
 * - `name`: Service name.
 * - `price`: Service price.
 * - `durationMinutes`: Duration of the service in minutes.
 * - `description`: Optional service description.
 * - `status`: Current service status (ACTIVE or INACTIVE).
 * - `createdAt`: Timestamp when the record was created.
 * - `updatedAt`: Timestamp when the record was last updated.
 *
 * Constraints:
 * - `price` must be greater than or equal to 0.
 * - `duration_minutes` must be greater than 0.
 * - `status` must be either ACTIVE or INACTIVE.
 * - The combination of `id` and `provider_id` is unique according to
 *   the current database schema.
 *
 * Notes:
 * - `provider_id` is a foreign key to `providers.id`.
 * - `category_id` is a foreign key to `service_categories.id`.
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

import { AvailabilitySlot } from './availability-slot.entity';
import { Booking } from './booking.entity';
import { Provider } from './provider.entity';
import { ServiceCategory } from './service-category.entity';

@Entity({ name: 'services' })
@Check('chk_services_price', `"price" >= 0`)
@Check('chk_services_duration', `"duration_minutes" > 0`)
@Check('chk_services_status', `"status" IN ('ACTIVE', 'INACTIVE')`)
@Unique('uq_services_id_provider', ['id', 'providerId'])
export class Service {
  @PrimaryGeneratedColumn({
    type: 'bigint',
  })
  id!: string;

  @Index('idx_services_provider')
  @Column({
    name: 'provider_id',
    type: 'bigint',
  })
  providerId!: string;

  @Index('idx_services_category')
  @Column({
    name: 'category_id',
    type: 'bigint',
  })
  categoryId!: string;

  @Column({
    type: 'varchar',
    length: 200,
  })
  name!: string;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
  })
  price!: string;

  @Column({
    name: 'duration_minutes',
    type: 'integer',
  })
  durationMinutes!: number;

  @Column({
    type: 'text',
    nullable: true,
  })
  description!: string | null;

  @Index('idx_services_status')
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

  @ManyToOne(() => Provider, (provider) => provider.services, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'provider_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_services_provider',
  })
  provider!: Provider;

  @ManyToOne(() => ServiceCategory, (category) => category.services, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'category_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_services_category',
  })
  category!: ServiceCategory;

  @OneToMany(() => AvailabilitySlot, (slot) => slot.service)
  availabilitySlots!: AvailabilitySlot[];

  @OneToMany(() => Booking, (booking) => booking.service)
  bookings!: Booking[];
}
