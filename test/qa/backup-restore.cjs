/*
 * P3-BE12 backup and restore rehearsal (pg_dump / pg_restore), disposable
 * QA databases only:
 *
 *   npm run build
 *   npm run qa:backup-restore
 *
 * 1. Source: a run-owned QA database with the full migration chain and the
 *    demo dataset created through the API (users, providers, services,
 *    slots, bookings in every state, review, complaint, payment, inbox
 *    notifications). The application is stopped before the backup (no
 *    concurrent writes), as in the runbook.
 * 2. Backup: client/server major versions compatible; custom-format archive
 *    (`pg_dump -Fc`), password only through PGPASSWORD in the child's
 *    environment (never on a command line); SHA-256 recorded and verified;
 *    restrictive file mode (POSIX); the archive's table of contents lists
 *    the data of every table.
 * 3. Restore into a SEPARATE QA database (`pg_restore --exit-on-error
 *    --single-transaction --no-owner --no-privileges`): same tables, same
 *    rows (per-table count and content hash), same constraints (every
 *    foreign key validated), same indexes, same sequence positions, same
 *    migration history.
 * 4. Application compatibility: the build starts on the restored database
 *    with MIGRATIONS_CHECK=enforce, readiness is green, a restored account
 *    logs in with its password, its bookings are visible, a new record gets
 *    a fresh ID (sequences restored), the restored push outbox is not
 *    replayed while the worker is disabled; the runbook's post-restore
 *    session revocation invalidates every restored token.
 * 5. Failure detection: a truncated archive, a restore into a non-empty
 *    database and a dump of a missing database all fail with a non-zero exit
 *    code; the failed restores leave their target unchanged.
 *
 * Tools: pg_dump / pg_restore from PG_BIN, else PATH, else the default
 * Windows install directory. Environment: QA_DB_NAME (default
 * pawflow_qa_backup_restore; the restore targets add _r / _c), QA_PORTS
 * (default 8381), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { DB, Client, sleep, prepareDatabase, dropDatabase, createApp, createApi, assertQaDatabaseName } = require('./qa-env.cjs');
const { seedDemoData, DEMO_PASSWORD } = require('./demo-seed.cjs');

const SOURCE = process.env.QA_DB_NAME ?? 'pawflow_qa_backup_restore';
const RESTORED = `${SOURCE}_r`;
const CORRUPT = `${SOURCE}_c`;
const PORT = Number((process.env.QA_PORTS ?? '8381').split(',')[0]);
const OUT = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-backup-restore-'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function pgTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, exe);
  if (spawnSync(exe, ['--version'], { encoding: 'utf8' }).status === 0) return exe;
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    const versions = fs.existsSync(base) ? fs.readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => b - a) : [];
    for (const v of versions) if (fs.existsSync(path.join(base, v, 'bin', exe))) return path.join(base, v, 'bin', exe);
  }
  throw new Error(`${name} not found (set PG_BIN)`);
}

/** Runs a PostgreSQL client tool; the password only travels in PGPASSWORD (child environment). */
function pg(tool, args) {
  for (const arg of args) if (arg.startsWith('pawflow_') || arg.startsWith('--dbname=')) assertQaDatabaseName(arg.replace(/^--dbname=/, ''));
  const result = spawnSync(pgTool(tool), args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: DB.password, PGHOST: DB.host, PGPORT: String(DB.port), PGUSER: DB.user, PGCONNECT_TIMEOUT: '10' },
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.appendFileSync(path.join(OUT, 'pg-tools.log'), `\n$ ${tool} ${args.join(' ')}\nexit ${result.status}\n${(result.stderr ?? '').slice(0, 4000)}`);
  return result;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function connect(name) {
  assertQaDatabaseName(name);
  const c = new Client({ ...DB, database: name });
  await c.connect();
  if ((await c.query('select current_database() d')).rows[0].d !== name) throw new Error('ISOLATION FAILURE');
  return c;
}

async function createEmpty(name) {
  assertQaDatabaseName(name);
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
}

/** Structural and content fingerprint of the public schema. */
async function snapshot(db) {
  const tables = (await db.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).rows.map((r) => r.table_name);
  const rows = {};
  for (const t of tables) {
    rows[t] = (await db.query(`select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from "${t}" x`)).rows[0];
  }
  const constraints = (await db.query(`select conrelid::regclass::text tbl, conname, contype, convalidated, pg_get_constraintdef(oid) def
    from pg_constraint where connamespace='public'::regnamespace order by 1, 2`)).rows;
  const indexes = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const sequences = (await db.query(`select sequencename, last_value from pg_sequences where schemaname='public' order by 1`)).rows;
  const types = (await db.query(`select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) labels from pg_type t
    join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' group by 1 order by 1`)).rows;
  const migrations = (await db.query('select id, timestamp, name from migrations order by id')).rows;
  return { tables, rows, constraints, indexes, sequences, types, migrations };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * PostgreSQL re-deparses `col IN ('A','B')` on varchar after a dump/restore
 * (`ANY ((ARRAY['A'::character varying])::text[])` becomes
 * `ANY (ARRAY[('A'::character varying)::text])`). Same predicate, different
 * text: compare definitions without casts and grouping; behaviour is
 * additionally checked by violating a restored CHECK constraint.
 */
const normalizeDef = (def) => def.replace(/::(character varying|text)(\[\])?/g, '').replace(/[()\s]/g, '');
const normalized = (snap) => ({
  constraints: snap.constraints.map((c) => ({ ...c, def: normalizeDef(c.def) })).sort((a, b) => `${a.tbl}.${a.conname}`.localeCompare(`${b.tbl}.${b.conname}`)),
  indexes: snap.indexes.map((i) => ({ ...i, indexdef: normalizeDef(i.indexdef) })),
});

async function main() {
  for (const name of [SOURCE, RESTORED, CORRUPT]) assertQaDatabaseName(name);
  fs.mkdirSync(OUT, { recursive: true });
  const archive = path.join(OUT, `${SOURCE}.dump`);
  // Mock push mode (no external call) with the worker disabled: booking events create real outbox rows that stay PENDING.
  const appSource = createApp(SOURCE, [PORT], { logDir: OUT, env: { PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'false' } });
  let source;
  let restored;

  try {
    // 1. Source database with representative data.
    const prepared = await prepareDatabase(SOURCE);
    source = prepared.db;
    check(`1.1 source QA database migrated (${prepared.migrations.length} migrations, no pending DDL)`, prepared.migrations.length === 17 && prepared.pendingDdl.length === 0);
    await appSource.start();
    const api0 = createApi([PORT]);
    const seed = await seedDemoData({ api: api0, db: source });
    // Pending push deliveries in the backup: opt in, register a device, then a booking event.
    await api0('PATCH', '/notification-preferences', { token: seed.tokens.lan, body: { pushEnabled: true } });
    const device = await api0('POST', '/push-devices', { token: seed.tokens.lan, body: { registrationKind: 'FCM_TOKEN', platform: 'WEB',
      registrationValue: `restore-check:APA91b${'x'.repeat(80)}` } });
    const confirm = await api0('POST', `/bookings/provider/${seed.bookings.pending}/confirm`, { token: seed.tokens.khoa });
    await sleep(500);
    await appSource.stop();
    const pendingOutbox = (await source.query(`select count(*)::int n from notification_deliveries where status='PENDING'`)).rows[0].n;
    check('1.3 the backup contains pending push deliveries (outbox state to protect)', device.status === 200 && confirm.status === 201 && pendingOutbox > 0,
      `device ${device.status}, confirm ${confirm.status}, pending ${pendingOutbox}`);
    const before = await snapshot(source);
    const populated = before.tables.filter((t) => before.rows[t].n > 0);
    check(`1.2 representative data created through the API (${populated.length}/${before.tables.length} tables populated)`,
      ['users', 'providers', 'services', 'availability_slots', 'bookings', 'booking_status_logs', 'reviews', 'complaints', 'payments', 'notifications']
        .every((t) => before.rows[t]?.n > 0), populated.join(','));

    // 2. Backup.
    const clientVersion = /(\d+)\.(\d+)/.exec(pg('pg_dump', ['--version']).stdout);
    const serverVersion = /(\d+)\.(\d+)/.exec((await source.query('show server_version')).rows[0].server_version);
    check('2.1 pg_dump major version >= server major version', Number(clientVersion[1]) >= Number(serverVersion[1]), `pg_dump ${clientVersion[0]}, server ${serverVersion[0]}`);
    const dump = pg('pg_dump', ['--format=custom', '--no-password', `--file=${archive}`, `--dbname=${SOURCE}`]);
    check('2.2 pg_dump -Fc succeeds', dump.status === 0 && fs.existsSync(archive) && fs.statSync(archive).size > 0, `exit ${dump.status}, ${fs.existsSync(archive) ? fs.statSync(archive).size : 0} bytes`);
    const digest = sha256(archive);
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
    check('2.3 SHA-256 recorded and re-verified', sha256(archive) === fs.readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/)[0]);
    if (process.platform === 'win32') {
      console.log('SKIP 2.4 POSIX file mode 0600 cannot be verified on Windows (NTFS ACLs); this check runs on POSIX hosts such as the Linux CI runner');
    } else {
      fs.chmodSync(archive, 0o600);
      check('2.4 archive file mode is 0600', (fs.statSync(archive).mode & 0o777) === 0o600);
    }
    const toc = pg('pg_restore', ['--list', archive]);
    const dataEntries = new Set([...toc.stdout.matchAll(/TABLE DATA public (\S+)/g)].map((m) => m[1]));
    check(`2.5 archive table of contents readable and lists the data of every table (${before.tables.length})`,
      toc.status === 0 && before.tables.every((t) => dataEntries.has(t)), `${dataEntries.size} TABLE DATA entries`);
    check('2.6 command lines carry no password (PGPASSWORD in the child environment only)',
      !fs.readFileSync(path.join(OUT, 'pg-tools.log'), 'utf8').includes(`:${DB.password}@`) && !/password=/i.test(fs.readFileSync(path.join(OUT, 'pg-tools.log'), 'utf8')));

    // 3. Restore into a separate database.
    await createEmpty(RESTORED);
    const restore = pg('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', `--dbname=${RESTORED}`, archive]);
    check('3.1 pg_restore into a separate empty QA database succeeds', restore.status === 0, `exit ${restore.status}`);
    restored = await connect(RESTORED);
    const after = await snapshot(restored);
    check(`3.2 same tables (${after.tables.length})`, same(before.tables, after.tables));
    const diffRows = before.tables.filter((t) => !same(before.rows[t], after.rows[t]));
    check('3.3 same rows in every table (count and content hash)', diffRows.length === 0, diffRows.join(','));
    check(`3.4 same constraints (${after.constraints.length}, definitions compared without cast notation), every one validated`,
      same(normalized(before).constraints, normalized(after).constraints) && after.constraints.every((c) => c.convalidated));
    let violation = null;
    await restored.query('BEGIN');
    try { await restored.query(`update availability_slots set status = 'BOGUS' where id = (select min(id) from availability_slots)`); } catch (e) { violation = e.code; }
    await restored.query('ROLLBACK');
    check('3.4b a restored CHECK constraint still rejects invalid data', violation === '23514', `SQLSTATE ${violation}`);
    check(`3.5 foreign keys restored (${after.constraints.filter((c) => c.contype === 'f').length})`, after.constraints.filter((c) => c.contype === 'f').length > 0
      && after.constraints.filter((c) => c.contype === 'f').length === before.constraints.filter((c) => c.contype === 'f').length);
    check(`3.6 same indexes (${after.indexes.length}, definitions compared without cast notation) and enum types (${after.types.length})`,
      same(normalized(before).indexes, normalized(after).indexes) && same(before.types, after.types));
    check(`3.7 same sequence positions (${after.sequences.length})`, same(before.sequences, after.sequences));
    check(`3.8 same migration history (${after.migrations.length})`, same(before.migrations, after.migrations) && after.migrations.length === 17);

    // 4. Application compatibility on the restored database.
    const outboxBefore = (await restored.query(`select status, count(*)::int n from notification_deliveries group by 1 order by 1`)).rows;
    // Even with a push mode configured, a restored environment keeps the worker off until the outbox is reviewed (runbook).
    const appRestored = createApp(RESTORED, [PORT], { logDir: OUT, env: { MIGRATIONS_CHECK: 'enforce', PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'false' } });
    await appRestored.start();
    try {
      const api = createApi([PORT]);
      const ready = await fetch(`http://localhost:${PORT}/api/health/ready`);
      check('4.1 the build starts on the restored database (MIGRATIONS_CHECK=enforce) and is ready', ready.status === 200 && (await ready.json()).checks.schema === 'current');
      const login = await api('POST', '/auth/login', { body: { email: seed.accounts.lan.email, password: DEMO_PASSWORD } });
      check('4.2 a restored account logs in with its password', login.status === 200 && typeof login.body?.accessToken === 'string');
      const mine = await api('GET', '/bookings/mine', { token: login.body?.accessToken });
      const expected = (await restored.query('select count(*)::int n from bookings where customer_id=$1', [seed.accounts.lan.userId])).rows[0].n;
      const items = Array.isArray(mine.body) ? mine.body : mine.body?.items ?? mine.body?.data ?? [];
      check('4.3 the restored bookings are served', mine.status === 200 && expected > 0 && items.length === expected, `${items.length}/${expected}`);
      const maxPet = Number((await restored.query('select coalesce(max(id),0) m from pets')).rows[0].m);
      const types = await api('GET', '/pet-types');
      const pet = await api('POST', '/pets', { token: login.body?.accessToken, body: { name: 'Restore Check', petTypeId: String(types.body[0].id) } });
      check('4.4 a new record gets a fresh ID after the restore (sequences restored)', pet.status === 201 && Number(pet.body.id) > maxPet, `status ${pet.status}`);
      await sleep(3000);
      const outboxAfter = (await restored.query(`select status, count(*)::int n from notification_deliveries group by 1 order by 1`)).rows;
      check('4.5 the restored push outbox is not replayed while the worker is disabled', outboxBefore.length > 0 && same(outboxBefore, outboxAfter), JSON.stringify(outboxAfter));
      // Runbook step: a restore resurrects sessions revoked after the backup point; revoke them all.
      const revoked = await restored.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'SESSION_REVOKED' WHERE revoked_at IS NULL`);
      const me = await api('GET', '/auth/me', { token: login.body?.accessToken });
      const liveDevices = (await restored.query('select count(*)::int n from push_devices where revoked_at is null')).rows[0].n;
      check('4.6 post-restore session revocation (runbook SQL): every restored token is rejected, push devices revoked with their sessions',
        revoked.rowCount > 0 && me.status === 401 && liveDevices === 0, `${revoked.rowCount} sessions, /auth/me ${me.status}, live devices ${liveDevices}`);
    } finally {
      await appRestored.stop();
    }

    // 5. Failure detection.
    const truncated = path.join(OUT, 'truncated.dump');
    fs.writeFileSync(truncated, fs.readFileSync(archive).subarray(0, Math.floor(fs.statSync(archive).size / 2)));
    check('5.1 a truncated archive fails the integrity check (SHA-256 mismatch)', sha256(truncated) !== digest);
    await createEmpty(CORRUPT);
    const badRestore = pg('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', `--dbname=${CORRUPT}`, truncated]);
    const corrupt = await connect(CORRUPT);
    const leftovers = (await corrupt.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)).rows[0].n;
    await corrupt.end();
    check('5.2 restoring a truncated archive fails and leaves the target empty (single transaction)', badRestore.status !== 0 && leftovers === 0, `exit ${badRestore.status}, ${leftovers} tables`);
    const reRestore = pg('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', `--dbname=${RESTORED}`, archive]);
    const unchanged = await snapshot(restored);
    check('5.3 restoring over a non-empty database fails and changes nothing', reRestore.status !== 0 && same(unchanged.tables, after.tables) && unchanged.rows.users.n === after.rows.users.n + 0,
      `exit ${reRestore.status}`);
    const missing = pg('pg_dump', ['--format=custom', '--no-password', `--file=${path.join(OUT, 'missing.dump')}`, `--dbname=${SOURCE}_missing`]);
    check('5.4 a dump of a missing database fails with a non-zero exit code', missing.status !== 0, `exit ${missing.status}`);
  } finally {
    await appSource.stop();
    if (source) await source.end();
    if (restored) await restored.end();
    for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith('.dump'))) fs.rmSync(path.join(OUT, f), { force: true });
    if (process.env.QA_KEEP_DB !== '1') for (const name of [SOURCE, RESTORED, CORRUPT]) await dropDatabase(name);
  }
  console.log(`\nbackup-restore: ${passed} PASS, ${failed} FAIL (tool log: ${path.join(OUT, 'pg-tools.log')})`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FAIL backup-restore crashed: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
