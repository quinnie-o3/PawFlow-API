import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3-BE08-02: database backstop for provider review responses.
 *
 * Additive: two CHECK constraints on the existing `reviews` columns
 * `provider_response`, `responded_by`, `responded_at`. No column, index, FK
 * or default changes; no row is modified.
 *
 * - chk_reviews_response_consistency: no response => text, responder and
 *   time all NULL; a response => text and time present. The responder is
 *   deliberately not required, so `fk_reviews_responder ON DELETE SET NULL`
 *   can still clear it when a responder account is deleted (the response
 *   text and time are kept).
 * - chk_reviews_response_text: 1-1000 characters as counted by
 *   `char_length` (Unicode code points, the same rule as the API DTO), with
 *   no leading/trailing character that `String.prototype.trim` removes (the
 *   same 25 code points the API trims).
 *
 * Literals are copied from `src/reviews/review-response-text.ts` at the time
 * of writing; a migration must not depend on code that may change later.
 *
 * Preflight: rows that would violate a constraint abort the migration with
 * a count (no row content), instead of a generic constraint error. The
 * migration runs in a transaction, so nothing is half-applied.
 *
 * Down: drops both constraints. No data is lost; only the backstop goes.
 */
const CONSISTENCY =
  `("provider_response" IS NULL AND "responded_by" IS NULL AND "responded_at" IS NULL) OR ` +
  `("provider_response" IS NOT NULL AND "responded_at" IS NOT NULL)`;

// The 25 code points removed by ECMAScript String.prototype.trim
// (WhiteSpace + LineTerminator). BE08-03 widened this from ASCII whitespace
// only, so Unicode-blank text (e.g. only NBSP) is rejected by the database
// as well; the migration had not been applied to any persistent database.
const TRIM_SET =
  'chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || ' +
  'chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || ' +
  'chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)';

const TEXT =
  `"provider_response" IS NULL OR (char_length("provider_response") BETWEEN 1 AND 1000 AND ` +
  `"provider_response" = btrim("provider_response", ${TRIM_SET}))`;

export class AddReviewResponseConstraints1797500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const [violations] = (await queryRunner.query(
      `SELECT count(*) FILTER (WHERE NOT (${CONSISTENCY}))::int AS inconsistent,
              count(*) FILTER (WHERE NOT (${TEXT}))::int AS invalid_text
         FROM "reviews"`,
    )) as { inconsistent: number; invalid_text: number }[];

    if (violations.inconsistent > 0 || violations.invalid_text > 0) {
      throw new Error(
        `AddReviewResponseConstraints1797500000000 preflight failed: ${violations.inconsistent} review(s) with ` +
          `inconsistent response columns, ${violations.invalid_text} with invalid response text. Fix them and re-run.`,
      );
    }

    await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "chk_reviews_response_consistency" CHECK (${CONSISTENCY})`);
    await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "chk_reviews_response_text" CHECK (${TEXT})`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "chk_reviews_response_text"`);
    await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "chk_reviews_response_consistency"`);
  }
}
