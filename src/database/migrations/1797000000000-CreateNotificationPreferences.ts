import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * P3-BE07-02: user-level push preference (`notification_preferences`).
 *
 * Additive: one new table, no change to existing tables or rows. No backfill:
 * a missing row means push OFF (the approved default), so every existing
 * account is unaffected. `down` drops the table (all users fall back to OFF).
 */
export class CreateNotificationPreferences1797000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'notification_preferences',
        columns: [
          { name: 'user_id', type: 'bigint', isPrimary: true, primaryKeyConstraintName: 'pk_notification_preferences' },
          { name: 'push_enabled', type: 'boolean', isNullable: false, default: false },
          { name: 'push_enabled_at', type: 'timestamptz', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [{ name: 'chk_notification_preferences_push_enabled_at', expression: `"push_enabled" = ("push_enabled_at" IS NOT NULL)` }],
        foreignKeys: [
          {
            name: 'fk_notification_preferences_user',
            columnNames: ['user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_preferences"`);
  }
}
