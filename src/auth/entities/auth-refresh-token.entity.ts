/**
 * Auth Refresh Token Entity (P3-BE01)
 *
 * Maps `auth_refresh_tokens`: the rotation chain of an auth session. Only
 * the SHA-256 hash of each opaque token is stored. Each token can be used
 * once (`usedAt`); presenting a used token again is reuse and revokes the
 * whole session.
 */

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
} from 'typeorm';

import { AuthSession } from './auth-session.entity';

@Entity({ name: 'auth_refresh_tokens' })
@Unique('uq_auth_refresh_tokens_hash', ['tokenHash'])
@Check('chk_auth_refresh_tokens_hash', `"token_hash" ~ '^[0-9a-f]{64}$'`)
export class AuthRefreshToken {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_auth_refresh_tokens_session')
  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @ManyToOne(() => AuthSession, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'session_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_auth_refresh_tokens_session',
  })
  session!: AuthSession;
}
