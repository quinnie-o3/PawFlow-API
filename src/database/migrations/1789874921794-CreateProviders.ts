import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateProviders1789874921794 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'providers',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'owner_id',
            type: 'bigint',
            isNullable: false,
            isUnique: true,
          },
          {
            name: 'business_name',
            type: 'varchar',
            length: '200',
            isNullable: false,
          },
          {
            name: 'address',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'phone',
            type: 'varchar',
            length: '20',
            isNullable: true,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'approval_status',
            type: 'varchar',
            length: '20',
            isNullable: false,
            default: "'PENDING'",
          },
          {
            name: 'rating_avg',
            type: 'numeric',
            precision: 3,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'rating_count',
            type: 'integer',
            isNullable: false,
            default: '0',
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
        ],
        checks: [
          {
            name: 'chk_provider_approval',
            expression:
              `"approval_status" IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')`,
          },
          {
            name: 'chk_provider_rating_avg',
            expression: `"rating_avg" >= 0 AND "rating_avg" <= 5`,
          },
          {
            name: 'chk_provider_rating_count',
            expression: `"rating_count" >= 0`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_providers_owner',
            columnNames: ['owner_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'provider_staff',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'provider_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'user_id',
            type: 'bigint',
            isNullable: false,
            isUnique: true,
          },
          {
            name: 'position',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'status',
            type: 'varchar',
            length: '20',
            isNullable: false,
            default: "'ACTIVE'",
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
        ],
        checks: [
          {
            name: 'chk_provider_staff_status',
            expression: `"status" IN ('ACTIVE', 'INACTIVE')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_provider_staff_provider',
            columnNames: ['provider_id'],
            referencedTableName: 'providers',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            name: 'fk_provider_staff_user',
            columnNames: ['user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'provider_working_hours',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'provider_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'day_of_week',
            type: 'smallint',
            isNullable: false,
          },
          {
            name: 'start_time',
            type: 'time',
            isNullable: false,
          },
          {
            name: 'end_time',
            type: 'time',
            isNullable: false,
          },
          {
            name: 'is_active',
            type: 'boolean',
            isNullable: false,
            default: 'true',
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
        ],
        checks: [
          {
            name: 'chk_working_hours_day',
            expression: `"day_of_week" BETWEEN 0 AND 6`,
          },
          {
            name: 'chk_working_hours_time',
            expression: `"start_time" < "end_time"`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_working_hours_provider',
            columnNames: ['provider_id'],
            referencedTableName: 'providers',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
        uniques: [
          {
            name: 'uq_provider_working_hours',
            columnNames: ['provider_id', 'day_of_week', 'start_time', 'end_time'],
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'providers',
      new TableIndex({
        name: 'idx_providers_approval_status',
        columnNames: ['approval_status'],
      }),
    );

    await queryRunner.createIndex(
      'provider_staff',
      new TableIndex({
        name: 'idx_provider_staff_provider',
        columnNames: ['provider_id'],
      }),
    );

    await queryRunner.createIndex(
      'provider_working_hours',
      new TableIndex({
        name: 'idx_working_hours_provider',
        columnNames: ['provider_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('provider_working_hours', true);
    await queryRunner.dropTable('provider_staff', true);
    await queryRunner.dropTable('providers', true);
  }

}
