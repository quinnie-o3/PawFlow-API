import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

@Entity({ name: 'admin_activity_logs' })
@Index('idx_admin_activity_logs_created_at', ['createdAt'])
@Index('idx_admin_activity_logs_admin_created_at', ['adminUserId', 'createdAt'])
@Index('idx_admin_activity_logs_target_created_at', [
  'targetType',
  'targetId',
  'createdAt',
])
@Index('idx_admin_activity_logs_action_created_at', ['action', 'createdAt'])
export class AdminActivityLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'admin_user_id', type: 'bigint' })
  adminUserId!: string;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ name: 'target_type', type: 'varchar', length: 32 })
  targetType!: string;

  @Column({ name: 'target_id', type: 'bigint' })
  targetId!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'admin_user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_admin_activity_logs_admin_user',
  })
  adminUser!: User;
}
