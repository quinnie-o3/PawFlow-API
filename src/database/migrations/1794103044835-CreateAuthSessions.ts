import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * P3-BE01: refresh sessions.
 *
 * - `auth_sessions`: one row per login (device). Access tokens carry the
 *   session id (`sid`) and are rejected as soon as the session is revoked
 *   or expired. `expires_at` is absolute: rotation does not extend it.
 * - `auth_refresh_tokens`: the rotation chain of a session. Only the
 *   SHA-256 hash of each opaque token is stored. A token is valid once;
 *   presenting an already used token (`used_at` set) is reuse and revokes
 *   the whole session.
 * - Deleting a user deletes its sessions and tokens (CASCADE).
 */
export class CreateAuthSessions1794103044835 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'auth_sessions',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true },
          { name: 'user_id', type: 'bigint', isNullable: false },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'last_used_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'expires_at', type: 'timestamptz', isNullable: false },
          { name: 'revoked_at', type: 'timestamptz', isNullable: true },
          { name: 'revoked_reason', type: 'varchar', length: '32', isNullable: true },
          { name: 'user_agent', type: 'varchar', length: '255', isNullable: true },
          { name: 'ip_address', type: 'varchar', length: '45', isNullable: true },
        ],
        checks: [
          {
            name: 'chk_auth_sessions_revoked_reason',
            expression: `"revoked_reason" IS NULL OR "revoked_reason" IN ('LOGOUT', 'LOGOUT_ALL', 'SESSION_REVOKED', 'REUSE_DETECTED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_INACTIVE')`,
          },
          {
            name: 'chk_auth_sessions_revocation',
            expression: `("revoked_at" IS NULL) = ("revoked_reason" IS NULL)`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_auth_sessions_user',
            columnNames: ['user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );
    await queryRunner.createIndex(
      'auth_sessions',
      new TableIndex({ name: 'idx_auth_sessions_user', columnNames: ['user_id'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'auth_refresh_tokens',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'session_id', type: 'uuid', isNullable: false },
          { name: 'token_hash', type: 'varchar', length: '64', isNullable: false },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'used_at', type: 'timestamptz', isNullable: true },
        ],
        uniques: [
          { name: 'uq_auth_refresh_tokens_hash', columnNames: ['token_hash'] },
        ],
        checks: [
          {
            name: 'chk_auth_refresh_tokens_hash',
            expression: `"token_hash" ~ '^[0-9a-f]{64}$'`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_auth_refresh_tokens_session',
            columnNames: ['session_id'],
            referencedTableName: 'auth_sessions',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );
    await queryRunner.createIndex(
      'auth_refresh_tokens',
      new TableIndex({ name: 'idx_auth_refresh_tokens_session', columnNames: ['session_id'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('auth_refresh_tokens', true);
    await queryRunner.dropTable('auth_sessions', true);
  }
}
