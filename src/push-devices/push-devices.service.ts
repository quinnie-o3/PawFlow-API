import { ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  DEFAULT_PUSH_STALE_DAYS,
  type PushPlatform,
  type PushRevocationReason,
  type RegistrationKind,
  type RegistrationResult,
} from './push-device-types';
import {
  decryptRegistration,
  encryptRegistration,
  hashRegistration,
  loadPushRegistrationKeys,
  type PushRegistrationKeys,
  registrationRef,
} from './push-registration.crypto';

export interface RegisterPushDeviceInput {
  registrationKind: RegistrationKind;
  registrationValue: string;
  platform: PushPlatform;
}

/** Safe projection: never the registration value or its hash. */
export interface PushDeviceView {
  id: string;
  platform: PushPlatform;
  registrationKind: RegistrationKind;
  /** Registered by the session of this request (this browser / app). */
  current: boolean;
  /** Not re-registered within PUSH_DEVICE_STALE_DAYS: not used for delivery until it registers again. */
  stale: boolean;
  registeredAt: Date;
  lastSeenAt: Date;
}

/** Internal (P3-BE06): a destination that may receive push now. Contains the decrypted value. */
export interface PushSendTarget {
  deviceId: string;
  registrationKind: RegistrationKind;
  /** Send as `fid` when kind = FID, as `token` when kind = FCM_TOKEN. */
  registrationValue: string;
  platform: PushPlatform;
  lastSeenAt: Date;
}

export const PUSH_DEVICE_NOT_FOUND = 'Push device not found';
const ADVISORY_NAMESPACE = 0x50555348; // 'PUSH'

/**
 * The single definition of "may receive a push now" (aliases d, s, u; $1 =
 * user id, $2 = stale days): active registration of that user, live session
 * of the same user (not revoked, not expired), ACTIVE account, seen within
 * the stale threshold. Shared by findSendTargets and isSendEligible.
 */
const SEND_ELIGIBLE_FROM_WHERE = `
         FROM push_devices d
         JOIN auth_sessions s ON s.id = d.auth_session_id AND s.user_id = d.user_id
         JOIN users u ON u.id = d.user_id
        WHERE d.user_id = $1 AND d.revoked_at IS NULL
          AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'ACTIVE'
          AND d.last_seen_at > now() - make_interval(days => $2)`;
const REVOKED_RETENTION_DAYS = 30;

interface DeviceRow {
  id: string;
  auth_session_id: string;
  registration_kind: RegistrationKind;
  platform: PushPlatform;
  registered_at: Date;
  last_seen_at: Date;
}

/**
 * P3-BE05 push device lifecycle.
 *
 * Ownership: a registration belongs to the account AND auth session that
 * registered it (composite FK). When that session is revoked by any path,
 * a database trigger revokes the registration in the same transaction, so
 * cleanup never depends on the client.
 *
 * Registration (`register`) is one transaction:
 *   1. lock the caller's session row FOR UPDATE (it must be live and the
 *      account ACTIVE); this serializes with logout/revocation, which update
 *      the same row, and with suspension (user -> sessions -> devices);
 *   2. take a transaction advisory lock on the destination (kind + HMAC),
 *      serializing registrations of the same installation across instances;
 *   3. same destination active for this session -> REFRESHED (last_seen_at);
 *      active for another session -> revoke it (TRANSFERRED);
 *      this session had another active destination -> revoke it (ROTATED);
 *      a session that LOST this destination by transfer may not reclaim it
 *      (409 REGISTRATION_TRANSFERRED: stale request from the previous account);
 *   4. insert the new active row.
 * Partial unique indexes (one active row per destination and per session)
 * back these rules up at the database level.
 */
