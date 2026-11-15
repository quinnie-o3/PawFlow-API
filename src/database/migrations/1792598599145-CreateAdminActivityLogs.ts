import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAdminActivityLogs1792598599145
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'admin_activity_logs',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'admin_user_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'action',
            type: 'varchar',
            length: '64',
            isNullable: false,
          },
          {
            name: 'target_type',
            type: 'varchar',
            length: '32',
            isNullable: false,
          },
          {
            name: 'target_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'metadata',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
        ],
        foreignKeys: [
          {
            name: 'fk_admin_activity_logs_admin_user',
            columnNames: ['admin_user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
        ],
      }),
    );

    const activityLogIndexes: Array<[string, string[]]> = [
      ['idx_admin_activity_logs_created_at', ['created_at']],
      [
        'idx_admin_activity_logs_admin_created_at',
        ['admin_user_id', 'created_at'],
      ],
      [
        'idx_admin_activity_logs_target_created_at',
        ['target_type', 'target_id', 'created_at'],
      ],
      ['idx_admin_activity_logs_action_created_at', ['action', 'created_at']],
    ];

    for (const [name, columnNames] of activityLogIndexes) {
      await queryRunner.createIndex(
        'admin_activity_logs',
        new TableIndex({ name, columnNames }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('admin_activity_logs', true);
  }
}
