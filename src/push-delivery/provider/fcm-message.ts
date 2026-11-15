import type { Message } from 'firebase-admin/messaging';

import { NOTIFICATION_TARGET_TYPES, NOTIFICATION_TYPES } from '../../notifications/notification-types';
import { REGISTRATION_KINDS, REGISTRATION_VALUE_PATTERNS } from '../../push-devices/push-device-types';
import { MAX_PUSH_DELIVERY_TTL_SECONDS } from '../push-delivery.config';
import type { PushDestination, PushMessage } from './push-provider.types';

/** FCM limit for a message's notification + data payload. */
export const FCM_MAX_PAYLOAD_BYTES = 4096;
export const MAX_EXTRA_DATA_KEYS = 8;
export const MAX_DATA_VALUE_LENGTH = 300;
const TITLE_MAX = 150;
const BODY_MAX = 1000;

const BIGINT_ID = /^[1-9]\d{0,18}$/;
const DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** FCM reserved data keys: `from`, `notification`, `message_type`, `collapse_key`, and any key starting with `google` or `gcm`. */
const RESERVED_DATA_KEY = /^(from|notification|message_type|collapse_key)$|^(google|gcm)/i;
/** Keys the builder sets itself. */
const OWN_DATA_KEYS = new Set(['notificationId', 'type', 'targetType', 'targetId']);
/** Keys that suggest secrets, credentials, links, contact data or free-text reasons. */
const SENSITIVE_DATA_KEY = /password|passwd|token|secret|otp|credential|session|cookie|auth|link|url|href|email|phone|address|reason|note/i;
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|^(?:javascript|data|vbscript|file|mailto|tel|sms):)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type BuildResult = { ok: true; message: Message; payloadBytes: number } | { ok: false; outcome: 'INVALID_PAYLOAD' | 'INVALID_REQUEST'; code: string };

const invalid = (code: string): BuildResult => ({ ok: false, outcome: 'INVALID_PAYLOAD', code: `pawflow/${code}` });

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length >= 1 && t.length <= max && !CONTROL_CHARS.test(t) ? t : null;
}

/**
 * Validates a destination + message and builds the exact FCM HTTP v1 message.
 * Nothing is sent. Every `data` value is a string. The display tag / APNs
 * collapse id `pawflow-<notificationId>` makes a re-sent (at-least-once)
 * push replace the earlier one on the device instead of stacking.
 */
export function buildFcmMessage(destination: PushDestination, message: PushMessage, now: number = Date.now()): BuildResult {
  if (!destination || !(REGISTRATION_KINDS as readonly string[]).includes(destination.kind) || typeof destination.value !== 'string' || !REGISTRATION_VALUE_PATTERNS[destination.kind].test(destination.value)) {
    // Caller error (a malformed or mislabelled destination): not proof the device is gone.
    return { ok: false, outcome: 'INVALID_REQUEST', code: 'pawflow/invalid-destination-format' };
  }
  if (!message || typeof message !== 'object') return invalid('invalid-message');
  if (typeof message.notificationId !== 'string' || !BIGINT_ID.test(message.notificationId)) return invalid('invalid-notification-id');
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(message.type)) return invalid('invalid-notification-type');
  const title = text(message.title, TITLE_MAX);
  const body = text(message.body, BODY_MAX);
  if (!title || !body) return invalid('invalid-title-or-body');

  const data: Record<string, string> = { notificationId: message.notificationId, type: message.type };
  if (message.target !== null && message.target !== undefined) {
    const t = message.target;
    if (!(NOTIFICATION_TARGET_TYPES as readonly string[]).includes(t.type) || typeof t.id !== 'string' || !BIGINT_ID.test(t.id)) return invalid('invalid-target');
    data.targetType = t.type;
    data.targetId = t.id;
  }

  if (message.data !== undefined) {
    if (typeof message.data !== 'object' || message.data === null || Array.isArray(message.data)) return invalid('invalid-data');
    const entries = Object.entries(message.data);
    if (entries.length > MAX_EXTRA_DATA_KEYS) return invalid('too-many-data-keys');
    for (const [key, value] of entries) {
      if (RESERVED_DATA_KEY.test(key)) return invalid('reserved-data-key');
      if (!DATA_KEY.test(key) || OWN_DATA_KEYS.has(key)) return invalid('invalid-data-key');
      if (SENSITIVE_DATA_KEY.test(key)) return invalid('sensitive-data-key');
      if (typeof value !== 'string') return invalid('non-string-data-value');
      if (value.length > MAX_DATA_VALUE_LENGTH || CONTROL_CHARS.test(value) || URL_LIKE.test(value)) return invalid('invalid-data-value');
      data[key] = value;
    }
  }

  let ttl: number | undefined;
  if (message.ttlSeconds !== undefined) {
    if (!Number.isInteger(message.ttlSeconds) || message.ttlSeconds < 0 || message.ttlSeconds > MAX_PUSH_DELIVERY_TTL_SECONDS) return invalid('invalid-ttl');
    ttl = message.ttlSeconds;
  }

  const notification = { title, body };
  const payloadBytes = Buffer.byteLength(JSON.stringify({ notification, data }), 'utf8');
  if (payloadBytes > FCM_MAX_PAYLOAD_BYTES) return invalid('payload-too-large');

  const tag = `pawflow-${message.notificationId}`;
  const base = {
    notification,
    data,
    android: { ...(ttl !== undefined ? { ttl: ttl * 1000 } : {}), notification: { tag } },
    apns: { headers: { 'apns-collapse-id': tag, ...(ttl !== undefined ? { 'apns-expiration': String(Math.floor(now / 1000) + ttl) } : {}) } },
    webpush: { ...(ttl !== undefined ? { headers: { TTL: String(ttl) } } : {}), notification: { tag } },
  };
  const fcm: Message = destination.kind === 'FID' ? { ...base, fid: destination.value } : { ...base, token: destination.value };
  return { ok: true, message: fcm, payloadBytes };
}
