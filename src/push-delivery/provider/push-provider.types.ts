import type { NotificationTargetType, NotificationType } from '../../notifications/notification-types';
import type { RegistrationKind } from '../../push-devices/push-device-types';

/**
 * P3-BE06-04 push provider contract (consumed by the BE06-05 worker).
 *
 * A provider sends ONE message to ONE destination that its caller already
 * selected and checked (P3-BE05 findSendTargets + eligibility re-check). It
 * never reads the database, never decides eligibility and never changes
 * device or job state. `send` never throws: every failure is a typed
 * DeliveryResult.
 */

/** A destination exactly as stored by P3-BE05 (the kinds are never interchangeable). */
export interface PushDestination {
  /** FID -> FCM `fid`; FCM_TOKEN (legacy getToken()) -> FCM `token`. */
  kind: RegistrationKind;
  /** Decrypted registration value. Secret-like: never log, store or return it. */
  value: string;
}

/** Minimal content of one push, taken from the persisted inbox notification. */
export interface PushMessage {
  notificationId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Navigation target (never a URL); null when the notification has none. */
  target: { type: NotificationTargetType; id: string } | null;
  /** Optional extra navigation metadata: string values only, validated (no URLs, secrets or contact data). */
  data?: Readonly<Record<string, string>>;
  /** Optional FCM time-to-live (e.g. the job's remaining delivery window). */
  ttlSeconds?: number;
}

export type DeliveryOutcome =
  | 'ACCEPTED'
  | 'INVALID_DESTINATION'
  | 'TRANSIENT'
  | 'RATE_LIMITED'
  | 'INVALID_PAYLOAD'
  | 'INVALID_REQUEST'
  | 'CONFIGURATION'
  | 'DISABLED';

/**
 * Machine-readable result. `code` is a sanitized provider error code token
 * (e.g. `messaging/server-unavailable`, `pawflow/payload-too-large`), never
 * a message, destination or credential.
 *
 * - ACCEPTED: FCM accepted the message. This is NOT proof of delivery to the
 *   device (it may be offline, the message may expire or be collapsed).
 * - INVALID_DESTINATION: FCM says the FID / token is no longer registered
 *   (UNREGISTERED / UNREGISTERED_FID / 404). The only outcome that justifies
 *   revoking the device (BE06-05 calls markInvalid).
 * - INVALID_REQUEST: generic INVALID_ARGUMENT-style rejection. It may be the
 *   payload OR the destination: never revoke the device on it.
 * - INVALID_PAYLOAD: the message itself is invalid (rejected locally before
 *   any call, or by FCM). Retrying the same content will not help.
 * - RATE_LIMITED: quota exceeded; retry later (>= retryAfterMs when given,
 *   FCM guidance: at least 1 minute).
 * - TRANSIENT: temporary failure. `ambiguous` = FCM may have accepted the
 *   message (timeouts / transport errors / unknown errors), so a retry may
 *   produce a duplicate (de-duplicated on the device by the notification tag).
 * - CONFIGURATION: credentials, project, permission or API problem; affects
 *   every send until an operator fixes it. Never revoke devices on it.
 * - DISABLED: push is disabled by configuration; nothing was sent.
 */
export type DeliveryResult =
  | { outcome: 'ACCEPTED'; providerMessageId: string }
  | { outcome: 'INVALID_DESTINATION'; code: string }
  | { outcome: 'INVALID_REQUEST'; code: string }
  | { outcome: 'INVALID_PAYLOAD'; code: string }
  | { outcome: 'RATE_LIMITED'; code: string; retryAfterMs: number | null }
  | { outcome: 'TRANSIENT'; code: string; ambiguous: boolean; retryAfterMs: number | null }
  | { outcome: 'CONFIGURATION'; code: string }
  | { outcome: 'DISABLED' };

export interface PushProvider {
  readonly name: 'disabled' | 'mock' | 'firebase';
  send(destination: PushDestination, message: PushMessage): Promise<DeliveryResult>;
}

/** Nest injection token of the configured PushProvider. */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
