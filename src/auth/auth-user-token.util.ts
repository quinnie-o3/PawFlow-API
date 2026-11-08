import type { ConfigService } from '@nestjs/config';
import { type DataSource, type EntityManager, IsNull, LessThan } from 'typeorm';

import { User } from '../users/entities/user.entity';

import { generateRefreshToken, hashRefreshToken } from './auth-session.util';
import { AuthUserToken, type UserTokenPurpose } from './entities/auth-user-token.entity';

/**
 * P3-BE02 one-time tokens (password reset, e-mail verification).
 *
 * Same format as refresh tokens: 32 random bytes (256 bits) from the CSPRNG,
 * base64url (43 characters); only the SHA-256 hex digest is persisted. A
 * fast hash is sufficient because the token is not guessable; it also allows
 * a direct indexed lookup by hash.
 */
export const USER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Password-reset links are short-lived: 30 minutes. */
export const DEFAULT_PASSWORD_RESET_TTL_SECONDS = 30 * 60;

/** Verification links are less sensitive (they grant no access): 24 hours. */
export const DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

/** Minimum interval between two e-mails of the same purpose to one user. */
export const DEFAULT_USER_TOKEN_COOLDOWN_SECONDS = 60;

/** Consumed / revoked / expired tokens of a user older than this are pruned on the next issuance. */
export const USER_TOKEN_RETENTION_DAYS = 7;

function positiveSeconds(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get<string>(key) ?? fallback);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeSeconds(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get<string>(key) ?? fallback);

  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function userTokenTtlSeconds(config: ConfigService, purpose: UserTokenPurpose): number {
  return purpose === 'PASSWORD_RESET'
    ? positiveSeconds(config, 'PASSWORD_RESET_TOKEN_TTL_SECONDS', DEFAULT_PASSWORD_RESET_TTL_SECONDS)
    : positiveSeconds(config, 'EMAIL_VERIFICATION_TOKEN_TTL_SECONDS', DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS);
}

/**
 * Minimum duration of POST /auth/forgot-password. The request commits a
 * token only for eligible accounts; padding every response to the same floor
 * keeps that work from being observable as latency.
 */
export const DEFAULT_RECOVERY_MIN_RESPONSE_MS = 250;

export function recoveryMinResponseMs(config: ConfigService): number {
  return nonNegativeSeconds(config, 'AUTH_RECOVERY_MIN_RESPONSE_MS', DEFAULT_RECOVERY_MIN_RESPONSE_MS);
}

export function userTokenCooldownSeconds(config: ConfigService): number {
  return nonNegativeSeconds(config, 'AUTH_EMAIL_COOLDOWN_SECONDS', DEFAULT_USER_TOKEN_COOLDOWN_SECONDS);
}

export const generateUserToken = generateRefreshToken;
export const hashUserToken = hashRefreshToken;

export type UserTokenState = 'USABLE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';

export function userTokenState(token: AuthUserToken, now: Date): UserTokenState {
  if (token.consumedAt) return 'CONSUMED';
  if (token.revokedAt) return 'REVOKED';
  if (token.expiresAt <= now) return 'EXPIRED';
  return 'USABLE';
}

/**
 * Revokes every not yet consumed/revoked token of the user (one purpose, or
 * all) inside the caller's transaction. Callers hold the user row FOR UPDATE.
 */
export async function revokeUserTokens(
  manager: EntityManager,
  userId: string,
  purpose: UserTokenPurpose | undefined,
  now: Date,
): Promise<number> {
  const result = await manager.getRepository(AuthUserToken).update(
    {
      userId,
      ...(purpose ? { purpose } : {}),
      consumedAt: IsNull(),
      revokedAt: IsNull(),
    },
    { revokedAt: now },
  );

  return result.affected ?? 0;
}

/**
 * Revokes one still-usable token whose e-mail could not be handed to the
 * transport. Nobody holds the link, and while it stays usable the cooldown
 * would block a new request; revoking it lets the user retry immediately.
 * Takes the user lock first (user -> tokens). Returns whether it revoked.
 */
export async function revokeUndeliveredUserToken(
  dataSource: DataSource,
  userId: string,
  tokenHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  return dataSource.transaction(async (manager) => {
    await manager.getRepository(User).findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
    const result = await manager
      .getRepository(AuthUserToken)
      .update({ userId, tokenHash, consumedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: now });

    return (result.affected ?? 0) > 0;
  });
}

export type IssueUserTokenResult =
  | { kind: 'issued'; token: string; expiresAt: Date }
  | { kind: 'cooldown'; retryAfterSeconds: number };

/**
 * Issues a new token, superseding (revoking) the previous usable one, inside
 * the caller's transaction. The caller must hold the user row FOR UPDATE
 * (lock order user -> sessions -> tokens), which serializes issuance and
 * consumption for a user. Returns `cooldown` instead when the previous
 * still-usable token was issued less than `cooldownSeconds` ago.
 */
export async function issueUserToken(
  manager: EntityManager,
  userId: string,
  purpose: UserTokenPurpose,
  options: { ttlSeconds: number; cooldownSeconds: number; now: Date },
): Promise<IssueUserTokenResult> {
  const { ttlSeconds, cooldownSeconds, now } = options;
  const repository = manager.getRepository(AuthUserToken);
  const current = await repository.findOne({
    where: { userId, purpose, consumedAt: IsNull(), revokedAt: IsNull() },
  });

  if (current && current.expiresAt > now) {
    const elapsedMs = now.getTime() - current.createdAt.getTime();

    if (elapsedMs < cooldownSeconds * 1000) {
      return { kind: 'cooldown', retryAfterSeconds: Math.ceil((cooldownSeconds * 1000 - elapsedMs) / 1000) };
    }
  }

  await revokeUserTokens(manager, userId, purpose, now);
  await repository.delete({
    userId,
    purpose,
    createdAt: LessThan(new Date(now.getTime() - USER_TOKEN_RETENTION_DAYS * 86_400_000)),
  });

  const token = generateUserToken();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  await repository.insert({
    userId,
    purpose,
    tokenHash: hashUserToken(token),
    createdAt: now,
    expiresAt,
    consumedAt: null,
    revokedAt: null,
  });

  return { kind: 'issued', token, expiresAt };
}
