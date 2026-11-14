import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { NotificationTargetType, NotificationType } from '../../notifications/notification-types';
import type { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import type { PushDevicesService, PushSendTarget } from '../../push-devices/push-devices.service';
import type { DeviceFinalOutcome } from '../entities/notification-push-send.entity';
import type { DeliveryResult, PushMessage, PushProvider } from '../provider/push-provider.types';
import type { DeliveryJobContext, DeliveryJobExecutor, JobExecutionOutcome, RecordResult } from '../worker/delivery-job.types';

/** Per-job bound on concurrent provider calls. */
export const DISPATCH_CONCURRENCY = 4;
/** Never start a send with less than this much delivery window left. */
export const MIN_REMAINING_MS = 1_000;

export type DispatchDevices = Pick<PushDevicesService, 'findSendTargets' | 'isSendEligible' | 'markInvalid'>;
/** BE07-03: the recipient's push consent (NotificationPreferencesService). */
export type DispatchConsent = Pick<NotificationPreferencesService, 'getPushConsentForNotification'>;
/** Bound for one consent read; on timeout consent is UNKNOWN (fail closed, retry). */
export const CONSENT_TIMEOUT_MS = 5_000;

type ConsentDecision = 'ALLOWED' | 'OPTED_OUT' | 'NOTIFICATION_GONE' | 'UNAVAILABLE';

export interface PushDispatchExecutorOptions {
  /** Deadline / TTL clock (tests); defaults to Date.now. */
  now?: () => number;
  concurrency?: number;
  /** Consent read timeout (tests); defaults to CONSENT_TIMEOUT_MS. */
  consentTimeoutMs?: number;
}

interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  target_type: NotificationTargetType | null;
  target_id: string | null;
}

/** Mutable tally of one attempt. */
interface Tally {
  targets: number;
  previouslyFinal: number;
  prevAccepted: number;
  accepted: number;
  invalidDestination: number;
  invalidRequest: number;
  ineligible: number;
  retry: number;
  notStarted: number;
  retryCategory: 'TRANSIENT' | 'RATE_LIMITED' | null;
  retryCode: string | null;
  retryAfterMs: number | null;
  ambiguous: boolean;
  shared: { kind: 'CONFIGURATION' | 'INVALID_PAYLOAD' | 'DISABLED'; code: string } | null;
  stop: 'LEASE_LOST' | 'DEADLINE' | 'ABORTED' | 'SHARED' | 'RATE_LIMITED' | 'ERROR' | 'OPTED_OUT' | 'CONSENT_UNAVAILABLE' | 'NOTIFICATION_GONE' | null;
  error: unknown;
  /** BE07-03: an authoritative read showed the recipient is no longer opted in for this notification. */
  optedOut: boolean;
  /** BE07-03: a consent read failed or timed out (consent unknown -> fail closed). */
  consentUnavailable: boolean;
  notificationGone: boolean;
}

/**
 * P3-BE06-06: the real DeliveryJobExecutor. For one claimed job (one inbox
 * notification of one recipient):
 *
 *  1. Re-reads the persisted notification (scoped to the job's recipient).
 *  2. Lists the recipient's send-eligible devices (P3-BE05 findSendTargets)
 *     and skips devices that already have a FINAL outcome for this job.
 *  3. Per device (<= DISPATCH_CONCURRENCY at once), right before sending:
 *     stops if aborted / deadline reached; re-checks eligibility
 *     (isSendEligible: same rules, current state); re-verifies and extends
 *     the lease (fence); sends through PUSH_PROVIDER with the remaining
 *     window as TTL; persists the final per-device outcome immediately
 *     (fenced insert); on INVALID_DESTINATION revokes that exact device row
 *     (markInvalid, which keeps it if it re-registered after the attempt).
 *  4. Returns the aggregate outcome; the worker applies retry / deadline
 *     policy. No database transaction is open during provider calls.
 *
 * Shared failures (CONFIGURATION, INVALID_PAYLOAD, DISABLED) and quota stop
 * new sends for this attempt. Devices left without a final outcome are
 * retried on the next attempt; finalized devices are never re-sent.
 */
