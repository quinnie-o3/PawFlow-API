import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreatePetTypesAndPets1789873768008 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'pet_types',
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
            length: '100',
            isNullable: false,
            isUnique: true,
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
            name: 'chk_pet_types_status',
            expression: `"status" IN ('ACTIVE', 'INACTIVE')`,
          },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'pets',
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
          },
          {
            name: 'pet_type_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '100',
            isNullable: false,
          },
          {
            name: 'breed',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'birth_date',
            type: 'date',
            isNullable: true,
          },
          {
            name: 'weight',
            type: 'numeric',
            precision: 6,
            scale: 2,
            isNullable: true,
          },
          {
            name: 'health_note',
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
            name: 'chk_pets_weight',
            expression: `"weight" IS NULL OR "weight" > 0`,
          },
          {
            name: 'chk_pets_status',
            expression: `"status" IN ('ACTIVE', 'INACTIVE')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_pets_owner',
            columnNames: ['owner_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_pets_pet_type',
            columnNames: ['pet_type_id'],
            referencedTableName: 'pet_types',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
        ],
        uniques: [
          {
            name: 'uq_pets_id_owner',
            columnNames: ['id', 'owner_id'],
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'pets',
      new TableIndex({
        name: 'idx_pets_owner',
        columnNames: ['owner_id'],
      }),
    );

    await queryRunner.createIndex(
      'pets',
      new TableIndex({
        name: 'idx_pets_type',
        columnNames: ['pet_type_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('pets', true);
    await queryRunner.dropTable('pet_types', true);
  }

}
