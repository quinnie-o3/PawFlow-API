import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateBookings1789876260241 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'bookings',
        columns: [
          {
            name: 'id', type: 'bigint', isPrimary: true, isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'customer_id', type: 'bigint', isNullable: false },
          { name: 'pet_id', type: 'bigint', isNullable: false },
          { name: 'provider_id', type: 'bigint', isNullable: false },
          { name: 'service_id', type: 'bigint', isNullable: false },
          { name: 'slot_id', type: 'bigint', isNullable: false },
          {
            name: 'status', type: 'varchar', length: '30', isNullable: false,
            default: "'PENDING_CONFIRMATION'",
          },
          {
            name: 'booked_price', type: 'numeric', precision: 12, scale: 2,
            isNullable: false,
          },
          { name: 'customer_note', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [
          {
            name: 'chk_bookings_status',
            expression:
              `"status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
          },
          { name: 'chk_bookings_price', expression: `"booked_price" >= 0` },
        ],
        foreignKeys: [
          {
            name: 'fk_bookings_customer',
            columnNames: ['customer_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_bookings_pet_owner',
            columnNames: ['pet_id', 'customer_id'],
            referencedTableName: 'pets',
            referencedColumnNames: ['id', 'owner_id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_bookings_provider',
            columnNames: ['provider_id'],
            referencedTableName: 'providers',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_bookings_service_provider',
            columnNames: ['service_id', 'provider_id'],
            referencedTableName: 'services',
            referencedColumnNames: ['id', 'provider_id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_bookings_slot_context',
            columnNames: ['slot_id', 'provider_id', 'service_id'],
            referencedTableName: 'availability_slots',
            referencedColumnNames: ['id', 'provider_id', 'service_id'],
            onDelete: 'RESTRICT',
          },
        ],
      }),
    );

    const bookingIndexes: Array<[string, string[]]> = [
      ['idx_bookings_customer', ['customer_id']],
      ['idx_bookings_pet', ['pet_id']],
      ['idx_bookings_provider', ['provider_id']],
      ['idx_bookings_service', ['service_id']],
      ['idx_bookings_slot', ['slot_id']],
      ['idx_bookings_status', ['status']],
      ['idx_bookings_provider_status', ['provider_id', 'status']],
    ];

    for (const [name, columnNames] of bookingIndexes) {
      await queryRunner.createIndex(
        'bookings',
        new TableIndex({ name, columnNames }),
      );
    }

    await queryRunner.createTable(
      new Table({
        name: 'booking_status_logs',
        columns: [
          {
            name: 'id', type: 'bigint', isPrimary: true, isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'booking_id', type: 'bigint', isNullable: false },
          { name: 'old_status', type: 'varchar', length: '30', isNullable: true },
          { name: 'new_status', type: 'varchar', length: '30', isNullable: false },
          { name: 'changed_by', type: 'bigint', isNullable: true },
          { name: 'reason', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [
          {
            name: 'chk_booking_logs_old_status',
            expression:
              `"old_status" IS NULL OR "old_status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
          },
          {
            name: 'chk_booking_logs_new_status',
            expression:
              `"new_status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_booking_logs_booking',
            columnNames: ['booking_id'],
            referencedTableName: 'bookings',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            name: 'fk_booking_logs_user',
            columnNames: ['changed_by'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'booking_status_logs',
      new TableIndex({ name: 'idx_booking_logs_booking', columnNames: ['booking_id'] }),
    );
    await queryRunner.createIndex(
      'booking_status_logs',
      new TableIndex({ name: 'idx_booking_logs_created_at', columnNames: ['created_at'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('booking_status_logs', true);
    await queryRunner.dropTable('bookings', true);
  }
}