@Injectable()
export class PushDevicesService {
  private readonly logger = new Logger(PushDevicesService.name);
  private readonly keys: PushRegistrationKeys;
  readonly staleDays: number;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    this.keys = loadPushRegistrationKeys(configService);
    const stale = Number(configService.get<string>('PUSH_DEVICE_STALE_DAYS') ?? DEFAULT_PUSH_STALE_DAYS);
    if (!Number.isInteger(stale) || stale < 1 || stale > 365) {
      throw new Error('PUSH_DEVICE_STALE_DAYS must be an integer between 1 and 365');
    }
    this.staleDays = stale;
    if (this.keys.derivedForDevelopment) {
      this.logger.warn('PUSH_REGISTRATION_KEYS / PUSH_REGISTRATION_HASH_KEY not set: using development keys derived from JWT_SECRET (not allowed in production)');
    }
  }

  async register(actor: AuthenticatedUser, input: RegisterPushDeviceInput): Promise<{ result: RegistrationResult; device: PushDeviceView }> {
    const sessionId = actor.sessionId;
    if (!sessionId) throw new UnauthorizedException();

    const hash = hashRegistration(this.keys, input.registrationKind, input.registrationValue);
    const ciphertext = encryptRegistration(this.keys, input.registrationValue);

    const outcome = await this.dataSource.transaction(async (m) => {
      const [session] = (await m.query(
        `SELECT s.revoked_at, s.expires_at > now() AS live, u.status
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2
          FOR UPDATE OF s`,
        [sessionId, actor.id],
      )) as { revoked_at: Date | null; live: boolean; status: string }[];
      if (!session || session.revoked_at || !session.live || session.status !== 'ACTIVE') {
        throw new UnauthorizedException();
      }

      await m.query(`SELECT pg_advisory_xact_lock($1, $2)`, [ADVISORY_NAMESPACE, parseInt(hash.slice(0, 8), 16) | 0]);

      const lost = (await m.query(
        `SELECT 1 FROM push_devices WHERE registration_kind = $1 AND registration_hash = $2 AND auth_session_id = $3 AND revocation_reason = 'TRANSFERRED' LIMIT 1`,
        [input.registrationKind, hash, sessionId],
      )) as unknown[];
      if (lost.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'This installation was registered by another account since; log in again to use it',
          code: 'REGISTRATION_TRANSFERRED',
        });
      }

      let transferred = false;
      let rotated = false;
      const [sameDestination] = (await m.query(
        `SELECT id::text AS id, auth_session_id, platform FROM push_devices
          WHERE registration_kind = $1 AND registration_hash = $2 AND revoked_at IS NULL FOR UPDATE`,
        [input.registrationKind, hash],
      )) as { id: string; auth_session_id: string; platform: PushPlatform }[];

      if (sameDestination?.auth_session_id === sessionId && sameDestination.platform === input.platform) {
        const [row] = (await m.query(
          `UPDATE push_devices SET last_seen_at = GREATEST(now(), last_seen_at) WHERE id = $1
           RETURNING id::text AS id, auth_session_id, registration_kind, platform, registered_at, last_seen_at`,
          [sameDestination.id],
        ))[0] as DeviceRow[];
        return { result: 'REFRESHED' as const, row };
      }
      if (sameDestination) {
        transferred = sameDestination.auth_session_id !== sessionId;
        rotated = !transferred;
        await this.revokeRow(m, sameDestination.id, transferred ? 'TRANSFERRED' : 'ROTATED');
      }

      const previous = (await m.query(
        `SELECT id::text AS id FROM push_devices WHERE auth_session_id = $1 AND revoked_at IS NULL FOR UPDATE`,
        [sessionId],
      )) as { id: string }[];
      for (const p of previous) {
        await this.revokeRow(m, p.id, 'ROTATED');
        rotated = true;
      }

      const [row] = (await m.query(
        `INSERT INTO push_devices (user_id, auth_session_id, registration_kind, registration_hash, registration_ciphertext, platform)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id, auth_session_id, registration_kind, platform, registered_at, last_seen_at`,
        [actor.id, sessionId, input.registrationKind, hash, ciphertext, input.platform],
      )) as DeviceRow[];

      await m.query(
        `DELETE FROM push_devices WHERE user_id = $1 AND revoked_at < now() - make_interval(days => $2)`,
        [actor.id, REVOKED_RETENTION_DAYS],
      );

      return { result: (transferred ? 'TRANSFERRED' : rotated ? 'ROTATED' : 'CREATED') as RegistrationResult, row };
    });

    this.logger.log(`Push device ${outcome.result.toLowerCase()} (device ${outcome.row.id}, ${input.registrationKind}, ${input.platform}, ${registrationRef(hash)})`);
    return { result: outcome.result, device: this.toView(outcome.row, sessionId) };
  }

  /** The caller's active registrations (all of their sessions), newest first. */
  async list(actor: AuthenticatedUser): Promise<PushDeviceView[]> {
    const rows: DeviceRow[] = await this.dataSource.query(
      `SELECT id::text AS id, auth_session_id, registration_kind, platform, registered_at, last_seen_at
         FROM push_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY push_devices.id DESC`,
      [actor.id],
    );
    return rows.map((r) => this.toView(r, actor.sessionId));
  }

  /** Revokes one of the caller's devices. Idempotent for the owner; another user's device is a 404. */
  async revoke(actor: AuthenticatedUser, deviceId: string): Promise<void> {
    const [rows] = (await this.dataSource.query(
      `UPDATE push_devices SET revoked_at = now(), revocation_reason = 'USER_REVOKED'
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [deviceId, actor.id],
    )) as [unknown[], number];
    if (rows.length === 1) return;
    const exists = (await this.dataSource.query(`SELECT 1 FROM push_devices WHERE id = $1 AND user_id = $2`, [deviceId, actor.id])) as unknown[];
    if (exists.length === 0) throw new NotFoundException(PUSH_DEVICE_NOT_FOUND);
  }

  // ------------------------------------------------------------ internal API (P3-BE06)

  /**
   * Destinations that may receive a push for this user now: active
   * registration, live (not revoked, not expired) session, ACTIVE account,
   * seen within the stale threshold. Values are decrypted; never log them.
   */
  async findSendTargets(userId: string): Promise<PushSendTarget[]> {
    const rows = (await this.dataSource.query(
      `SELECT d.id::text AS id, d.registration_kind, d.registration_ciphertext, d.platform, d.last_seen_at
       ${SEND_ELIGIBLE_FROM_WHERE}
        ORDER BY d.id`,
      [userId, this.staleDays],
    )) as { id: string; registration_kind: RegistrationKind; registration_ciphertext: string; platform: PushPlatform; last_seen_at: Date }[];

    const targets: PushSendTarget[] = [];
    for (const r of rows) {
      try {
        targets.push({ deviceId: r.id, registrationKind: r.registration_kind, registrationValue: decryptRegistration(this.keys, r.registration_ciphertext), platform: r.platform, lastSeenAt: r.last_seen_at });
      } catch (error) {
        this.logger.error(`Push device ${r.id} cannot be decrypted (${error instanceof Error ? error.message : 'unknown error'}); skipped`);
      }
    }
    return targets;
  }

  /**
   * P3-BE06-06: re-check of ONE destination right before an external send,
   * with exactly the findSendTargets criteria (same SQL). False when the
   * device was revoked, rotated, transferred, its session ended, the account
   * is no longer ACTIVE, or it does not belong to `userId`.
   */
  async isSendEligible(deviceId: string, userId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(`SELECT 1 ${SEND_ELIGIBLE_FROM_WHERE} AND d.id = $3`, [userId, this.staleDays, deviceId])) as unknown[];
    return rows.length === 1;
  }

  /**
   * Revokes a destination that FCM reported as invalid (e.g. UNREGISTERED).
   * `attemptedAt` = when the failing send was attempted: if the client
   * re-registered after that (last_seen_at > attemptedAt), the registration
   * is kept. A rotated registration is a different row, so a stale failure
   * for an old device id can never revoke a newer one. Idempotent.
   */
  async markInvalid(deviceId: string, attemptedAt: Date, reason: Extract<PushRevocationReason, 'INVALID_REGISTRATION' | 'STALE'> = 'INVALID_REGISTRATION'): Promise<{ revoked: boolean }> {
    const [rows] = (await this.dataSource.query(
      `UPDATE push_devices SET revoked_at = now(), revocation_reason = $3
        WHERE id = $1 AND revoked_at IS NULL AND last_seen_at <= $2 RETURNING id`,
      [deviceId, attemptedAt, reason],
    )) as [unknown[], number];
    if (rows.length === 1) this.logger.warn(`Push device ${deviceId} revoked: ${reason}`);
    return { revoked: rows.length === 1 };
  }

  /** Optional cleanup: revokes devices not seen for `olderThanDays` (default PUSH_DEVICE_STALE_DAYS). No scheduler is installed. */
  async revokeStale(olderThanDays = this.staleDays): Promise<number> {
    const [, count] = (await this.dataSource.query(
      `UPDATE push_devices SET revoked_at = now(), revocation_reason = 'STALE'
        WHERE revoked_at IS NULL AND last_seen_at < now() - make_interval(days => $1)`,
      [olderThanDays],
    )) as [unknown[], number];
    return count ?? 0;
  }

  private async revokeRow(m: EntityManager, id: string, reason: PushRevocationReason): Promise<void> {
    await m.query(`UPDATE push_devices SET revoked_at = now(), revocation_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, reason]);
  }

  private toView(row: DeviceRow, currentSessionId: string | undefined): PushDeviceView {
    return {
      id: row.id,
      platform: row.platform,
      registrationKind: row.registration_kind,
      current: row.auth_session_id === currentSessionId,
      stale: row.last_seen_at.getTime() < Date.now() - this.staleDays * 86_400_000,
      registeredAt: row.registered_at,
      lastSeenAt: row.last_seen_at,
    };
  }
}
