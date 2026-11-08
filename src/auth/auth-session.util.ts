import { createHash, randomBytes } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { type EntityManager, IsNull } from 'typeorm';

import { AuthSession, type SessionRevokeReason } from './entities/auth-session.entity';

/** Access tokens are short-lived; revocation is enforced on every request through `sid`. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Absolute lifetime of a refresh session (not extended by rotation). */
export const DEFAULT_REFRESH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Opaque refresh token: 32 random bytes, base64url (43 characters). */
export const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveSeconds(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string>(key) ?? fallback);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function accessTokenTtlSeconds(config: ConfigService): number {
  return positiveSeconds(config, 'JWT_ACCESS_TOKEN_TTL_SECONDS', DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
}

export function refreshSessionTtlSeconds(config: ConfigService): number {
  return positiveSeconds(config, 'REFRESH_SESSION_TTL_SECONDS', DEFAULT_REFRESH_SESSION_TTL_SECONDS);
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens have 256 bits of entropy, so a fast hash is sufficient. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Revokes every active session of a user inside the caller's transaction.
 * Returns the number of sessions revoked. Callers that also check the user
 * row lock it first (user -> sessions), the same order as token refresh.
 */
export async function revokeUserSessions(
  manager: EntityManager,
  userId: string,
  reason: SessionRevokeReason,
  now: Date = new Date(),
): Promise<number> {
  const result = await manager
    .getRepository(AuthSession)
    .update({ userId, revokedAt: IsNull() }, { revokedAt: now, revokedReason: reason });

  return result.affected ?? 0;
}
