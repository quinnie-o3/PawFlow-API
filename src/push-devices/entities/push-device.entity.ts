/**
 * Push Device Entity (P3-BE05)
 *
 * Maps `push_devices`: one row per (auth session, push registration). The
 * registration value is stored encrypted (`registration_ciphertext`) and
 * identified by an HMAC (`registration_hash`), never in clear text.
 *
 * Invariants (database):
 * - (auth_session_id, user_id) -> auth_sessions(id, user_id): a device always
 *   belongs to the account of the session that registered it; deleting the
 *   session (or user) deletes it.
 * - At most one ACTIVE row per (registration_kind, registration_hash) and per
 *   auth_session_id (partial unique indexes, migration only).
 * - When a session is revoked, its active devices are revoked in the same
 *   transaction (trigger on auth_sessions).
 * - Only last_seen_at and the one-way revocation (NULL -> timestamp + reason)
 *   can change (trigger).
 */

import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { AuthSession } from '../../auth/entities/auth-session.entity';
import type { PushPlatform, PushRevocationReason, RegistrationKind } from '../push-device-types';

@Entity({ name: 'push_devices' })
@Check('chk_push_devices_kind', `"registration_kind" IN ('FID', 'FCM_TOKEN')`)
@Check('chk_push_devices_platform', `"platform" IN ('WEB', 'ANDROID', 'IOS')`)
@Check('chk_push_devices_hash', `"registration_hash" ~ '^[0-9a-f]{64}$'`)
@Check('chk_push_devices_ciphertext', `"registration_ciphertext" ~ '^v1:[A-Za-z0-9_-]{1,32}:'`)
@Check(
  'chk_push_devices_reason',
  `"revocation_reason" IS NULL OR "revocation_reason" IN ('USER_REVOKED', 'SESSION_REVOKED', 'ROTATED', 'TRANSFERRED', 'INVALID_REGISTRATION', 'STALE')`,
)
@Check('chk_push_devices_revocation', `("revoked_at" IS NULL) = ("revocation_reason" IS NULL)`)
@Check('chk_push_devices_seen', `"last_seen_at" >= "registered_at"`)
// Partial unique/active indexes: migration only.
@Index('uq_push_devices_active_registration', { synchronize: false })
@Index('uq_push_devices_active_session', { synchronize: false })
@Index('idx_push_devices_user_active', { synchronize: false })
export class PushDevice {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: string;

  @Index('idx_push_devices_session')
  @Column({ name: 'auth_session_id', type: 'uuid' })
  authSessionId!: string;

  @Column({ name: 'registration_kind', type: 'varchar', length: 16 })
  registrationKind!: RegistrationKind;

  @Column({ name: 'registration_hash', type: 'varchar', length: 64 })
  registrationHash!: string;

  @Column({ name: 'registration_ciphertext', type: 'text' })
  registrationCiphertext!: string;

  @Column({ type: 'varchar', length: 16 })
  platform!: PushPlatform;

  @Column({ name: 'registered_at', type: 'timestamptz', default: () => 'NOW()' })
  registeredAt!: Date;

  @Index('idx_push_devices_last_seen')
  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'NOW()' })
  lastSeenAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revocation_reason', type: 'varchar', length: 32, nullable: true })
  revocationReason!: PushRevocationReason | null;

  // Composite FK: the device's user is always the session's user (no
  // separate user FK needed; users -> auth_sessions cascades already).
  @ManyToOne(() => AuthSession, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'auth_session_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_push_devices_session_user' },
    { name: 'user_id', referencedColumnName: 'userId' },
  ])
  session!: AuthSession;
}