export class PushDispatchExecutor implements DeliveryJobExecutor {
  private readonly logger = new Logger('PushDispatchExecutor');
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly consentTimeoutMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly devices: DispatchDevices,
    private readonly provider: PushProvider,
    private readonly consent: DispatchConsent,
    options: PushDispatchExecutorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.concurrency = Math.max(1, Math.min(16, options.concurrency ?? DISPATCH_CONCURRENCY));
    this.consentTimeoutMs = options.consentTimeoutMs ?? CONSENT_TIMEOUT_MS;
  }

  /**
   * BE07-03: fresh, bounded consent read. Only an authoritative answer can
   * allow or suppress; any error or timeout is UNAVAILABLE (never treated as
   * opted in, never as opted out).
   */
  private async checkConsent(ctx: DeliveryJobContext): Promise<ConsentDecision> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const read = this.consent.getPushConsentForNotification(ctx.recipientUserId, ctx.notificationId);
      read.catch(() => undefined);
      const consent = await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('consent read timeout'), { code: 'CONSENT_TIMEOUT' })), this.consentTimeoutMs);
        }),
      ]);
      if (consent === null) return 'NOTIFICATION_GONE';
      return consent.optedIn && consent.inCurrentEpoch ? 'ALLOWED' : 'OPTED_OUT';
    } catch (error) {
      const e = error as { name?: unknown; code?: unknown };
      const name = typeof e?.name === 'string' ? e.name : 'Error';
      const code = typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? `(${e.code})` : '';
      this.logger.warn(`Push consent for job ${ctx.jobId} unavailable (${name}${code}); not sending, will retry`);
      return 'UNAVAILABLE';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async execute(ctx: DeliveryJobContext): Promise<JobExecutionOutcome> {
    if (this.provider.name === 'disabled') return { kind: 'DISABLED' };

    const [n] = (await this.dataSource.query(
      `SELECT id::text AS id, type, title, body, target_type, target_id::text AS target_id
         FROM notifications WHERE id = $1 AND recipient_user_id = $2`,
      [ctx.notificationId, ctx.recipientUserId],
    )) as NotificationRow[];
    if (!n) return { kind: 'TERMINAL', category: 'NOTIFICATION_MISSING', code: 'pawflow/notification-missing' };

    // BE07-03 boundary A: consent for THIS notification at the start of the attempt.
    const consentAtStart = await this.checkConsent(ctx);
    if (consentAtStart === 'UNAVAILABLE') return { kind: 'RETRY', category: 'TRANSIENT', code: 'pawflow/consent-unavailable', ambiguous: false };
    if (consentAtStart === 'NOTIFICATION_GONE') return { kind: 'TERMINAL', category: 'NOTIFICATION_MISSING', code: 'pawflow/notification-missing' };
    if (consentAtStart === 'OPTED_OUT') {
      this.logger.log(`Push dispatch job ${ctx.jobId} (notification ${ctx.notificationId}, attempt ${ctx.attempt}): recipient not opted in for this notification -> SUPPRESSED`);
      return { kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' };
    }
    const message: PushMessage = {
      notificationId: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      target: n.target_type && n.target_id ? { type: n.target_type, id: n.target_id } : null,
    };

    const finalized = await ctx.finalizedDevices();
    const targets = (await this.devices.findSendTargets(ctx.recipientUserId)).filter((t) => !finalized.has(t.deviceId));
    const t: Tally = {
      targets: targets.length,
      previouslyFinal: finalized.size,
      prevAccepted: [...finalized.values()].filter((o) => o === 'ACCEPTED').length,
      accepted: 0,
      invalidDestination: 0,
      invalidRequest: 0,
      ineligible: 0,
      retry: 0,
      notStarted: 0,
      retryCategory: null,
      retryCode: null,
      retryAfterMs: null,
      ambiguous: false,
      shared: null,
      stop: null,
      error: undefined,
      optedOut: false,
      consentUnavailable: false,
      notificationGone: false,
    };

    let next = 0;
    const lane = async () => {
      while (next < targets.length) {
        const target = targets[next++];
        try {
          await this.dispatchOne(ctx, target, message, t);
        } catch (error) {
          t.stop ??= 'ERROR';
          t.error ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, lane));

    const outcome = this.aggregate(t);
    this.logger.log(
      `Push dispatch job ${ctx.jobId} (notification ${ctx.notificationId}, attempt ${ctx.attempt}): devices=${t.targets} alreadyFinal=${t.previouslyFinal} ` +
        `accepted=${t.accepted} invalidDestination=${t.invalidDestination} invalidRequest=${t.invalidRequest} ineligible=${t.ineligible} ` +
        `retry=${t.retry} notStarted=${t.notStarted}${t.stop ? ` stop=${t.stop}` : ''} -> ${outcome.kind}`,
    );
    if (t.stop === 'ERROR') throw t.error; // the worker treats it as an ambiguous transient failure
    return outcome;
  }

  private async dispatchOne(ctx: DeliveryJobContext, target: PushSendTarget, message: PushMessage, t: Tally): Promise<void> {
    // Never START a send after cancellation, a shared failure, quota, a lost lease or the deadline.
    if (ctx.signal.aborted) t.stop ??= 'ABORTED';
    const remainingMs = ctx.expiresAt.getTime() - this.now();
    if (!t.stop && remainingMs < MIN_REMAINING_MS) t.stop = 'DEADLINE';
    if (t.stop) {
      t.notStarted++;
      return;
    }

    // BE07-03 boundary B: fresh consent read for THIS notification right before the send.
    const consent = await this.checkConsent(ctx);
    if (consent !== 'ALLOWED') {
      if (consent === 'OPTED_OUT') t.optedOut = true;
      else if (consent === 'UNAVAILABLE') t.consentUnavailable = true;
      else t.notificationGone = true;
      t.stop ??= consent === 'OPTED_OUT' ? 'OPTED_OUT' : consent === 'UNAVAILABLE' ? 'CONSENT_UNAVAILABLE' : 'NOTIFICATION_GONE';
      t.notStarted++;
      return;
    }

    // Current state, right before the external call (revoked / rotated /
    // transferred / logged out / suspended devices are skipped).
    if (!(await this.devices.isSendEligible(target.deviceId, ctx.recipientUserId))) {
      t.ineligible++;
      return;
    }
    // Fence: this claim must still own the job (also extends the lease).
    if (!(await ctx.renewLease())) {
      t.stop = 'LEASE_LOST';
      t.notStarted++;
      return;
    }
    if (ctx.signal.aborted || t.stop) {
      t.stop ??= 'ABORTED';
      t.notStarted++;
      return;
    }

    const attemptedAt = new Date();
    const result: DeliveryResult = await this.provider.send(
      { kind: target.registrationKind, value: target.registrationValue },
      { ...message, ttlSeconds: Math.max(1, Math.floor((ctx.expiresAt.getTime() - this.now()) / 1000)) },
    );

    switch (result.outcome) {
      case 'ACCEPTED':
        if (await this.record(ctx, t, target.deviceId, 'ACCEPTED', null, attemptedAt)) t.accepted++;
        return;
      case 'INVALID_DESTINATION':
        if (await this.record(ctx, t, target.deviceId, 'INVALID_DESTINATION', result.code, attemptedAt)) {
          t.invalidDestination++;
          // Only this exact registration row; kept if it re-registered after the attempt.
          await this.devices.markInvalid(target.deviceId, attemptedAt).catch((error: unknown) => {
            this.logger.warn(`Push device ${target.deviceId}: markInvalid failed (${error instanceof Error ? error.name : 'error'}); it stays eligible until FCM reports it again`);
          });
        }
        return;
      case 'INVALID_REQUEST':
        // Final for this device only; never a reason to revoke it.
        if (await this.record(ctx, t, target.deviceId, 'INVALID_REQUEST', result.code, attemptedAt)) t.invalidRequest++;
        return;
      case 'TRANSIENT':
        this.noteRetry(t, 'TRANSIENT', result.code, result.retryAfterMs, result.ambiguous);
        return;
      case 'RATE_LIMITED':
        this.noteRetry(t, 'RATE_LIMITED', result.code, result.retryAfterMs, false);
        t.stop ??= 'RATE_LIMITED';
        return;
      case 'INVALID_PAYLOAD':
        t.shared ??= { kind: 'INVALID_PAYLOAD', code: result.code };
        t.stop ??= 'SHARED';
        return;
      case 'CONFIGURATION':
        t.shared ??= { kind: 'CONFIGURATION', code: result.code };
        t.stop ??= 'SHARED';
        return;
      case 'DISABLED':
        t.shared ??= { kind: 'DISABLED', code: 'pawflow/push-disabled' };
        t.stop ??= 'SHARED';
        return;
    }
  }

  /** Fenced persistence of a final per-device outcome; false (and stop) when the lease was lost. */
  private async record(ctx: DeliveryJobContext, t: Tally, deviceId: string, outcome: DeviceFinalOutcome, code: string | null, attemptedAt: Date): Promise<boolean> {
    const r: RecordResult = await ctx.recordDeviceOutcome({ pushDeviceId: deviceId, outcome, providerCode: code, attemptedAt });
    if (r === 'LEASE_LOST') {
      t.stop = 'LEASE_LOST';
      return false;
    }
    return true;
  }

  private noteRetry(t: Tally, category: 'TRANSIENT' | 'RATE_LIMITED', code: string, retryAfterMs: number | null, ambiguous: boolean): void {
    t.retry++;
    if (category === 'RATE_LIMITED' || !t.retryCategory) {
      t.retryCategory = category === 'RATE_LIMITED' ? 'RATE_LIMITED' : (t.retryCategory ?? 'TRANSIENT');
      t.retryCode = category === 'RATE_LIMITED' || !t.retryCode ? code : t.retryCode;
    }
    if (retryAfterMs !== null && retryAfterMs > (t.retryAfterMs ?? 0)) t.retryAfterMs = retryAfterMs;
    t.ambiguous ||= ambiguous;
  }

  private aggregate(t: Tally): JobExecutionOutcome {
    if (t.shared?.kind === 'DISABLED') return { kind: 'DISABLED' };
    // BE07-03: an authoritative opt-out ends the job (earlier per-device rows stay).
    if (t.optedOut) return { kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' };
    if (t.notificationGone) return { kind: 'TERMINAL', category: 'NOTIFICATION_MISSING', code: 'pawflow/notification-missing' };
    if (t.shared?.kind === 'CONFIGURATION') return { kind: 'CONFIGURATION', code: t.shared.code };
    if (t.shared?.kind === 'INVALID_PAYLOAD') return { kind: 'TERMINAL', category: 'INVALID_PAYLOAD', code: t.shared.code };
    if (t.stop === 'LEASE_LOST') return { kind: 'RETRY', category: 'TRANSIENT', code: 'pawflow/lease-lost', ambiguous: true };
    if (t.retry > 0 || t.notStarted > 0) {
      const code = t.retryCode ?? (t.consentUnavailable ? 'pawflow/consent-unavailable' : t.stop === 'DEADLINE' ? 'pawflow/deadline-reached' : t.stop === 'ABORTED' ? 'pawflow/dispatch-aborted' : 'pawflow/dispatch-incomplete');
      return { kind: 'RETRY', category: t.retryCategory ?? 'TRANSIENT', code, retryAfterMs: t.retryAfterMs, ambiguous: t.ambiguous };
    }
    const accepted = t.prevAccepted + t.accepted;
    const failedFinal = t.previouslyFinal - t.prevAccepted + t.invalidDestination + t.invalidRequest;
    if (accepted + failedFinal === 0) return { kind: 'NO_DESTINATIONS' };
    return { kind: 'DELIVERED', accepted, failedFinal };
  }
}
