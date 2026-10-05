import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreatePaymentsAndFeedback1789876572501 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'payments',
        columns: [
          {
            name: 'id', type: 'bigint', isPrimary: true, isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'booking_id', type: 'bigint', isNullable: false, isUnique: true },
          {
            name: 'amount', type: 'numeric', precision: 12, scale: 2,
            isNullable: false,
          },
          { name: 'method', type: 'varchar', length: '30', isNullable: true },
          {
            name: 'payment_status', type: 'varchar', length: '20', isNullable: false,
            default: "'UNPAID'",
          },
          { name: 'paid_at', type: 'timestamptz', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [
          { name: 'chk_payments_amount', expression: `"amount" >= 0` },
          {
            name: 'chk_payments_method',
            expression: `"method" IS NULL OR "method" IN ('CASH', 'QR', 'BANK_TRANSFER', 'OTHER')`,
          },
          {
            name: 'chk_payments_status',
            expression: `"payment_status" IN ('UNPAID', 'PAID', 'FAILED')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_payments_booking',
            columnNames: ['booking_id'],
            referencedTableName: 'bookings',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
        ],
      }),
    );
    await queryRunner.createIndex(
      'payments', new TableIndex({ name: 'idx_payments_status', columnNames: ['payment_status'] }),
    );
    await queryRunner.createIndex(
      'payments', new TableIndex({ name: 'idx_payments_paid_at', columnNames: ['paid_at'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'reviews',
        columns: [
          {
            name: 'id', type: 'bigint', isPrimary: true, isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'booking_id', type: 'bigint', isNullable: false, isUnique: true },
          { name: 'rating', type: 'smallint', isNullable: false },
          { name: 'comment', type: 'text', isNullable: true },
          { name: 'provider_response', type: 'text', isNullable: true },
          { name: 'responded_by', type: 'bigint', isNullable: true },
          { name: 'responded_at', type: 'timestamptz', isNullable: true },
          { name: 'is_visible', type: 'boolean', isNullable: false, default: 'true' },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [
          { name: 'chk_reviews_rating', expression: `"rating" BETWEEN 1 AND 5` },
        ],
        foreignKeys: [
          {
            name: 'fk_reviews_booking',
            columnNames: ['booking_id'],
            referencedTableName: 'bookings',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_reviews_responder',
            columnNames: ['responded_by'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
    );
    await queryRunner.createIndex(
      'reviews', new TableIndex({ name: 'idx_reviews_created_at', columnNames: ['created_at'] }),
    );
    await queryRunner.createIndex(
      'reviews', new TableIndex({ name: 'idx_reviews_visible', columnNames: ['is_visible'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'complaints',
        columns: [
          {
            name: 'id', type: 'bigint', isPrimary: true, isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'booking_id', type: 'bigint', isNullable: false },
          { name: 'created_by', type: 'bigint', isNullable: false },
          { name: 'reason', type: 'text', isNullable: false },
          {
            name: 'status', type: 'varchar', length: '20', isNullable: false,
            default: "'OPEN'",
          },
          { name: 'admin_note', type: 'text', isNullable: true },
          { name: 'resolved_by', type: 'bigint', isNullable: true },
          { name: 'resolved_at', type: 'timestamptz', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [
          {
            name: 'chk_complaints_status',
            expression: `"status" IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_complaints_booking',
            columnNames: ['booking_id'],
            referencedTableName: 'bookings',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_complaints_creator',
            columnNames: ['created_by'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_complaints_resolver',
            columnNames: ['resolved_by'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
    );
    const complaintIndexes: Array<[string, string[]]> = [
      ['idx_complaints_booking', ['booking_id']],
      ['idx_complaints_status', ['status']],
      ['idx_complaints_created_by', ['created_by']],
      ['idx_complaints_created_at', ['created_at']],
    ];
    for (const [name, columnNames] of complaintIndexes) {
      await queryRunner.createIndex('complaints', new TableIndex({ name, columnNames }));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('complaints', true);
    await queryRunner.dropTable('reviews', true);
    await queryRunner.dropTable('payments', true);
  }
}
