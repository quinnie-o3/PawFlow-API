/**
 * Auth User Token Entity (P3-BE02)
 *
 * Maps `auth_user_tokens`: one-time, expiring tokens e-mailed to a user for
 * password reset or e-mail verification. Only the SHA-256 hash of each
 * opaque token is stored. A token is usable while it is not consumed, not
 * revoked and not expired; at most one usable token per (user, purpose)
 * exists (partial unique index `uq_auth_user_tokens_active`), so issuing a
 * new token revokes the previous one in the same transaction.
 * The existing database schema/migrations remain the source of truth.
 */

import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

export const USER_TOKEN_PURPOSES = ['PASSWORD_RESET', 'EMAIL_VERIFICATION'] as const;

export type UserTokenPurpose = (typeof USER_TOKEN_PURPOSES)[number];

@Entity({ name: 'auth_user_tokens' })
@Unique('uq_auth_user_tokens_hash', ['tokenHash'])
@Check('chk_auth_user_tokens_purpose', `"purpose" IN ('PASSWORD_RESET', 'EMAIL_VERIFICATION')`)
@Check('chk_auth_user_tokens_hash', `"token_hash" ~ '^[0-9a-f]{64}$'`)
@Check('chk_auth_user_tokens_expiry', `"expires_at" > "created_at"`)
@Check('chk_auth_user_tokens_final_state', `"consumed_at" IS NULL OR "revoked_at" IS NULL`)
// Partial unique index (user_id, purpose) WHERE consumed_at IS NULL AND
// revoked_at IS NULL; created by the migration only.
@Index('uq_auth_user_tokens_active', { synchronize: false })
export class AuthUserToken {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_auth_user_tokens_user')
  @Column({ name: 'user_id', type: 'bigint' })
  userId!: string;

  @Column({ type: 'varchar', length: 32 })
  purpose!: UserTokenPurpose;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_auth_user_tokens_user',
  })
  user!: User;
}
