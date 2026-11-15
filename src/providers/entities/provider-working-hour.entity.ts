import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Provider } from './provider.entity';

@Entity({ name: 'provider_working_hours' })
@Check('chk_working_hours_day', `"day_of_week" BETWEEN 0 AND 6`)
@Check('chk_working_hours_time', `"start_time" < "end_time"`)
@Unique('uq_provider_working_hours', [
  'providerId',
  'dayOfWeek',
  'startTime',
  'endTime',
])
export class ProviderWorkingHour {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_working_hours_provider')
  @Column({ name: 'provider_id', type: 'bigint' })
  providerId!: string;

  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek!: number;

  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

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

  @ManyToOne(() => Provider, (provider) => provider.workingHours, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'provider_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_working_hours_provider',
  })
  provider!: Provider;
}
