/**
 * P3-BE09 safe logging policy.
 *
 * 1. Structured event fields go through a strict ALLOWLIST: each permitted
 *    key has a validator for its type, range and character set; unknown keys
 *    and invalid values are dropped, never serialized. Nothing logs request
 *    or response bodies, headers, query strings, raw URLs or DTOs.
 * 2. Free-text messages (existing `Logger` lines) are made single-line,
 *    bounded, and scrubbed of recognizable credentials and contact data.
 *    This is defense in depth only: pattern matching cannot reliably find
 *    every secret, so the primary guarantee is that code never puts secrets
 *    or PII into log messages in the first place.
 */

export const MAX_MESSAGE_LENGTH = 512;

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,4}$/;
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const DB_CODE_PATTERN = /^[0-9A-Z]{5}$/;
const CONTEXT_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ROUTE_PATTERN = /^\/[\x21-\x7e]{0,199}$/;
const ENUM_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9/._:-]{1,60}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Rule = (value: unknown) => unknown;

const pattern =
  (re: RegExp): Rule =>
  (value) =>
    typeof value === 'string' && re.test(value) ? value : undefined;

const integer =
  (min: number, max: number): Rule =>
  (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? value
      : undefined;

const duration: Rule = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : undefined;

const id: Rule = (value) =>
  (typeof value === 'string' || typeof value === 'number') && ID_PATTERN.test(String(value))
    ? String(value)
    : undefined;

/** The only event fields that can ever reach a log line. */
const FIELD_RULES: Readonly<Record<string, Rule>> = {
  method: (value) => (typeof value === 'string' && HTTP_METHODS.has(value) ? value : undefined),
  route: pattern(ROUTE_PATTERN),
  statusCode: integer(100, 599),
  durationMs: duration,
  errorCode: pattern(ERROR_CODE_PATTERN),
  errorName: pattern(ERROR_NAME_PATTERN),
  dbCode: pattern(DB_CODE_PATTERN),
  notificationId: id,
  attempt: integer(0, 1_000_000),
  outcome: pattern(ENUM_PATTERN),
  state: pattern(ENUM_PATTERN),
  category: pattern(ENUM_PATTERN),
  code: pattern(PROVIDER_CODE_PATTERN),
  retryDelayMs: integer(0, 1_000_000_000),
};

export const ALLOWED_EVENT_FIELDS: readonly string[] = Object.keys(FIELD_RULES);

/** Allowlisted, validated copy of `fields` (fixed key order, unknown keys dropped). */
export function sanitizeEventFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(FIELD_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const value = rule(fields[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function safeEventName(value: unknown): string | undefined {
  return typeof value === 'string' && EVENT_NAME_PATTERN.test(value) ? value : undefined;
}

export function safeContextName(value: unknown): string | undefined {
  return typeof value === 'string' && CONTEXT_PATTERN.test(value) ? value : undefined;
}

export function safeJobId(value: unknown): string | undefined {
  return id(value) as string | undefined;
}

// Ordered: credentials first, so later rules never see a partially masked secret.
const SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [
    /\b(password|passwd|pwd|secret|token|refresh_?token|access_?token|authorization|cookie|api[_-]?key|private_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '$1$2[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/(?<![A-Za-z0-9])(\+84|0084|0)\d{9}(?![A-Za-z0-9])/g, '[phone]'],
  // Long opaque strings (FCM registration tokens, API keys, raw hashes).
  [/[A-Za-z0-9_:-]{40,}/g, '[opaque]'],
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Single-line, scrubbed, length-bounded text for a log message. */
export function sanitizeLogText(value: string, maxLength = MAX_MESSAGE_LENGTH): string {
  let text = value.replace(CONTROL_CHARACTERS, ' ');
  for (const [re, replacement] of SCRUBBERS) text = text.replace(re, replacement);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
