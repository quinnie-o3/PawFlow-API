import { MigrationInterface, QueryRunner, Table } from 'typeorm';

const TYPES = [
  'BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'BOOKING_COMPLETED', 'BOOKING_NO_SHOW',
  'PAYMENT_STATUS_CHANGED', 'REVIEW_RECEIVED', 'COMPLAINT_CREATED', 'COMPLAINT_STATUS_CHANGED',
  'PROVIDER_APPROVED', 'PROVIDER_REJECTED', 'PROVIDER_SUSPENDED', 'SYSTEM_ANNOUNCEMENT',
].map((t) => `'${t}'`).join(', ');

/**
 * P3-BE04: persistent notification inbox.
 *
 * - `notifications`: one recipient per row (FK -> users, ON DELETE CASCADE),
 *   snapshot content, optional (target_type, target_id) navigation pair
 *   without FK (history survives business changes), optional per-recipient
 *   idempotency key (`uq_notifications_recipient_event`).
 * - Indexes: (recipient_user_id, id DESC) for the newest-first inbox, and a
 *   partial (recipient_user_id, id DESC) WHERE read_at IS NULL for unread
 *   lists and counts.
 * - Trigger `trg_notifications_guard_update`: everything except read_at is
 *   immutable, and read_at can only be set once (NULL -> timestamp).
 *
 * Additive only. `down` drops the table, trigger and function (all
 * notifications are lost).
 */
export class CreateNotifications1795500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'notifications',
        columns: [
          { name: 'id', type: 'bigint', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'recipient_user_id', type: 'bigint', isNullable: false },
          { name: 'type', type: 'varchar', length: '40', isNullable: false },
          { name: 'title', type: 'varchar', length: '150', isNullable: false },
          { name: 'body', type: 'varchar', length: '1000', isNullable: false },
          { name: 'payload', type: 'jsonb', isNullable: false, default: `'{}'::jsonb` },
          { name: 'target_type', type: 'varchar', length: '20', isNullable: true },
          { name: 'target_id', type: 'bigint', isNullable: true },
          { name: 'event_key', type: 'varchar', length: '200', isNullable: true },
          { name: 'read_at', type: 'timestamptz', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
        ],
        uniques: [{ name: 'uq_notifications_recipient_event', columnNames: ['recipient_user_id', 'event_key'] }],
        checks: [
          { name: 'chk_notifications_type', expression: `"type" IN (${TYPES})` },
          { name: 'chk_notifications_target_type', expression: `"target_type" IS NULL OR "target_type" IN ('BOOKING', 'COMPLAINT', 'REVIEW', 'PROVIDER')` },
          { name: 'chk_notifications_target_pair', expression: `("target_type" IS NULL) = ("target_id" IS NULL)` },
          { name: 'chk_notifications_title', expression: `char_length(btrim("title")) BETWEEN 1 AND 150` },
          { name: 'chk_notifications_body', expression: `char_length(btrim("body")) BETWEEN 1 AND 1000` },
          { name: 'chk_notifications_payload', expression: `jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 4096` },
          { name: 'chk_notifications_event_key', expression: `"event_key" IS NULL OR "event_key" ~ '^[A-Za-z0-9:._-]{1,200}$'` },
          { name: 'chk_notifications_read_after_create', expression: `"read_at" IS NULL OR "read_at" >= "created_at"` },
        ],
        foreignKeys: [
          {
            name: 'fk_notifications_recipient',
            columnNames: ['recipient_user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );

    await queryRunner.query(`CREATE INDEX "idx_notifications_recipient_id" ON "notifications" ("recipient_user_id", "id" DESC)`);
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_recipient_unread" ON "notifications" ("recipient_user_id", "id" DESC) WHERE "read_at" IS NULL`,
    );

    await queryRunner.query(`
      CREATE FUNCTION notifications_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id
          OR NEW.recipient_user_id <> OLD.recipient_user_id
          OR NEW.type <> OLD.type
          OR NEW.title <> OLD.title
          OR NEW.body <> OLD.body
          OR NEW.payload <> OLD.payload
          OR NEW.target_type IS DISTINCT FROM OLD.target_type
          OR NEW.target_id IS DISTINCT FROM OLD.target_id
          OR NEW.event_key IS DISTINCT FROM OLD.event_key
          OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'notifications are immutable except read_at' USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
          RAISE EXCEPTION 'notifications.read_at cannot change once set' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await queryRunner.query(
      `CREATE TRIGGER trg_notifications_guard_update BEFORE UPDATE ON "notifications" FOR EACH ROW EXECUTE FUNCTION notifications_guard_update()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('notifications', true);
    await queryRunner.query(`DROP FUNCTION IF EXISTS notifications_guard_update()`);
  }
}
