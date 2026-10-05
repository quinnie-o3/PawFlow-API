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
import { Provider } from '../../providers/entities/provider.entity';
import { Service } from '../../services/entities/service.entity';

@Entity({ name: 'availability_slots' })
@Check('chk_slots_time', `"start_time" < "end_time"`)
@Check('chk_slots_capacity', `"capacity" > 0`)
@Check(
  'chk_slots_booked_count',
  `"booked_count" >= 0 AND "booked_count" <= "capacity"`,
)
@Check('chk_slots_status', `"status" IN ('OPEN', 'CLOSED', 'CANCELLED')`)
@Unique('uq_availability_slot', [
  'providerId',
  'serviceId',
  'slotDate',
  'startTime',
  'endTime',
])
@Unique('uq_slots_booking_context', ['id', 'providerId', 'serviceId'])
@Index('idx_slots_search', ['providerId', 'serviceId', 'slotDate', 'status'])
export class AvailabilitySlot {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_slots_provider')
  @Column({ name: 'provider_id', type: 'bigint' })
  providerId!: string;

  @Index('idx_slots_service')
  @Column({ name: 'service_id', type: 'bigint' })
  serviceId!: string;

  @Index('idx_slots_date')
  @Column({ name: 'slot_date', type: 'date' })
  slotDate!: string;

  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  @Column({ type: 'integer', default: 1 })
  capacity!: number;

  @Column({ name: 'booked_count', type: 'integer', default: 0 })
  bookedCount!: number;

  @Index('idx_slots_status')
  @Column({ type: 'varchar', length: 20, default: 'OPEN' })
  status!: 'OPEN' | 'CLOSED' | 'CANCELLED';

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

  @ManyToOne(() => Provider, (provider) => provider.availabilitySlots, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'provider_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_slots_provider',
  })
  provider!: Provider;

  @ManyToOne(() => Service, (service) => service.availabilitySlots, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'service_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_slots_service_provider',
    },
    {
      name: 'provider_id',
      referencedColumnName: 'providerId',
      foreignKeyConstraintName: 'fk_slots_service_provider',
    },
  ])
  service!: Service;

  @OneToMany(() => Booking, (booking) => booking.slot)
  bookings!: Booking[];
}
