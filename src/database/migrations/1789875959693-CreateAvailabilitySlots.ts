import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAvailabilitySlots1789875959693 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'availability_slots',
        columns: [
          {
            name: 'id', type: 'bigint', isPrimary: true, isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'provider_id', type: 'bigint', isNullable: false },
          { name: 'service_id', type: 'bigint', isNullable: false },
          { name: 'slot_date', type: 'date', isNullable: false },
          { name: 'start_time', type: 'time', isNullable: false },
          { name: 'end_time', type: 'time', isNullable: false },
          { name: 'capacity', type: 'integer', isNullable: false, default: '1' },
          { name: 'booked_count', type: 'integer', isNullable: false, default: '0' },
          {
            name: 'status', type: 'varchar', length: '20', isNullable: false,
            default: "'OPEN'",
          },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        checks: [
          { name: 'chk_slots_time', expression: `"start_time" < "end_time"` },
          { name: 'chk_slots_capacity', expression: `"capacity" > 0` },
          {
            name: 'chk_slots_booked_count',
            expression: `"booked_count" >= 0 AND "booked_count" <= "capacity"`,
          },
          {
            name: 'chk_slots_status',
            expression: `"status" IN ('OPEN', 'CLOSED', 'CANCELLED')`,
          },
        ],
        foreignKeys: [
          {
            name: 'fk_slots_provider',
            columnNames: ['provider_id'],
            referencedTableName: 'providers',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'fk_slots_service_provider',
            columnNames: ['service_id', 'provider_id'],
            referencedTableName: 'services',
            referencedColumnNames: ['id', 'provider_id'],
            onDelete: 'RESTRICT',
          },
        ],
        uniques: [
          {
            name: 'uq_availability_slot',
            columnNames: ['provider_id', 'service_id', 'slot_date', 'start_time', 'end_time'],
          },
          {
            name: 'uq_slots_booking_context',
            columnNames: ['id', 'provider_id', 'service_id'],
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'availability_slots',
      new TableIndex({ name: 'idx_slots_provider', columnNames: ['provider_id'] }),
    );
    await queryRunner.createIndex(
      'availability_slots',
      new TableIndex({ name: 'idx_slots_service', columnNames: ['service_id'] }),
    );
    await queryRunner.createIndex(
      'availability_slots',
      new TableIndex({ name: 'idx_slots_date', columnNames: ['slot_date'] }),
    );
    await queryRunner.createIndex(
      'availability_slots',
      new TableIndex({ name: 'idx_slots_status', columnNames: ['status'] }),
    );
    await queryRunner.createIndex(
      'availability_slots',
      new TableIndex({
        name: 'idx_slots_search',
        columnNames: ['provider_id', 'service_id', 'slot_date', 'status'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('availability_slots', true);
  }
}
