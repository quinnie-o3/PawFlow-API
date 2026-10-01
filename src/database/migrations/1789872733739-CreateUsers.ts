import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateUsers1789872733739 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'full_name',
            type: 'varchar',
            length: '150',
            isNullable: false,
          },
          {
            name: 'email',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'phone',
            type: 'varchar',
            length: '20',
            isNullable: true,
          },
          {
            name: 'password_hash',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'role',
            type: 'varchar',
            length: '30',
            isNullable: false,
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
            name: 'chk_users_role',
            expression:
              `"role" IN ('CUSTOMER', 'PROVIDER_OWNER', 'PROVIDER_STAFF', 'ADMIN')`,
          },
          {
            name: 'chk_users_status',
            expression: `"status" IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')`,
          },
        ],
      }),
    );

    await queryRunner.query(
      'CREATE UNIQUE INDEX "uq_users_email_lower" ON "users" (LOWER("email"))',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('users', true);
  }
}
