import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

const P3_BE01_REASONS = `'LOGOUT', 'LOGOUT_ALL', 'SESSION_REVOKED', 'REUSE_DETECTED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_INACTIVE'`;
const P3_BE02_REASONS = `${P3_BE01_REASONS}, 'PASSWORD_CHANGED', 'PASSWORD_RESET'`;

/**
 * P3-BE02: password change / reset and e-mail verification.
 *
 * - `users.email_verified_at` (nullable). Existing accounts are NOT
 *   backfilled: they stay unverified (NULL), and nothing in the application
 *   restricts unverified accounts, so their login, sessions and bookings are
 *   unaffected.
 * - `auth_user_tokens`: one-time password-reset / e-mail-verification tokens.
 *   Only the SHA-256 hash is stored; at most one usable (not consumed, not
 *   revoked) token per user and purpose (partial unique index).
 * - `auth_sessions.revoked_reason` additionally accepts PASSWORD_CHANGED and
 *   PASSWORD_RESET.
 *
 * Additive only. `down` drops the token table and the column (outstanding
 * reset/verification links and verification state are lost) and maps the two
 * new revoke reasons to LOGOUT_ALL so the P3-BE01 CHECK can be restored.
 */
export class AddAccountRecovery1794690000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamptz NULL`);

    await queryRunner.query(`ALTER TABLE "auth_sessions" DROP CONSTRAINT "chk_auth_sessions_revoked_reason"`);
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD CONSTRAINT "chk_auth_sessions_revoked_reason" CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN (${P3_BE02_REASONS}))`,
    );

    await queryRunner.createTable(
      new Table({
        name: 'auth_user_tokens',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'user_id', type: 'bigint', isNullable: false },
          { name: 'purpose', type: 'varchar', length: '32', isNullable: false },
          { name: 'token_hash', type: 'varchar', length: '64', isNullable: false },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'expires_at', type: 'timestamptz', isNullable: false },
          { name: 'consumed_at', type: 'timestamptz', isNullable: true },
          { name: 'revoked_at', type: 'timestamptz', isNullable: true },
        ],
        uniques: [{ name: 'uq_auth_user_tokens_hash', columnNames: ['token_hash'] }],
        checks: [
          {
            name: 'chk_auth_user_tokens_purpose',
            expression: `"purpose" IN ('PASSWORD_RESET', 'EMAIL_VERIFICATION')`,
          },
          { name: 'chk_auth_user_tokens_hash', expression: `"token_hash" ~ '^[0-9a-f]{64}$'` },
          { name: 'chk_auth_user_tokens_expiry', expression: `"expires_at" > "created_at"` },
          {
            name: 'chk_auth_user_tokens_final_state',
            expression: `"consumed_at" IS NULL OR "revoked_at" IS NULL`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_auth_user_tokens_user',
            columnNames: ['user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );
    await queryRunner.createIndex(
      'auth_user_tokens',
      new TableIndex({ name: 'idx_auth_user_tokens_user', columnNames: ['user_id'] }),
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_auth_user_tokens_active" ON "auth_user_tokens" ("user_id", "purpose") WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('auth_user_tokens', true);

    await queryRunner.query(
      `UPDATE "auth_sessions" SET "revoked_reason" = 'LOGOUT_ALL' WHERE "revoked_reason" IN ('PASSWORD_CHANGED', 'PASSWORD_RESET')`,
    );
    await queryRunner.query(`ALTER TABLE "auth_sessions" DROP CONSTRAINT "chk_auth_sessions_revoked_reason"`);
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD CONSTRAINT "chk_auth_sessions_revoked_reason" CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN (${P3_BE01_REASONS}))`,
    );

    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email_verified_at"`);
  }
}
