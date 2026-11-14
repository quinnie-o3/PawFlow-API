import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * P3-BE06-02: transactional outbox for push delivery (`notification_deliveries`).
 *
 * Additive. The only change to an existing table is a new UNIQUE
 * (id, recipient_user_id) on `notifications` (implied by its primary key; no
 * data change), which the composite foreign key needs so a job's recipient
 * is always the notification's recipient. `down` removes exactly the objects
 * created here (pending push jobs are lost; inbox notifications are not).
 *
 * P3-BE06-06 (same pending migration, not yet applied anywhere persistent):
 * `notification_push_sends` (final per-device outcomes, insert-only) plus
 * UNIQUE (id, recipient_user_id) on `notification_deliveries` and UNIQUE
 * (id, user_id) on `push_devices` (both implied by the primary keys; no data
 * change) for its recipient-pinning composite foreign keys.
 */
export class CreateNotificationDeliveries1796500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "uq_notifications_id_recipient" UNIQUE ("id", "recipient_user_id")`);

    await queryRunner.createTable(
      new Table({
        name: 'notification_deliveries',
        columns: [
          { name: 'id', type: 'bigint', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'notification_id', type: 'bigint', isNullable: false },
          { name: 'recipient_user_id', type: 'bigint', isNullable: false },
          { name: 'status', type: 'varchar', length: '16', isNullable: false, default: `'PENDING'` },
          { name: 'attempt_count', type: 'integer', isNullable: false, default: 0 },
          { name: 'next_attempt_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'expires_at', type: 'timestamptz', isNullable: false },
          { name: 'lease_owner', type: 'varchar', length: '64', isNullable: true },
          { name: 'lease_expires_at', type: 'timestamptz', isNullable: true },
          { name: 'last_error_category', type: 'varchar', length: '32', isNullable: true },
          { name: 'last_error_code', type: 'varchar', length: '100', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'completed_at', type: 'timestamptz', isNullable: true },
        ],
        uniques: [{ name: 'uq_notification_deliveries_notification', columnNames: ['notification_id'] }],
        checks: [
          { name: 'chk_notification_deliveries_status', expression: `"status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'EXPIRED')` },
          { name: 'chk_notification_deliveries_lease', expression: `("status" = 'PROCESSING') = ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)` },
          { name: 'chk_notification_deliveries_completed', expression: `("status" IN ('DONE', 'FAILED', 'EXPIRED')) = ("completed_at" IS NOT NULL)` },
          { name: 'chk_notification_deliveries_attempts', expression: `"attempt_count" BETWEEN 0 AND 1000` },
          { name: 'chk_notification_deliveries_expiry', expression: `"expires_at" > "created_at"` },
          { name: 'chk_notification_deliveries_lease_owner', expression: `"lease_owner" IS NULL OR "lease_owner" ~ '^[A-Za-z0-9:._-]{1,64}$'` },
          { name: 'chk_notification_deliveries_error_category', expression: `"last_error_category" IS NULL OR "last_error_category" ~ '^[A-Z][A-Z_]{0,31}$'` },
          { name: 'chk_notification_deliveries_error_code', expression: `"last_error_code" IS NULL OR "last_error_code" ~ '^[A-Za-z0-9/._:-]{1,100}$'` },
        ],
        foreignKeys: [
          {
            name: 'fk_notification_deliveries_notification',
            columnNames: ['notification_id', 'recipient_user_id'],
            referencedTableName: 'notifications',
            referencedColumnNames: ['id', 'recipient_user_id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );

    // Worker selection: due PENDING jobs, expired leases; retention: finished jobs.
    await queryRunner.query(`CREATE INDEX "idx_notification_deliveries_due" ON "notification_deliveries" ("next_attempt_at", "id") WHERE "status" = 'PENDING'`);
    await queryRunner.query(`CREATE INDEX "idx_notification_deliveries_lease" ON "notification_deliveries" ("lease_expires_at") WHERE "status" = 'PROCESSING'`);
    await queryRunner.query(`CREATE INDEX "idx_notification_deliveries_finished" ON "notification_deliveries" ("completed_at") WHERE "status" IN ('DONE', 'FAILED', 'EXPIRED')`);

    await queryRunner.query(`
      CREATE FUNCTION notification_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'PENDING' OR NEW.attempt_count <> 0 OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'notification_deliveries: a new job must be PENDING with no attempts' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.notification_id IS DISTINCT FROM OLD.notification_id
           OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
          RAISE EXCEPTION 'notification_deliveries: identity, created_at and expires_at cannot change' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.attempt_count < OLD.attempt_count THEN
          RAISE EXCEPTION 'notification_deliveries: attempt_count cannot decrease' USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.status IN ('DONE', 'FAILED', 'EXPIRED') THEN
          RAISE EXCEPTION 'notification_deliveries: a % job cannot change', OLD.status USING ERRCODE = 'check_violation';
        END IF;
        IF NOT (
             (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'EXPIRED'))
          OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PROCESSING', 'PENDING', 'DONE', 'FAILED', 'EXPIRED'))
        ) THEN
          RAISE EXCEPTION 'notification_deliveries: illegal transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END $$`);
    await queryRunner.query(
      `CREATE TRIGGER trg_notification_deliveries_guard BEFORE INSERT OR UPDATE ON "notification_deliveries" FOR EACH ROW EXECUTE FUNCTION notification_deliveries_guard()`,
    );

    // ---------------------------------------------------------------- BE06-06
    // Final per-device outcome of a delivery job, insert-only. The device row
    // id IS the registration generation: P3-BE05 never reuses a push_devices
    // row (rotation / transfer insert a new row; the guard trigger makes the
    // registration columns immutable), so UNIQUE (delivery, device) is exact.
    // Composite FKs pin both the job and the device to the same recipient.
    await queryRunner.query(`ALTER TABLE "notification_deliveries" ADD CONSTRAINT "uq_notification_deliveries_id_recipient" UNIQUE ("id", "recipient_user_id")`);
    await queryRunner.query(`ALTER TABLE "push_devices" ADD CONSTRAINT "uq_push_devices_id_user" UNIQUE ("id", "user_id")`);
    await queryRunner.createTable(
      new Table({
        name: 'notification_push_sends',
        columns: [
          { name: 'id', type: 'bigint', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'delivery_id', type: 'bigint', isNullable: false },
          { name: 'recipient_user_id', type: 'bigint', isNullable: false },
          { name: 'push_device_id', type: 'bigint', isNullable: false },
          { name: 'outcome', type: 'varchar', length: '24', isNullable: false },
          { name: 'provider_code', type: 'varchar', length: '100', isNullable: true },
          { name: 'attempt', type: 'integer', isNullable: false },
          { name: 'attempted_at', type: 'timestamptz', isNullable: false },
          { name: 'finalized_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        uniques: [{ name: 'uq_notification_push_sends_delivery_device', columnNames: ['delivery_id', 'push_device_id'] }],
        checks: [
          { name: 'chk_notification_push_sends_outcome', expression: `"outcome" IN ('ACCEPTED', 'INVALID_DESTINATION', 'INVALID_REQUEST')` },
          { name: 'chk_notification_push_sends_code', expression: `"provider_code" IS NULL OR "provider_code" ~ '^[A-Za-z0-9/._:-]{1,100}$'` },
          { name: 'chk_notification_push_sends_code_outcome', expression: `("outcome" = 'ACCEPTED') = ("provider_code" IS NULL)` },
          { name: 'chk_notification_push_sends_attempt', expression: `"attempt" BETWEEN 1 AND 1000` },
        ],
        foreignKeys: [
          {
            name: 'fk_notification_push_sends_delivery',
            columnNames: ['delivery_id', 'recipient_user_id'],
            referencedTableName: 'notification_deliveries',
            referencedColumnNames: ['id', 'recipient_user_id'],
            onDelete: 'CASCADE',
          },
          {
            name: 'fk_notification_push_sends_device',
            columnNames: ['push_device_id', 'recipient_user_id'],
            referencedTableName: 'push_devices',
            referencedColumnNames: ['id', 'user_id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );
    await queryRunner.query(`CREATE INDEX "idx_notification_push_sends_device" ON "notification_push_sends" ("push_device_id")`);
    await queryRunner.query(`
      CREATE FUNCTION notification_push_sends_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'notification_push_sends rows are final and cannot change' USING ERRCODE = 'check_violation';
      END $$`);
    await queryRunner.query(
      `CREATE TRIGGER trg_notification_push_sends_immutable BEFORE UPDATE ON "notification_push_sends" FOR EACH ROW EXECUTE FUNCTION notification_push_sends_immutable()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_push_sends"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS notification_push_sends_immutable()`);
    await queryRunner.query(`ALTER TABLE "push_devices" DROP CONSTRAINT IF EXISTS "uq_push_devices_id_user"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_deliveries"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS notification_deliveries_guard()`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "uq_notifications_id_recipient"`);
  }
}
