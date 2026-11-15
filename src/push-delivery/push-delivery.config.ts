import type { ConfigService } from '@nestjs/config';

/**
 * P3-BE06 push delivery configuration (single source for the outbox and the
 * provider).
 *
 * PUSH_DELIVERY_MODE
 *   disabled  push intentionally off: the inbox works, NO delivery jobs are
 *             written (nothing accumulates that could be sent later) and the
 *             provider answers DISABLED without contacting anything.
 *   mock      deterministic in-memory fake provider (development / QA only).
 *   firebase  Firebase Cloud Messaging through the Firebase Admin SDK.
 * Not set -> disabled, except in a deployed environment (NODE_ENV=production
 * or staging), where it must be explicit and `mock` is refused: a deployed
 * environment never silently runs without push or with a fake provider.
 *
 * PUSH_DELIVERY_TTL_SECONDS (default 86400 = 24 h, 60 .. 2419200)
 *   Delivery deadline of each job (expires_at = enqueue time + TTL). A job
 *   not delivered by then is never sent (it becomes EXPIRED).
 *
 * FIREBASE_PROJECT_ID (required when PUSH_DELIVERY_MODE=firebase)
 *   The Firebase project the backend sends for. Credentials are never
 *   configured here: the Admin SDK uses Application Default Credentials of
 *   the runtime (attached service account / workload identity, or the
 *   standard GOOGLE_APPLICATION_CREDENTIALS variable read by Google's own
 *   library). No credential file or JSON is read by PawFlow code.
 *
 * PUSH_SEND_TIMEOUT_MS (default 10000, 1000 .. 60000)
 *   Upper bound for one provider call (including the SDK's own internal
 *   retries). A timeout is an AMBIGUOUS transient outcome.
 */
export const PUSH_DELIVERY_MODES = ['disabled', 'mock', 'firebase'] as const;
export type PushDeliveryMode = (typeof PUSH_DELIVERY_MODES)[number];

export const DEFAULT_PUSH_DELIVERY_TTL_SECONDS = 86_400;
export const MIN_PUSH_DELIVERY_TTL_SECONDS = 60;
export const MAX_PUSH_DELIVERY_TTL_SECONDS = 2_419_200; // 28 days (FCM maximum TTL)

export const DEFAULT_PUSH_SEND_TIMEOUT_MS = 10_000;
export const MIN_PUSH_SEND_TIMEOUT_MS = 1_000;
export const MAX_PUSH_SEND_TIMEOUT_MS = 60_000;

/** Firebase / Google Cloud project id: 6-30 chars, lowercase letters, digits and hyphens, starts with a letter, no trailing hyphen. */
export const FIREBASE_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Environments that serve real users: no implicit or fake push configuration. */
export const DEPLOYED_NODE_ENVS = ['production', 'staging'] as const;

export interface PushDeliveryConfig {
  mode: PushDeliveryMode;
  /** False when PUSH_DELIVERY_MODE was not set (defaulted to disabled). */
  modeExplicit: boolean;
  ttlSeconds: number;
  /** Set (and validated) when mode=firebase; otherwise optional. */
  firebaseProjectId: string | null;
  sendTimeoutMs: number;
}

function integer(config: Pick<ConfigService, 'get'>, key: string, fallback: number, min: number, max: number): number {
  const raw = config.get<string>(key)?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadPushDeliveryConfig(config: Pick<ConfigService, 'get'>): PushDeliveryConfig {
  const nodeEnv = config.get<string>('NODE_ENV')?.trim().toLowerCase() ?? '';
  const deployed = (DEPLOYED_NODE_ENVS as readonly string[]).includes(nodeEnv);
  const raw = config.get<string>('PUSH_DELIVERY_MODE')?.trim().toLowerCase() || '';

  if (!raw && deployed) {
    throw new Error(`PUSH_DELIVERY_MODE must be set explicitly ("firebase" or "disabled") when NODE_ENV=${nodeEnv}`);
  }
  const mode = (raw || 'disabled') as PushDeliveryMode;
  if (!PUSH_DELIVERY_MODES.includes(mode)) {
    throw new Error('PUSH_DELIVERY_MODE must be "disabled", "mock" or "firebase"');
  }
  if (mode === 'mock' && deployed) {
    throw new Error(`PUSH_DELIVERY_MODE=mock is not allowed when NODE_ENV=${nodeEnv}`);
  }

  const firebaseProjectId = config.get<string>('FIREBASE_PROJECT_ID')?.trim() || null;
  if (mode === 'firebase' && !firebaseProjectId) {
    throw new Error('FIREBASE_PROJECT_ID is required when PUSH_DELIVERY_MODE=firebase');
  }
  if (firebaseProjectId && !FIREBASE_PROJECT_ID_PATTERN.test(firebaseProjectId)) {
    throw new Error('FIREBASE_PROJECT_ID is not a valid Firebase project id');
  }

  return {
    mode,
    modeExplicit: Boolean(raw),
    ttlSeconds: integer(config, 'PUSH_DELIVERY_TTL_SECONDS', DEFAULT_PUSH_DELIVERY_TTL_SECONDS, MIN_PUSH_DELIVERY_TTL_SECONDS, MAX_PUSH_DELIVERY_TTL_SECONDS),
    firebaseProjectId,
    sendTimeoutMs: integer(config, 'PUSH_SEND_TIMEOUT_MS', DEFAULT_PUSH_SEND_TIMEOUT_MS, MIN_PUSH_SEND_TIMEOUT_MS, MAX_PUSH_SEND_TIMEOUT_MS),
  };
}
