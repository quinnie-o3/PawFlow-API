import type { ConfigService } from '@nestjs/config';

import type { PushDeliveryConfig } from '../push-delivery.config';

/**
 * P3-BE06-05 worker settings (same environment, separate loader so the
 * outbox configuration contract stays unchanged).
 *
 * PUSH_WORKER_ENABLED            false (default) | true. true requires a push
 *                                mode other than `disabled` AND a delivery
 *                                executor (BE06-06); without one the
 *                                application refuses to start.
 * PUSH_WORKER_BATCH_SIZE         5    (1..50)  jobs claimed AND executed concurrently per tick
 * PUSH_WORKER_POLL_MS            2000 (200..60000) idle polling interval
 * PUSH_WORKER_LEASE_SECONDS      120  (10..3600, >= 3 x PUSH_SEND_TIMEOUT_MS) renewed every lease/3
 * PUSH_WORKER_JOB_TIMEOUT_MS     60000 (1000..3600000, >= PUSH_SEND_TIMEOUT_MS) per-attempt bound
 * PUSH_DELIVERY_MAX_ATTEMPTS     8    (1..20)
 * PUSH_RETRY_BASE_MS             30000 (1000..600000) first retry delay (doubles per attempt)
 * PUSH_RETRY_MAX_MS              3600000 (>= base, <= 21600000) backoff cap
 * PUSH_WORKER_SHUTDOWN_GRACE_MS  10000 (0..60000) wait for in-flight jobs on shutdown
 */
export interface PushWorkerConfig {
  enabled: boolean;
  batchSize: number;
  pollMs: number;
  leaseSeconds: number;
  jobTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  shutdownGraceMs: number;
}

/** FCM guidance: wait at least one minute after a quota error. */
export const QUOTA_MIN_RETRY_MS = 60_000;
/** Configuration problems need an operator: retry slowly. */
export const CONFIGURATION_MIN_RETRY_MS = 5 * 60_000;
/** Never retry sooner than this (no busy loops). */
export const MIN_RETRY_MS = 1_000;
/** Jitter: +/- 20 % of the exponential delay. */
export const RETRY_JITTER = 0.2;
/** Poll back-off cap after failed ticks (e.g. database unavailable). */
export const MAX_POLL_BACKOFF_MS = 60_000;

function integer(config: Pick<ConfigService, 'get'>, key: string, fallback: number, min: number, max: number): number {
  const raw = config.get<string>(key)?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadPushWorkerConfig(config: Pick<ConfigService, 'get'>, delivery: PushDeliveryConfig): PushWorkerConfig {
  const enabledRaw = config.get<string>('PUSH_WORKER_ENABLED')?.trim().toLowerCase() || 'false';
  if (!['true', 'false'].includes(enabledRaw)) throw new Error('PUSH_WORKER_ENABLED must be true or false');
  const enabled = enabledRaw === 'true';
  if (enabled && delivery.mode === 'disabled') {
    throw new Error('PUSH_WORKER_ENABLED=true requires PUSH_DELIVERY_MODE other than "disabled"');
  }

  const leaseSeconds = integer(config, 'PUSH_WORKER_LEASE_SECONDS', 120, 10, 3_600);
  if (leaseSeconds * 1000 < 3 * delivery.sendTimeoutMs) {
    throw new Error('PUSH_WORKER_LEASE_SECONDS must be at least 3 x PUSH_SEND_TIMEOUT_MS');
  }
  const jobTimeoutMs = integer(config, 'PUSH_WORKER_JOB_TIMEOUT_MS', 60_000, 1_000, 3_600_000);
  if (jobTimeoutMs < delivery.sendTimeoutMs) {
    throw new Error('PUSH_WORKER_JOB_TIMEOUT_MS must be at least PUSH_SEND_TIMEOUT_MS');
  }
  const retryBaseMs = integer(config, 'PUSH_RETRY_BASE_MS', 30_000, 1_000, 600_000);
  const retryMaxMs = integer(config, 'PUSH_RETRY_MAX_MS', 3_600_000, retryBaseMs, 21_600_000);

  return {
    enabled,
    batchSize: integer(config, 'PUSH_WORKER_BATCH_SIZE', 5, 1, 50),
    pollMs: integer(config, 'PUSH_WORKER_POLL_MS', 2_000, 200, 60_000),
    leaseSeconds,
    jobTimeoutMs,
    maxAttempts: integer(config, 'PUSH_DELIVERY_MAX_ATTEMPTS', 8, 1, 20),
    retryBaseMs,
    retryMaxMs,
    shutdownGraceMs: integer(config, 'PUSH_WORKER_SHUTDOWN_GRACE_MS', 10_000, 0, 60_000),
  };
}
