/**
 * Provider review response text rules (P3-BE08, decision D8).
 *
 * Normalization (applied by the DTO before validation, and what is stored):
 * 1. CRLF and lone CR become LF.
 * 2. Leading/trailing whitespace is removed with `String.prototype.trim`
 *    (ECMAScript WhiteSpace + LineTerminator, a superset of ASCII
 *    whitespace). Inner whitespace and all other characters are preserved.
 *
 * Length is counted in Unicode code points (`[...text].length`), which is
 * what PostgreSQL `char_length` counts for UTF-8 text, so the DTO and the
 * `chk_reviews_response_text` constraint agree on every input, including
 * emoji and other astral characters (1 code point each; UTF-16 `.length`
 * would count them as 2). Combining sequences count each code point.
 */
export const REVIEW_RESPONSE_MIN_LENGTH = 1;
export const REVIEW_RESPONSE_MAX_LENGTH = 1000;

/**
 * Database CHECK expressions (P3-BE08, migration 1797500000000). The
 * migration copies these literals, so changing them here requires a new
 * migration.
 *
 * Consistency: no response means text, responder and time are all NULL; a
 * response always has text and time. The responder is set by the API on
 * every response but is NOT required by the constraint, because
 * `fk_reviews_responder ON DELETE SET NULL` must still be able to clear it
 * when a responder account is physically deleted (the response is kept).
 *
 * Text: 1-1000 code points (`char_length`, the same count as the DTO) and
 * no leading/trailing character of `REVIEW_RESPONSE_TRIM_CODE_POINTS`, which
 * is exactly the set `String.prototype.trim` removes (ECMAScript WhiteSpace +
 * LineTerminator: 25 code points, incl. NBSP, U+2000-U+200A, U+3000, BOM).
 * The DB therefore accepts exactly the trimmed values the API produces, and
 * rejects blank text (also Unicode-blank, e.g. only NBSP) from any path.
 * Written with chr() so the expression is ASCII and encoding-independent.
 * (BE08-03 widened this from the 6 ASCII whitespace characters used in
 * BE08-02; the migration was still pending everywhere.)
 */
export const REVIEW_RESPONSE_TRIM_CODE_POINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
] as const;

const TRIM_SET_SQL = REVIEW_RESPONSE_TRIM_CODE_POINTS.map((c) => `chr(${c})`).join(' || ');
export const REVIEW_RESPONSE_CONSISTENCY_CHECK =
  `("provider_response" IS NULL AND "responded_by" IS NULL AND "responded_at" IS NULL) OR ` +
  `("provider_response" IS NOT NULL AND "responded_at" IS NOT NULL)`;

export const REVIEW_RESPONSE_TEXT_CHECK =
  `"provider_response" IS NULL OR (char_length("provider_response") BETWEEN 1 AND 1000 AND ` +
  `"provider_response" = btrim("provider_response", ${TRIM_SET_SQL}))`;

export function normalizeReviewResponseText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/\r\n?/g, '\n').trim();
}

export function codePointLength(value: string): number {
  // String iteration yields code points (surrogate pairs stay together).
  return Array.from(value).length;
}
