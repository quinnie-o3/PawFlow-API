import type { DeliveryResult } from './push-provider.types';

type FailureResult = Exclude<DeliveryResult, { outcome: 'ACCEPTED' } | { outcome: 'DISABLED' }>;

/**
 * Firebase Admin SDK (v14) error code -> delivery outcome.
 * Codes are `messaging/<code>` (FirebaseMessagingError) or `app/<code>`
 * (FirebaseAppError: credentials, transport). Server codes are mapped by the
 * SDK (lib/messaging/error.js MESSAGING_SERVER_TO_CLIENT_CODE), e.g.
 * UNREGISTERED -> registration-token-not-registered, UNREGISTERED_FID ->
 * installation-id-not-registered, QUOTA_EXCEEDED -> message-rate-exceeded,
 * SENDER_ID_MISMATCH / PERMISSION_DENIED -> mismatched-credential,
 * UNAUTHENTICATED / APNS_AUTH_ERROR -> third-party-auth-error.
 */
const TABLE: Record<string, FailureResult['outcome'] | 'TRANSIENT_CLEAR' | 'TRANSIENT_AMBIGUOUS'> = {
  // The destination is gone: the only reason to revoke a device.
  'messaging/registration-token-not-registered': 'INVALID_DESTINATION',
  'messaging/installation-id-not-registered': 'INVALID_DESTINATION',
  // Generic invalid request: payload OR destination; never revoke.
  'messaging/invalid-argument': 'INVALID_REQUEST',
  'messaging/invalid-recipient': 'INVALID_REQUEST',
  'messaging/invalid-registration-token': 'INVALID_REQUEST',
  'messaging/invalid-package-name': 'INVALID_REQUEST',
  // The message itself.
  'messaging/invalid-payload': 'INVALID_PAYLOAD',
  'messaging/invalid-data-payload-key': 'INVALID_PAYLOAD',
  'messaging/payload-size-limit-exceeded': 'INVALID_PAYLOAD',
  'messaging/invalid-options': 'INVALID_PAYLOAD',
  // Quota.
  'messaging/message-rate-exceeded': 'RATE_LIMITED',
  'messaging/device-message-rate-exceeded': 'RATE_LIMITED',
  'messaging/topics-message-rate-exceeded': 'RATE_LIMITED',
  // FCM answered with an error: not accepted, safe to retry.
  'messaging/server-unavailable': 'TRANSIENT_CLEAR',
  'messaging/internal-error': 'TRANSIENT_CLEAR',
  // No (complete) answer: FCM may have accepted the message.
  'app/network-timeout': 'TRANSIENT_AMBIGUOUS',
  'app/network-error': 'TRANSIENT_AMBIGUOUS',
  'pawflow/send-timeout': 'TRANSIENT_AMBIGUOUS',
  'messaging/unknown-error': 'TRANSIENT_AMBIGUOUS',
  'app/internal-error': 'TRANSIENT_AMBIGUOUS',
  'app/unable-to-parse-response': 'TRANSIENT_AMBIGUOUS',
  // Credentials, project, permission, APNs/web-push credentials, app setup.
  'messaging/mismatched-credential': 'CONFIGURATION',
  'messaging/third-party-auth-error': 'CONFIGURATION',
  'messaging/authentication-error': 'CONFIGURATION',
  'app/invalid-credential': 'CONFIGURATION',
  'app/invalid-app-options': 'CONFIGURATION',
  'app/no-app': 'CONFIGURATION',
  'app/app-deleted': 'CONFIGURATION',
  'app/duplicate-app': 'CONFIGURATION',
  'app/invalid-app-name': 'CONFIGURATION',
  'pawflow/firebase-app-conflict': 'CONFIGURATION',
  'pawflow/firebase-init-failed': 'CONFIGURATION',
};

const SAFE_CODE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,60}$/;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'pawflow/unknown-error';
  const raw = (error as { code?: unknown }).code ?? (error as { errorInfo?: { code?: unknown } }).errorInfo?.code;
  if (typeof raw !== 'string') return 'pawflow/unknown-error';
  const code = (raw.includes('/') ? raw : `messaging/${raw}`).toLowerCase();
  return SAFE_CODE.test(code) ? code : 'pawflow/unknown-error';
}

/** Retry-After (seconds or HTTP date) from the SDK error's HTTP response, if any. */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | null {
  const headers = (error as { httpResponse?: { headers?: Record<string, unknown> } } | null)?.httpResponse?.headers;
  if (!headers || typeof headers !== 'object') return null;
  const value = headers['retry-after'] ?? headers['Retry-After'];
  const s = Array.isArray(value) ? value[0] : value;
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const str = String(s).trim();
  let ms: number;
  if (/^\d+$/.test(str)) ms = Number(str) * 1000;
  else {
    const at = Date.parse(str);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

/**
 * Classifies any error thrown by `messaging.send()` (or by app
 * initialization). Unknown codes and non-Firebase errors are treated
 * conservatively: TRANSIENT + ambiguous (retry later, never revoke).
 * The returned code is sanitized; error messages are never returned.
 */
export function classifyFirebaseError(error: unknown, now: number = Date.now()): FailureResult {
  const code = codeOf(error);
  const kind = TABLE[code];
  switch (kind) {
    case 'INVALID_DESTINATION':
    case 'INVALID_REQUEST':
    case 'INVALID_PAYLOAD':
    case 'CONFIGURATION':
      return { outcome: kind, code };
    case 'RATE_LIMITED':
      return { outcome: 'RATE_LIMITED', code, retryAfterMs: retryAfterMs(error, now) };
    case 'TRANSIENT_CLEAR':
      return { outcome: 'TRANSIENT', code, ambiguous: false, retryAfterMs: retryAfterMs(error, now) };
    default:
      return { outcome: 'TRANSIENT', code, ambiguous: true, retryAfterMs: retryAfterMs(error, now) };
  }
}
