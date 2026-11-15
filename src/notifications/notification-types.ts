/**
 * P3-BE04 notification catalogue.
 *
 * Types are stable identifiers aligned with the existing workflows
 * (booking lifecycle, payments, reviews, complaints, provider approval).
 * They are stored as text with a CHECK constraint; adding a type needs a
 * migration that extends `chk_notifications_type`.
 *
 * A notification may point at ONE business record (`target`). The target
 * is navigation metadata only: it never grants access. The client opens
 * the record through its normal endpoint, which applies its own
 * authorization (and may answer 404 if access was lost or the record no
 * longer exists). No URL is ever stored or returned.
 */
export const NOTIFICATION_TARGET_TYPES = ['BOOKING', 'COMPLAINT', 'REVIEW', 'PROVIDER'] as const;
export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

/** type -> the only target type it may point at (null = no target allowed). */
export const NOTIFICATION_TYPE_TARGETS = {
  BOOKING_CREATED: 'BOOKING',
  BOOKING_CONFIRMED: 'BOOKING',
  BOOKING_REJECTED: 'BOOKING',
  BOOKING_CANCELLED: 'BOOKING',
  BOOKING_COMPLETED: 'BOOKING',
  BOOKING_NO_SHOW: 'BOOKING',
  PAYMENT_STATUS_CHANGED: 'BOOKING',
  REVIEW_RECEIVED: 'REVIEW',
  COMPLAINT_CREATED: 'COMPLAINT',
  COMPLAINT_STATUS_CHANGED: 'COMPLAINT',
  PROVIDER_APPROVED: 'PROVIDER',
  PROVIDER_REJECTED: 'PROVIDER',
  PROVIDER_SUSPENDED: 'PROVIDER',
  SYSTEM_ANNOUNCEMENT: null,
} as const satisfies Record<string, NotificationTargetType | null>;

export type NotificationType = keyof typeof NOTIFICATION_TYPE_TARGETS;
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPE_TARGETS) as NotificationType[];

export const NOTIFICATION_TITLE_MAX_LENGTH = 150;
export const NOTIFICATION_BODY_MAX_LENGTH = 1000;
export const NOTIFICATION_EVENT_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,200}$/;
export const NOTIFICATION_PAYLOAD_MAX_KEYS = 20;
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 4096;
export const NOTIFICATION_PAYLOAD_STRING_MAX_LENGTH = 300;

const PAYLOAD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** Keys that suggest secrets, credentials, links or contact PII are refused outright. */
const FORBIDDEN_PAYLOAD_KEY = /password|passwd|token|secret|otp|credential|session|cookie|auth|link|url|href|email|phone|address/i;
/** No URLs in payload values: "scheme://…", "www.…", or script/data/contact schemes. Plain "Reason: …" text is fine. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:javascript|data|vbscript|file|mailto|tel|sms):)/i;
const BIGINT_ID = /^[1-9]\d{0,18}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type NotificationPayloadValue = string | number | boolean | null;
export type NotificationPayload = Record<string, NotificationPayloadValue>;

export interface NotificationTarget {
  type: NotificationTargetType;
  id: string;
}

/** Input accepted by NotificationsService.create (internal use only). */
export interface CreateNotificationInput {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Small flat display data (e.g. service name, start time). No URLs, secrets or contact data. */
  payload?: NotificationPayload;
  target?: NotificationTarget | null;
  /**
   * Idempotency key, unique per recipient (e.g. `booking:42:CONFIRMED`).
   * Re-delivering the same event returns the existing notification.
   */
  eventKey?: string | null;
}

/** A programming error in the caller's input (never caused by an end user). */
export class NotificationInputError extends Error {
  constructor(message: string) {
    super(`Invalid notification: ${message}`);
    this.name = 'NotificationInputError';
  }
}

function checkText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new NotificationInputError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new NotificationInputError(`${field} must not be empty`);
  if (trimmed.length > max) throw new NotificationInputError(`${field} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(trimmed)) throw new NotificationInputError(`${field} must not contain control characters`);
  return trimmed;
}

export interface NormalizedNotificationInput {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: NotificationPayload;
  targetType: NotificationTargetType | null;
  targetId: string | null;
  eventKey: string | null;
}

/** Validates and normalizes internal input; throws NotificationInputError. */
export function normalizeNotificationInput(input: CreateNotificationInput): NormalizedNotificationInput {
  if (typeof input !== 'object' || input === null) throw new NotificationInputError('input must be an object');

  if (typeof input.recipientUserId !== 'string' || !BIGINT_ID.test(input.recipientUserId)) {
    throw new NotificationInputError('recipientUserId must be a positive BIGINT id string');
  }
  if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPE_TARGETS, input.type)) {
    throw new NotificationInputError(`unknown type "${String(input.type)}"`);
  }

  const title = checkText(input.title, 'title', NOTIFICATION_TITLE_MAX_LENGTH);
  const body = checkText(input.body, 'body', NOTIFICATION_BODY_MAX_LENGTH);

  const allowedTarget = NOTIFICATION_TYPE_TARGETS[input.type];
  let targetType: NotificationTargetType | null = null;
  let targetId: string | null = null;
  if (input.target !== undefined && input.target !== null) {
    if (allowedTarget === null) throw new NotificationInputError(`${input.type} cannot have a target`);
    if (input.target.type !== allowedTarget) {
      throw new NotificationInputError(`${input.type} can only target ${allowedTarget}`);
    }
    if (typeof input.target.id !== 'string' || !BIGINT_ID.test(input.target.id)) {
      throw new NotificationInputError('target.id must be a positive BIGINT id string');
    }
    targetType = input.target.type;
    targetId = input.target.id;
  }

  let eventKey: string | null = null;
  if (input.eventKey !== undefined && input.eventKey !== null) {
    if (typeof input.eventKey !== 'string' || !NOTIFICATION_EVENT_KEY_PATTERN.test(input.eventKey)) {
      throw new NotificationInputError('eventKey must match [A-Za-z0-9:._-]{1,200}');
    }
    eventKey = input.eventKey;
  }

  const payload: NotificationPayload = {};
  const raw = input.payload ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new NotificationInputError('payload must be a plain object');
  }
  const entries = Object.entries(raw);
  if (entries.length > NOTIFICATION_PAYLOAD_MAX_KEYS) {
    throw new NotificationInputError(`payload must have at most ${NOTIFICATION_PAYLOAD_MAX_KEYS} keys`);
  }
  for (const [key, value] of entries) {
    if (!PAYLOAD_KEY_PATTERN.test(key)) throw new NotificationInputError(`payload key "${key}" is not allowed`);
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) throw new NotificationInputError(`payload key "${key}" may carry sensitive data`);
    if (value === null || typeof value === 'boolean') {
      payload[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new NotificationInputError(`payload.${key} must be a finite number`);
      payload[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > NOTIFICATION_PAYLOAD_STRING_MAX_LENGTH) throw new NotificationInputError(`payload.${key} is too long`);
      if (CONTROL_CHARS.test(value)) throw new NotificationInputError(`payload.${key} must not contain control characters`);
      if (URL_LIKE.test(value.trim())) throw new NotificationInputError(`payload.${key} must not be a URL`);
      payload[key] = value;
    } else {
      throw new NotificationInputError(`payload.${key} must be a string, number, boolean or null (no nesting)`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > NOTIFICATION_PAYLOAD_MAX_BYTES) {
    throw new NotificationInputError(`payload must be at most ${NOTIFICATION_PAYLOAD_MAX_BYTES} bytes`);
  }

  return { recipientUserId: input.recipientUserId, type: input.type, title, body, payload, targetType, targetId, eventKey };
}
