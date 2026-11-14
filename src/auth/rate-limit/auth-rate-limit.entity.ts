/**
 * Auth Rate Limit Entity (P3-BE03)
 *
 * Maps `auth_rate_limits`: fixed-window request counters shared by every
 * backend instance. `bucket` is an HMAC of the client key (IP or e-mail),
 * never the raw value. Rows expire with their window and are purged
 * periodically. Written only through the atomic upsert in
 * AuthRateLimitService; the migration remains the source of truth.
 */

import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'auth_rate_limits' })
@Check('chk_auth_rate_limits_bucket', `"bucket" ~ '^[0-9a-f]{64}$'`)
@Check('chk_auth_rate_limits_hits', `"hits" > 0`)
@Check('chk_auth_rate_limits_window', `"expires_at" > "window_start"`)
export class AuthRateLimit {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  policy!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  bucket!: string;

  @PrimaryColumn({ name: 'window_start', type: 'timestamptz' })
  windowStart!: Date;

  @Column({ type: 'integer' })
  hits!: number;

  @Index('idx_auth_rate_limits_expires')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
