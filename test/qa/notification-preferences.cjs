/*
 * P3-BE07-02 notification preferences — real HTTP + real PostgreSQL
 * (disposable QA database only). Two API instances.
 *
 *   npm run build
 *   npm run qa:notification-preferences
 *
 * Environment: QA_DB_NAME (default pawflow_qa_notification_prefs), QA_PORTS
 * (default 8301,8302), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_notification_prefs';
const PORTS = (process.env.QA_PORTS ?? '8301,8302').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-prefs-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaPrefsPass123!';
const RUN = 'np' + Date.now().toString(36);
const NEW_MIGRATION = 'CreateNotificationPreferences1797000000000';

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const rejects = (sql, params) => db.query(sql, params).then(() => null, (e) => e.code);
  const apps = [];
  const start = async (tag, env) => {
    const dir = path.join(OUT_DIR, `logs-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const port of PORTS) {
      const app = createApp(NAME, [port], { logDir: dir, jwtSecret: JWT_SECRET, env });
      await app.start();
      apps.push(app);
    }
    return dir;
  };
  const stopAll = async () => { while (apps.length) await apps.pop().stop(); };
  const api = createApi(PORTS);
  const statuses = [];
  const call = async (method, url, opts = {}) => { const r = await api(method, url, opts); statuses.push(r.status); return r; };
  const mail = (n) => `${n}.${RUN}@qa.test`;
  const secrets = [PASSWORD, JWT_SECRET];
  const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')] });

  try {
    section('0. Migration');
    check(`all ${migrations.length} source migrations applied (incl. ${NEW_MIGRATION}); entities = schema (0 pending DDL)`, migrations.length === sourceMigrationCount() && migrations.includes(NEW_MIGRATION) && pendingDdl.length === 0, { last: migrations.slice(-2), pendingDdl });
    const def = await all(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'notification_preferences'::regclass order by conname`);
    const cols = (await all(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'notification_preferences' order by ordinal_position`));
    evidence.schema = { constraints: def.map((c) => `${c.conname}: ${c.d}`), columns: cols.map((c) => `${c.column_name} ${c.data_type} null=${c.is_nullable} default=${c.column_default}`) };
    check('schema: PK user_id, FK -> users ON DELETE CASCADE, CHECK push_enabled = (push_enabled_at IS NOT NULL), push_enabled default false', def.some((c) => c.conname === 'pk_notification_preferences' && /PRIMARY KEY \(user_id\)/.test(c.d)) && def.some((c) => c.conname === 'fk_notification_preferences_user' && /REFERENCES users\(id\) ON DELETE CASCADE/.test(c.d)) && def.some((c) => c.conname === 'chk_notification_preferences_push_enabled_at') && cols.map((c) => c.column_name).join() === 'user_id,push_enabled,push_enabled_at,created_at,updated_at' && cols[1].column_default === 'false', evidence.schema);

    // "Existing" accounts created before any preference API use.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    for (const [n, role] of [['alice', 'CUSTOMER'], ['bob', 'CUSTOMER'], ['owner', 'PROVIDER_OWNER'], ['staff', 'PROVIDER_STAFF'], ['admin', 'ADMIN'], ['susp', 'CUSTOMER'], ['victim', 'CUSTOMER']]) {
      ids[n] = (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, $4, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), hash, role])).id;
    }
    await ds.initialize();
    {
      const before = await one(`select (select count(*)::int from users) u, (select md5(string_agg(u::text, '|' order by u.id)) from users u) h`);
      // Undo newest first, down to and including this migration (later ones are re-applied below).
      const undoCount = migrations.length - migrations.indexOf(NEW_MIGRATION);
      for (let i = 0; i < undoCount; i++) await ds.undoLastMigration({ transaction: 'each' });
      const gone = await one(`select to_regclass('notification_preferences') t, (select md5(string_agg(u::text, '|' order by u.id)) from users u) h`);
      const again = await ds.runMigrations({ transaction: 'each' });
      const pend = (await ds.driver.createSchemaBuilder().log()).upQueries.length;
      check('23. migration down drops only the table (users intact); up again on existing data -> applied, 0 pending DDL', gone.t === null && gone.h === before.h && again.length === undoCount && again[0].name === NEW_MIGRATION && pend === 0, { gone, pend });
    }
    check('24. existing users are not backfilled (0 preference rows after migration)', (await one(`select count(*)::int c from notification_preferences`)).c === 0);

    section('1. Push disabled (default env): defaults, transitions, validation');
    const logDir = await start('disabled', {});
    const login = async (n, port) => { const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD }, port }); if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`); secrets.push(r.body.accessToken, r.body.refreshToken); return r.body.accessToken; };
    const get = (t, port) => call('GET', '/notification-preferences', { token: t, port });
    const patch = (t, body, port) => call('PATCH', '/notification-preferences', { token: t, body, port });
    const rowOf = (uid) => one(`select push_enabled, push_enabled_at, updated_at from notification_preferences where user_id = $1`, [uid]);
    const A = await login('alice');

    const g0 = await get(A);
    check('1. GET without a row -> 200 { pushEnabled:false, pushEnabledAt:null, pushAvailable:false, updatedAt:null } (exact keys)', g0.status === 200 && JSON.stringify(g0.body) === JSON.stringify({ pushEnabled: false, pushEnabledAt: null, pushAvailable: false, updatedAt: null }), g0.body);
    await get(A);
    check('2. GET never creates a row', (await rowOf(ids.alice)) === undefined);
    check('20. push disabled environment: preference API fully available (pushAvailable false)', g0.body.pushAvailable === false);

    const t0 = new Date((await one('select now() n')).n);
    const p1 = await patch(A, { pushEnabled: true });
    const t1 = new Date((await one('select now() n')).n);
    const r1 = await rowOf(ids.alice);
    check('3. PATCH true -> 200 ON; pushEnabledAt = PostgreSQL time of the opt-in (between DB clock readings), equals the stored row; updatedAt = pushEnabledAt', p1.status === 200 && p1.body.pushEnabled === true && Date.parse(p1.body.pushEnabledAt) >= t0.getTime() && Date.parse(p1.body.pushEnabledAt) <= t1.getTime() && p1.body.pushEnabledAt === new Date(r1.push_enabled_at).toISOString() && p1.body.updatedAt === p1.body.pushEnabledAt, { p1: p1.body, t0, t1 });
    await sleep(15);
    const p2 = await patch(A, { pushEnabled: true }, PORTS[1]);
    check('5. repeated PATCH true (other instance) -> same pushEnabledAt and updatedAt (nothing rewritten)', p2.status === 200 && JSON.stringify(p2.body) === JSON.stringify(p1.body), { p1: p1.body, p2: p2.body });
    const p3 = await patch(A, { pushEnabled: false });
    check('4. PATCH false -> OFF, pushEnabledAt null, updatedAt advanced', p3.status === 200 && p3.body.pushEnabled === false && p3.body.pushEnabledAt === null && Date.parse(p3.body.updatedAt) > Date.parse(p1.body.updatedAt), p3.body);
    await sleep(15);
    const p4 = await patch(A, { pushEnabled: false }, PORTS[1]);
    check('6. repeated PATCH false -> unchanged (updatedAt preserved)', JSON.stringify(p4.body) === JSON.stringify(p3.body), { p3: p3.body, p4: p4.body });
    const p5 = await patch(A, { pushEnabled: true });
    check('7. OFF -> ON again -> NEW pushEnabledAt (later than the previous opt-in): a new consent period', p5.body.pushEnabled === true && Date.parse(p5.body.pushEnabledAt) > Date.parse(p1.body.pushEnabledAt), { first: p1.body.pushEnabledAt, second: p5.body.pushEnabledAt });
    const B0 = await login('bob');
    const neverRow = await patch(B0, { pushEnabled: false });
    check('PATCH false without a row -> defaults returned, no row written', JSON.stringify(neverRow.body) === JSON.stringify({ pushEnabled: false, pushEnabledAt: null, pushAvailable: false, updatedAt: null }) && (await rowOf(ids.bob)) === undefined, neverRow.body);

    const bad = {};
    for (const [label, body] of [['missing', {}], ['null', { pushEnabled: null }], ['string true', { pushEnabled: 'true' }], ['string false', { pushEnabled: 'false' }], ['number 1', { pushEnabled: 1 }], ['number 0', { pushEnabled: 0 }], ['userId', { pushEnabled: true, userId: ids.bob }], ['role', { pushEnabled: true, role: 'ADMIN' }], ['pushEnabledAt', { pushEnabled: true, pushEnabledAt: '2000-01-01T00:00:00Z' }], ['array', [true]]]) {
      bad[label] = (await patch(B0, body)).status;
    }
    evidence.validation = bad;
    check('8-11. missing / null / "true" / "false" / 1 / 0 / userId / role / pushEnabledAt / array -> 400; nothing written', Object.values(bad).every((s) => s === 400) && (await rowOf(ids.bob)) === undefined, bad);

    section('2. Authentication and authorization');
    const anon = [await call('GET', '/notification-preferences'), await call('PATCH', '/notification-preferences', { body: { pushEnabled: true } }), await get('not-a-jwt')];
    check('12. anonymous / malformed token -> 401 (GET and PATCH)', anon.every((r) => r.status === 401), anon.map((r) => r.status));
    const R = await login('alice');
    await call('POST', '/auth/logout', { token: R });
    const revoked = [await get(R), await patch(R, { pushEnabled: false })];
    check('13. revoked session (after logout) -> 401; state unchanged', revoked.every((r) => r.status === 401) && (await rowOf(ids.alice)).push_enabled === true, revoked.map((r) => r.status));
    const S = await login('susp');
    await patch(S, { pushEnabled: true });
    const ADMIN = await login('admin');
    const sus = await call('PATCH', `/admin/users/${ids.susp}/suspend`, { token: ADMIN });
    const suspended = [await get(S), await patch(S, { pushEnabled: false })];
    let reLogin = await call('POST', '/auth/login', { body: { email: mail('susp'), password: PASSWORD } });
    check('14. suspended account: existing token -> 401 (GET and PATCH), new login refused; stored preference untouched', sus.status === 200 && suspended.every((r) => r.status === 401) && reLogin.status !== 200 && (await rowOf(ids.susp)).push_enabled === true, { sus: sus.status, suspended: suspended.map((r) => r.status), reLogin: reLogin.status });
    const roles = {};
    for (const n of ['owner', 'staff', 'admin']) {
      const t = await login(n);
      roles[n] = [(await get(t)).status, (await patch(t, { pushEnabled: true })).status, (await get(t)).body.pushEnabled];
    }
    check('provider owner, staff and admin can read and change their own preference', Object.values(roles).every(([g, p, v]) => g === 200 && p === 200 && v === true), roles);

    section('3. Isolation and account switching');
    const Bt = await login('bob');
    const gb = await get(Bt);
    check("15. isolation: Bob sees his own default, not Alice's ON", gb.body.pushEnabled === false && gb.body.pushEnabledAt === null);
    await patch(Bt, { pushEnabled: true });
    await patch(Bt, { pushEnabled: false });
    check("15. Bob's changes never touch Alice's row", (await rowOf(ids.alice)).push_enabled === true && new Date((await rowOf(ids.alice)).push_enabled_at).toISOString() === p5.body.pushEnabledAt);
    {
      // Same "browser": Alice opts in, logs out; Bob logs in on the same client.
      const a = await login('alice', PORTS[0]);
      const before = (await get(a, PORTS[0])).body;
      await call('POST', '/auth/logout', { token: a, port: PORTS[0] });
      const b = await login('bob', PORTS[0]);
      const after = (await get(b, PORTS[0])).body;
      check('16. account switch on the same client: Bob gets his own preference (OFF), not Alice\'s (ON); nothing copied', before.pushEnabled === true && after.pushEnabled === false && after.pushEnabledAt === null, { alice: before, bob: after });
    }

    section('4. Concurrency (2 instances)');
    {
      const C = await login('victim');
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => patch(C, { pushEnabled: true }, PORTS[i % 2])));
      const rows = await all(`select push_enabled_at from notification_preferences where user_id = $1`, [ids.victim]);
      const stamps = new Set(rs.map((r) => r.body.pushEnabledAt));
      check('17. 20 concurrent PATCH true -> all 200, exactly one row, one consent timestamp shared by every response', rs.every((r) => r.status === 200) && rows.length === 1 && stamps.size === 1 && [...stamps][0] === new Date(rows[0].push_enabled_at).toISOString(), { statuses: [...new Set(rs.map((r) => r.status))], rows: rows.length, stamps: stamps.size });
      const mixed = await Promise.all(Array.from({ length: 30 }, (_, i) => patch(C, { pushEnabled: i % 3 !== 0 }, PORTS[i % 2])));
      const fin = await rowOf(ids.victim);
      const cnt = (await one(`select count(*)::int c from notification_preferences where user_id = $1`, [ids.victim])).c;
      const responsesValid = mixed.every((r) => r.status === 200 && (r.body.pushEnabled === (r.body.pushEnabledAt !== null)));
      const g = (await get(C)).body;
      evidence.concurrentMixed = { requests: 30, finalPushEnabled: fin.push_enabled, rows: cnt };
      check('18. 30 concurrent mixed true/false -> all 200, every response internally consistent, one row, final state satisfies the CHECK and equals GET', responsesValid && cnt === 1 && fin.push_enabled === (fin.push_enabled_at !== null) && g.pushEnabled === fin.push_enabled, { responsesValid, cnt, fin, g });
    }

    section('5. Database integrity');
    {
      const tmp = (await one(`insert into users(full_name, email, password_hash, role, status) values ('QA tmp', $1, 'x', 'CUSTOMER', 'ACTIVE') returning id::text id`, [mail('tmp')])).id;
      const errs = {
        enabledWithoutTimestamp: await rejects(`insert into notification_preferences(user_id, push_enabled, push_enabled_at) values ($1, true, null)`, [tmp]),
        disabledWithTimestamp: await rejects(`insert into notification_preferences(user_id, push_enabled, push_enabled_at) values ($1, false, now())`, [tmp]),
        unknownUser: await rejects(`insert into notification_preferences(user_id, push_enabled, push_enabled_at) values (999999999, true, now())`),
        duplicate: await rejects(`insert into notification_preferences(user_id, push_enabled, push_enabled_at) values ($1, true, now())`, [ids.alice]),
        updateToInconsistent: await rejects(`update notification_preferences set push_enabled_at = null where user_id = $1`, [ids.alice]),
      };
      evidence.constraints = errs;
      await db.query(`insert into notification_preferences(user_id, push_enabled, push_enabled_at) values ($1, true, now())`, [tmp]);
      await db.query(`delete from users where id = $1`, [tmp]);
      const cascaded = (await one(`select count(*)::int c from notification_preferences where user_id = $1`, [tmp])).c === 0;
      check('19. DB rejects inconsistent states (23514 both ways, also on UPDATE), unknown users (23503) and a second row per user (23505); user deletion cascades', errs.enabledWithoutTimestamp === '23514' && errs.disabledWithTimestamp === '23514' && errs.updateToInconsistent === '23514' && errs.unknownUser === '23503' && errs.duplicate === '23505' && cascaded, { errs, cascaded });
    }

    section('6. Inbox and devices unaffected');
    {
      const D = await login('owner');
      for (let i = 0; i < 4; i++) await db.query(`insert into notifications(recipient_user_id, type, title, body, event_key) values ($1, 'SYSTEM_ANNOUNCEMENT', 'QA', 'QA prefs inbox', $2)`, [ids.owner, `qa:${RUN}:${i}`]);
      await call('PATCH', '/notifications/read-all', { token: D, body: {} }).catch(() => undefined);
      await db.query(`insert into notifications(recipient_user_id, type, title, body, event_key) values ($1, 'SYSTEM_ANNOUNCEMENT', 'QA', 'QA prefs inbox', $2)`, [ids.owner, `qa:${RUN}:unread`]);
      const fid = 'qaPrefsFid' + randomUUID().replace(/-/g, '').slice(0, 20);
      secrets.push(fid);
      const dev = await call('POST', '/push-devices', { token: D, body: { registrationKind: 'FID', registrationValue: fid, platform: 'WEB' } });
      const snapshot = async () => ({
        list: (await call('GET', '/notifications', { token: D })).body,
        unread: (await call('GET', '/notifications/unread-count', { token: D })).body,
        rows: (await one(`select md5(string_agg(n::text, '|' order by n.id)) h from notifications n where recipient_user_id = $1`, [ids.owner])).h,
        device: await one(`select revoked_at from push_devices where id = $1`, [dev.body?.device?.id]).then((row) => (row ? row.revoked_at : 'missing')), // null = active (not revoked)
      });
      const s0 = await snapshot();
      await patch(D, { pushEnabled: false });
      const s1 = await snapshot();
      await patch(D, { pushEnabled: true });
      await patch(D, { pushEnabled: false });
      const s2 = await snapshot();
      check('22. opt-out / opt-in leave the inbox list, unread count and stored rows identical; the registered device is NOT revoked', dev.status === 200 && JSON.stringify(s0) === JSON.stringify(s1) && JSON.stringify(s1) === JSON.stringify(s2) && s0.device === null && s0.unread.unreadCount === 1, { register: { status: dev.status, body: dev.body }, s0: { unread: s0.unread, device: s0.device }, s2: { unread: s2.unread, device: s2.device } });
      check('opt-in does not require a registered device (Alice has none and is ON)', (await one(`select count(*)::int c from push_devices where user_id = $1 and revoked_at is null`, [ids.alice])).c === 0 && (await rowOf(ids.alice)).push_enabled === true);
    }
    const disabledLogs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    await stopAll();

    section('7. pushAvailable by environment');
    const availability = {};
    for (const [tag, env] of [
      ['mock-worker', { PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'true' }],
      ['firebase-no-worker', { PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-qa-prefs', PUSH_WORKER_ENABLED: 'false' }],
      ['firebase-worker', { PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-qa-prefs', PUSH_WORKER_ENABLED: 'true' }],
    ]) {
      await start(tag, env);
      const t = await login('bob');
      const g = await get(t);
      const p = await patch(t, { pushEnabled: true });
      availability[tag] = { get: g.status, pushAvailable: g.body.pushAvailable, patch: p.status, pushEnabled: p.body.pushEnabled };
      await patch(t, { pushEnabled: false });
      await stopAll();
    }
    evidence.pushAvailable = { disabled: false, ...Object.fromEntries(Object.entries(availability).map(([k, v]) => [k, v.pushAvailable])) };
    check('21. pushAvailable: disabled false, mock+worker false (mock is not real push), firebase without worker false, firebase+worker true; GET/PATCH 200 in every mode; stored preference never changed by the environment', availability['mock-worker'].pushAvailable === false && availability['firebase-no-worker'].pushAvailable === false && availability['firebase-worker'].pushAvailable === true && Object.values(availability).every((v) => v.get === 200 && v.patch === 200 && v.pushEnabled === true), availability);

    section('8. Logs and global');
    const allLogs = disabledLogs + fs.readdirSync(OUT_DIR).filter((d) => d.startsWith('logs-')).flatMap((d) => fs.readdirSync(path.join(OUT_DIR, d)).map((f) => fs.readFileSync(path.join(OUT_DIR, d, f), 'utf8'))).join('\n');
    const leaked = secrets.filter(Boolean).filter((s) => allLogs.includes(s)).length;
    check(`25. logs: no password / JWT secret / tokens / FID (${secrets.length} checked), no Firebase project credentials; preference changes logged as "user <id> -> ON|OFF" only`, leaked === 0 && !/eyJhbGciOi|private_key|client_email/.test(allLogs) && /Push preference of user \d+ -> (ON|OFF)/.test(allLogs), { leaked });
    check('no HTTP 5xx in the whole run', !statuses.some((s) => s >= 500), statuses.filter((s) => s >= 500));
    const dl = await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`);
    check('0 deadlocks', dl.d === 0, dl);
  } finally {
    await stopAll().catch(() => undefined);
    if (ds.isInitialized) await ds.destroy();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'notification-preferences', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
