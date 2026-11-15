import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateServices1789875356682 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'service_categories',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'name',
            type: 'varchar',
            length: '150',
            isNullable: false,
            isUnique: true,
          },
          {
            name: 'description',
            type: 'text',
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
            name: 'chk_service_categories_status',
            expression: `"status" IN ('ACTIVE', 'INACTIVE')`,
          },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'services',
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
            name: 'category_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '200',
            isNullable: false,
          },
          {
            name: 'price',
            type: 'numeric',
            precision: 12,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'duration_minutes',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
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
            name: 'chk_services_price',
            expression: `"price" >= 0`,
          },
          {
            name: 'chk_services_duration',
            expression: `"duration_minutes" > 0`,
          },
          {
            name: 'chk_services_status',
            expression: `"status" IN ('ACTIVE', 'INACTIVE')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_services_provider',
            columnNames: ['provider_id'],
            referencedTableName: 'providers',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_services_category',
            columnNames: ['category_id'],
            referencedTableName: 'service_categories',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
        ],
        uniques: [
          {
            name: 'uq_services_id_provider',
            columnNames: ['id', 'provider_id'],
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'services',
      new TableIndex({
        name: 'idx_services_provider',
        columnNames: ['provider_id'],
      }),
    );

    await queryRunner.createIndex(
      'services',
      new TableIndex({
        name: 'idx_services_category',
        columnNames: ['category_id'],
      }),
    );

    await queryRunner.createIndex(
      'services',
      new TableIndex({
        name: 'idx_services_status',
        columnNames: ['status'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('services', true);
    await queryRunner.dropTable('service_categories', true);
  }

}
