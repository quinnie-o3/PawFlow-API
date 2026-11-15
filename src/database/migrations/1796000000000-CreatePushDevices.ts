import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * P3-BE05: push device registrations (FCM) bound to auth sessions.
 *
 * - `auth_sessions`: new UNIQUE (id, user_id), the target of the composite
 *   FK below (id alone is already unique, so no existing row can violate it).
 * - `push_devices`: one row per (session, registration). The value is
 *   encrypted, identified by an HMAC; at most one ACTIVE row per destination
 *   and per session (partial unique indexes).
 * - Trigger `trg_auth_sessions_revoke_push_devices` (AFTER UPDATE OF
 *   revoked_at ON auth_sessions): when a session is revoked by ANY path
 *   (logout, logout-all, session revoke, refresh reuse, suspension, password
 *   change/reset), its active devices are revoked in the same transaction.
 * - Trigger `trg_push_devices_guard_update`: only last_seen_at and the
 *   one-way revocation can change.
 *
 * Additive. `down` drops the triggers, functions, table and the unique
 * constraint; registrations are lost (clients re-register on next start-up).
 */
export class CreatePushDevices1796000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth_sessions" ADD CONSTRAINT "uq_auth_sessions_id_user" UNIQUE ("id", "user_id")`);

    await queryRunner.createTable(
      new Table({
        name: 'push_devices',
        columns: [
          { name: 'id', type: 'bigint', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'user_id', type: 'bigint', isNullable: false },
          { name: 'auth_session_id', type: 'uuid', isNullable: false },
          { name: 'registration_kind', type: 'varchar', length: '16', isNullable: false },
          { name: 'registration_hash', type: 'varchar', length: '64', isNullable: false },
          { name: 'registration_ciphertext', type: 'text', isNullable: false },
          { name: 'platform', type: 'varchar', length: '16', isNullable: false },
          { name: 'registered_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'last_seen_at', type: 'timestamptz', isNullable: false, default: 'NOW()' },
          { name: 'revoked_at', type: 'timestamptz', isNullable: true },
          { name: 'revocation_reason', type: 'varchar', length: '32', isNullable: true },
        ],
        checks: [
          { name: 'chk_push_devices_kind', expression: `"registration_kind" IN ('FID', 'FCM_TOKEN')` },
          { name: 'chk_push_devices_platform', expression: `"platform" IN ('WEB', 'ANDROID', 'IOS')` },
          { name: 'chk_push_devices_hash', expression: `"registration_hash" ~ '^[0-9a-f]{64}$'` },
          { name: 'chk_push_devices_ciphertext', expression: `"registration_ciphertext" ~ '^v1:[A-Za-z0-9_-]{1,32}:'` },
          {
            name: 'chk_push_devices_reason',
            expression: `"revocation_reason" IS NULL OR "revocation_reason" IN ('USER_REVOKED', 'SESSION_REVOKED', 'ROTATED', 'TRANSFERRED', 'INVALID_REGISTRATION', 'STALE')`,
          },
          { name: 'chk_push_devices_revocation', expression: `("revoked_at" IS NULL) = ("revocation_reason" IS NULL)` },
          { name: 'chk_push_devices_seen', expression: `"last_seen_at" >= "registered_at"` },
        ],
        foreignKeys: [
          {
            name: 'fk_push_devices_session_user',
            columnNames: ['auth_session_id', 'user_id'],
            referencedTableName: 'auth_sessions',
            referencedColumnNames: ['id', 'user_id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );

    await queryRunner.createIndex('push_devices', new TableIndex({ name: 'idx_push_devices_session', columnNames: ['auth_session_id'] }));
    await queryRunner.createIndex('push_devices', new TableIndex({ name: 'idx_push_devices_last_seen', columnNames: ['last_seen_at'] }));
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_push_devices_active_registration" ON "push_devices" ("registration_kind", "registration_hash") WHERE "revoked_at" IS NULL`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_push_devices_active_session" ON "push_devices" ("auth_session_id") WHERE "revoked_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_push_devices_user_active" ON "push_devices" ("user_id") WHERE "revoked_at" IS NULL`);

    await queryRunner.query(`
      CREATE FUNCTION push_devices_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id
          OR NEW.user_id <> OLD.user_id
          OR NEW.auth_session_id <> OLD.auth_session_id
          OR NEW.registration_kind <> OLD.registration_kind
          OR NEW.registration_hash <> OLD.registration_hash
          OR NEW.registration_ciphertext <> OLD.registration_ciphertext
          OR NEW.platform <> OLD.platform
          OR NEW.registered_at <> OLD.registered_at THEN
          RAISE EXCEPTION 'push_devices are immutable except last_seen_at and revocation' USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason OR NEW.last_seen_at <> OLD.last_seen_at) THEN
          RAISE EXCEPTION 'a revoked push device cannot change' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await queryRunner.query(
      `CREATE TRIGGER trg_push_devices_guard_update BEFORE UPDATE ON "push_devices" FOR EACH ROW EXECUTE FUNCTION push_devices_guard_update()`,
    );

    await queryRunner.query(`
      CREATE FUNCTION push_devices_revoke_for_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE push_devices SET revoked_at = NEW.revoked_at, revocation_reason = 'SESSION_REVOKED'
         WHERE auth_session_id = NEW.id AND revoked_at IS NULL;
        RETURN NULL;
      END $$`);
    await queryRunner.query(`
      CREATE TRIGGER trg_auth_sessions_revoke_push_devices
        AFTER UPDATE OF revoked_at ON "auth_sessions"
        FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
        EXECUTE FUNCTION push_devices_revoke_for_session()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_auth_sessions_revoke_push_devices ON "auth_sessions"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS push_devices_revoke_for_session()`);
    await queryRunner.dropTable('push_devices', true);
    await queryRunner.query(`DROP FUNCTION IF EXISTS push_devices_guard_update()`);
    await queryRunner.query(`ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "uq_auth_sessions_id_user"`);
  }
}
