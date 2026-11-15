import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * P2-07: durable idempotency for `POST /bookings`.
 *
 * - `uq_booking_idempotency_customer_key` is the cross-instance mutex: the
 *   booking transaction inserts this row before locking the slot, so a
 *   concurrent request with the same customer and key waits on the unique
 *   index until the first transaction commits or rolls back.
 * - `booking_id` is NULL only inside that transaction (the key is acquired
 *   before the booking exists); it is set before commit, and a rollback
 *   removes the row, so a committed row always references its booking.
 * - Retention: keys live as long as their booking. There is no automatic
 *   expiry; deleting a booking cascades to its key.
 */
export class CreateBookingIdempotencyKeys1793624455115
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'booking_idempotency_keys',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'customer_id', type: 'bigint', isNullable: false },
          {
            name: 'idempotency_key',
            type: 'varchar',
            length: '128',
            isNullable: false,
          },
          {
            name: 'request_fingerprint',
            type: 'varchar',
            length: '64',
            isNullable: false,
          },
          { name: 'booking_id', type: 'bigint', isNullable: true },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'NOW()',
          },
        ],
        checks: [
          {
            name: 'chk_booking_idempotency_key_format',
            expression: `"idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'`,
          },
          {
            name: 'chk_booking_idempotency_fingerprint',
            expression: `"request_fingerprint" ~ '^[0-9a-f]{64}$'`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_booking_idempotency_customer',
            columnNames: ['customer_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            name: 'fk_booking_idempotency_booking',
            columnNames: ['booking_id'],
            referencedTableName: 'bookings',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
        uniques: [
          {
            name: 'uq_booking_idempotency_customer_key',
            columnNames: ['customer_id', 'idempotency_key'],
          },
          {
            name: 'uq_booking_idempotency_booking',
            columnNames: ['booking_id'],
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('booking_idempotency_keys', true);
  }
}
