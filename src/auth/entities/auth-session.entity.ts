/**
 * Auth Session Entity (P3-BE01)
 *
 * Maps `auth_sessions`: one row per login. Access tokens carry the session id
 * (`sid`); a revoked or expired session invalidates them immediately.
 * `expiresAt` is absolute and is not extended by refresh-token rotation.
 * The existing database schema/migrations remain the source of truth.
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

export const SESSION_REVOKE_REASONS = [
  'LOGOUT',
  'LOGOUT_ALL',
  'SESSION_REVOKED',
  'REUSE_DETECTED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_INACTIVE',
  // P3-BE02
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
] as const;

export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

@Entity({ name: 'auth_sessions' })
@Check(
  'chk_auth_sessions_revoked_reason',
  `"revoked_reason" IS NULL OR "revoked_reason" IN ('LOGOUT', 'LOGOUT_ALL', 'SESSION_REVOKED', 'REUSE_DETECTED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_INACTIVE', 'PASSWORD_CHANGED', 'PASSWORD_RESET')`,
)
@Check(
  'chk_auth_sessions_revocation',
  `("revoked_at" IS NULL) = ("revoked_reason" IS NULL)`,
)
export class AuthSession {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Index('idx_auth_sessions_user')
  @Column({ name: 'user_id', type: 'bigint' })
  userId!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @Column({
    name: 'last_used_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  lastUsedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({
    name: 'revoked_reason',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  revokedReason!: SessionRevokeReason | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_auth_sessions_user',
  })
  user!: User;
}
