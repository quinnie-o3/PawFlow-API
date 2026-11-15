import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * P3-BE03: shared fixed-window counters for rate limiting the public
 * authentication endpoints across all backend instances.
 *
 * - `auth_rate_limits (policy, bucket, window_start)` PK; `bucket` is an
 *   HMAC-SHA256 (hex) of the client key (IP or e-mail), never the raw value.
 * - `expires_at` (end of the window) is indexed for the periodic purge.
 *
 * Additive only, no data. `down` drops the table (current counters are
 * lost; limits restart from zero).
 */
export class CreateAuthRateLimits1795000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'auth_rate_limits',
        columns: [
          { name: 'policy', type: 'varchar', length: '32', isPrimary: true },
          { name: 'bucket', type: 'varchar', length: '64', isPrimary: true },
          { name: 'window_start', type: 'timestamptz', isPrimary: true },
          { name: 'hits', type: 'integer', isNullable: false },
          { name: 'expires_at', type: 'timestamptz', isNullable: false },
        ],
        checks: [
          { name: 'chk_auth_rate_limits_bucket', expression: `"bucket" ~ '^[0-9a-f]{64}$'` },
          { name: 'chk_auth_rate_limits_hits', expression: `"hits" > 0` },
          { name: 'chk_auth_rate_limits_window', expression: `"expires_at" > "window_start"` },
        ],
      }),
    );
    await queryRunner.createIndex(
      'auth_rate_limits',
      new TableIndex({ name: 'idx_auth_rate_limits_expires', columnNames: ['expires_at'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('auth_rate_limits', true);
  }
}
