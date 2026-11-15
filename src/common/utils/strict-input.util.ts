/**
 * Explicit, narrow input conversions used with `@Transform` now that the
 * global ValidationPipe no longer performs implicit type conversion.
 *
 * Each helper converts only unambiguous representations and returns every
 * other value unchanged, so the field's validators reject it with HTTP 400
 * instead of silently coercing it (e.g. `true` -> 1, `""` -> 0).
 */

const CANONICAL_DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Accepts JSON numbers as-is and canonical decimal strings such as `"5"` or
 * `"12.50"` (query parameters, and clients already sending numeric strings).
 *
 * Booleans, empty or padded strings, exponent notation, arrays and objects
 * are returned unchanged and fail `@IsInt` / `@IsNumber`.
 */
export function toNumberIfNumericString(value: unknown): unknown {
  if (typeof value === 'string' && CANONICAL_DECIMAL_PATTERN.test(value)) {
    return Number(value);
  }

  return value;
}

/**
 * Normalizes a JSON-number identifier to the string form used for
 * PostgreSQL BIGINT IDs. Only positive safe integers are converted, because
 * larger numbers have already lost precision during JSON parsing.
 *
 * Every other value is returned unchanged for `isPostgresBigIntId` to judge.
 */
export function toBigIntIdStringIfSafeInteger(value: unknown): unknown {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }

  return value;
}
