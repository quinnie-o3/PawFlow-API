/*
 * P3-BE06-06 device eligibility, provider dispatch and per-device delivery
 * persistence — real HTTP (auth / device lifecycle) + real PostgreSQL
 * (disposable QA database only). The worker + PushDispatchExecutor run
 * in-process from dist/ with a controlled clock; the provider is the BE06-04
 * MockPushProvider wrapped by a deterministic QA script (no Firebase, no
 * network). Two scenarios kill a real child worker process (SIGKILL).
 *
 *   npm run build
 *   npm run qa:push-dispatch
 *
 * Environment: QA_DB_NAME (default pawflow_qa_push_dispatch), QA_PORTS (default 8271),
 * QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createHash, randomBytes, randomUUID } = require('crypto');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');

const fp = (v) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const dist = (p) => require(path.join(ROOT, 'dist', p));

/** QA provider: BE06-04 MockPushProvider + per-value scripts / gates; records fingerprints only. */
function makeQaProvider({ hangPrefix = null, marker = null } = {}) {
  const { MockPushProvider } = dist('push-delivery/provider/push-providers.js');
  const mock = new MockPushProvider(10_000);
  const sent = [];
  const overrides = new Map();
  const gates = new Map();
  const provider = {
    name: 'mock',
    mock,
    sent,
    overrides,
    gate(value) {
      let release;
      let signalEntered;
      const g = { promise: new Promise((r) => (release = r)), enter: new Promise((r) => (signalEntered = r)) };
      g.release = release;
      g.signalEntered = signalEntered;
      gates.set(value, g);
      return g;
    },
    async send(dest, msg) {
      const n = sent.filter((s) => s.fp === fp(dest.value)).length + 1;
      sent.push({ fp: fp(dest.value), kind: dest.kind, notificationId: msg.notificationId, ttl: msg.ttlSeconds, n, pid: process.pid });
      if (marker) fs.appendFileSync(marker, JSON.stringify({ fp: fp(dest.value), notificationId: msg.notificationId, pid: process.pid }) + '\n');
      if (hangPrefix && dest.value.startsWith(hangPrefix)) await new Promise(() => undefined); // dies here
      const g = gates.get(dest.value);
      if (g) {
        gates.delete(dest.value);
        g.signalEntered();
        await g.promise;
      }
      const o = overrides.get(dest.value);
      const scripted = o ? o(n) : undefined;
      return scripted ?? mock.send(dest, msg);
    },
  };
  return provider;
}

// ---------------------------------------------------------------- child mode
// node push-dispatch.cjs --child <db> <jwtSecret> <markerFile>
if (process.argv[2] === '--child') {
  (async () => {
    const [, , , dbName, jwtSecret, marker] = process.argv;
    const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
    const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: dbName, synchronize: false, entities: [] });
    await ds.initialize();
    const { PushDevicesService } = dist('push-devices/push-devices.service.js');
    const { PushDispatchExecutor } = dist('push-delivery/dispatch/push-dispatch.executor.js');
    const { PushJobStore } = dist('push-delivery/worker/push-job.store.js');
    const { PushDeliveryWorker } = dist('push-delivery/worker/push-delivery.worker.js');
    const devices = new PushDevicesService(ds, { get: (k) => ({ JWT_SECRET: jwtSecret, NODE_ENV: 'test' })[k] });
    const executor = new PushDispatchExecutor(ds, devices, makeQaProvider({ hangPrefix: 'qaHang', marker }), { concurrency: 1 });
    const w = new PushDeliveryWorker(new PushJobStore(ds), { enabled: true, batchSize: 1, pollMs: 200, leaseSeconds: 10, jobTimeoutMs: 600_000, maxAttempts: 5, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 0 }, executor, { workerId: 'child-crash' });
    await w.runOnce();
  })().catch((e) => {
    console.error(e);
    process.exit(3);
  });
  return;
}

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_push_dispatch';
const PORT = Number(process.env.QA_PORTS ?? 8271);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-dispatch-'));
const OUTBOX = path.join(OUT_DIR, 'mail');
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaPassword123!';
const RUN = 'x' + Date.now().toString(36);
const NEW_MIGRATION = 'CreateNotificationDeliveries1796500000000';

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const { Logger } = require(path.join(ROOT, 'node_modules', '@nestjs', 'common'));
  const logs = [];
  const sink = (m) => logs.push(String(m));
  Logger.overrideLogger({ log: sink, warn: sink, error: sink, debug: sink, verbose: sink, fatal: sink });

  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const rejects = (sql, params) => db.query(sql, params).then(() => null, (e) => e.code);
  const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
  const newDs = (name) => new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')], extra: { max: 10, application_name: name } });
  const dsA = newDs('qa-dispatch-a');
  const dsB = newDs('qa-dispatch-b');
  let app = null;

  try {
    section('0. Schema and migration');
    check(`all ${migrations.length} source migrations applied (incl. ${NEW_MIGRATION}); entities = schema (0 pending DDL)`, migrations.length === sourceMigrationCount() && migrations.at(-1) === NEW_MIGRATION && pendingDdl.length === 0, { pendingDdl });
    const cols = (await all(`select column_name from information_schema.columns where table_name = 'notification_push_sends' order by ordinal_position`)).map((r) => r.column_name);
    check('notification_push_sends: ids, outcome, code, attempt, timestamps only (no FID/token/payload/message id column)', cols.join() === 'id,delivery_id,recipient_user_id,push_device_id,outcome,provider_code,attempt,attempted_at,finalized_at', cols);
    const fks = (await all(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'notification_push_sends'::regclass and contype in ('f','u') order by conname`)).map((r) => `${r.conname}: ${r.d}`);
    evidence.sendConstraints = fks;
    check('composite FKs pin job and device to the same recipient; UNIQUE (delivery_id, push_device_id)', fks.some((f) => /fk_notification_push_sends_delivery: FOREIGN KEY \(delivery_id, recipient_user_id\) REFERENCES notification_deliveries\(id, recipient_user_id\) ON DELETE CASCADE/.test(f)) && fks.some((f) => /fk_notification_push_sends_device: FOREIGN KEY \(push_device_id, recipient_user_id\) REFERENCES push_devices\(id, user_id\) ON DELETE CASCADE/.test(f)) && fks.some((f) => /uq_notification_push_sends_delivery_device: UNIQUE \(delivery_id, push_device_id\)/.test(f)), fks);
    await dsA.initialize();
    await dsB.initialize();
    {
      const before = await one(`select (select count(*)::int from pg_constraint where conrelid = 'push_devices'::regclass) pd, (select count(*)::int from pg_constraint where conrelid = 'notifications'::regclass) nc`);
      await dsA.undoLastMigration({ transaction: 'each' });
      const after = await one(`select to_regclass('notification_push_sends') s, to_regclass('notification_deliveries') d, (select count(*)::int from pg_constraint where conname = 'uq_push_devices_id_user') uq, (select count(*)::int from pg_constraint where conrelid = 'push_devices'::regclass) pd, (select count(*)::int from pg_constraint where conrelid = 'notifications'::regclass) nc, (select count(*)::int from pg_proc where proname in ('notification_push_sends_immutable','notification_deliveries_guard')) fn, to_regclass('push_devices') p`);
      const again = await dsA.runMigrations({ transaction: 'each' });
      const pend = (await dsA.driver.createSchemaBuilder().log()).upQueries.length;
      check('29. migration down removes only BE06 objects (both tables, functions, the 2 added uniques); push_devices/notifications keep their own constraints; up again -> 0 pending DDL', after.s === null && after.d === null && after.uq === 0 && after.fn === 0 && after.p !== null && after.pd === before.pd - 1 && after.nc === before.nc - 1 && again.length === 1 && pend === 0, { before, after, pend });
    }

    // ------------------------------------------------------------------ setup
    app = createApp(NAME, [PORT], { logDir: OUT_DIR, jwtSecret: JWT_SECRET, env: { PUSH_DELIVERY_MODE: 'mock', MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: OUTBOX, MAIL_LINK_BASE_URL: 'http://fe.qa.test' } });
    await app.start();
    const api = createApi([PORT]);
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
    const mail = (n) => `${n}.${RUN}@qa.test`;
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
    const login = async (n, password = PASSWORD) => {
      const r = await api('POST', '/auth/login', { body: { email: mail(n), password } });
      if (r.status !== 200) throw new Error(`login ${n} ${r.status}`);
      return { t: r.body.accessToken };
    };
    const ADMIN = await login('admin');
    const values = [];
    const val = (prefix = 'qa') => {
      const v = `${prefix}${randomBytes(12).toString('base64url')}`;
      values.push(v);
      return v;
    };
    const tokenVal = () => {
      const v = `${randomBytes(8).toString('base64url')}:APA91b${randomBytes(60).toString('base64url')}`;
      values.push(v);
      return v;
    };
    const user = async (n) => {
      const r = await api('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD } });
      if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body));
      return { n, id: String(r.body.user.id), t: r.body.accessToken };
    };
    const reg = async (session, value, kind = 'FID') => {
      const r = await api('POST', '/push-devices', { token: session.t, body: { registrationKind: kind, registrationValue: value, platform: 'WEB' } });
      if (r.status !== 200) throw new Error('reg ' + r.status + JSON.stringify(r.body));
      return r.body.device.id;
    };
    const makeJob = async (userId, expiresSeconds = 3600) => {
      const nid = (await one(`insert into notifications(recipient_user_id, type, title, body, payload, target_type, target_id, event_key) values ($1, 'BOOKING_CONFIRMED', 'QA push', 'QA push body', '{}'::jsonb, 'BOOKING', 1, $2) returning id::text id`, [userId, `qa:${RUN}:${randomUUID()}`])).id;
      const jid = (await one(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at, next_attempt_at) values ($1, $2, now() + make_interval(secs => $3), now() - interval '1 minute') returning id::text id`, [nid, userId, expiresSeconds])).id;
      return { nid, jid };
    };
    const jobRow = (jid) => one(`select status, attempt_count, last_error_category cat, last_error_code code, lease_owner, extract(epoch from next_attempt_at - updated_at) * 1000 delay from notification_deliveries where id = $1`, [jid]);
    const sendRows = (jid) => all(`select push_device_id::text dev, outcome, provider_code code, attempt from notification_push_sends where delivery_id = $1 order by push_device_id`, [jid]);
    const device = (id) => one(`select revoked_at, revocation_reason reason from push_devices where id = $1`, [id]);

    const { PushDevicesService } = dist('push-devices/push-devices.service.js');
    const { PushDispatchExecutor } = dist('push-delivery/dispatch/push-dispatch.executor.js');
    const { PushJobStore } = dist('push-delivery/worker/push-job.store.js');
    const { PushDeliveryWorker } = dist('push-delivery/worker/push-delivery.worker.js');
    const devicesA = new PushDevicesService(dsA, { get: (k) => ({ JWT_SECRET, NODE_ENV: 'test' })[k] });
    const devicesB = new PushDevicesService(dsB, { get: (k) => ({ JWT_SECRET, NODE_ENV: 'test' })[k] });
    const provider = makeQaProvider();
    const sentFor = (nid) => provider.sent.filter((s) => s.notificationId === nid);

    let offsetMs = 0;
    const clock = () => new Date(Date.now() + offsetMs);
    const CFG = { enabled: true, batchSize: 5, pollMs: 200, leaseSeconds: 10, jobTimeoutMs: 20_000, maxAttempts: 4, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 1_000 };
    const makeWorker = ({ ds = dsA, devices = devicesA, prov = provider, cfg = {}, id, concurrency = 4, clk = clock } = {}) =>
      new PushDeliveryWorker(new PushJobStore(ds, clk), { ...CFG, ...cfg }, new PushDispatchExecutor(ds, devices, prov, { now: () => clk().getTime(), concurrency }), { random: () => 0.5, now: () => clk().getTime(), workerId: id });
    const run = (opts) => makeWorker(opts).runOnce();
    const quiesce = () => db.query(`update notification_deliveries set status = 'EXPIRED', completed_at = now(), lease_owner = null, lease_expires_at = null where status in ('PENDING','PROCESSING')`);

    // ------------------------------------------------------------------ basics
    section('1. Dispatch basics and provider outcomes');
    {
      const z = await user('zero');
      const j = await makeJob(z.id);
      await run();
      const r = await jobRow(j.jid);
      check('1. zero eligible devices -> DONE (NO_DESTINATIONS), nothing sent', r.status === 'DONE' && r.cat === 'NO_DESTINATIONS' && sentFor(j.nid).length === 0, r);
    }
    {
      const u = await user('one');
      const d = await reg(u, val());
      const j = await makeJob(u.id);
      await run();
      const r = await jobRow(j.jid);
      const rows = await sendRows(j.jid);
      const s = sentFor(j.nid);
      check('2 + 4 + 6. one FID device -> sent once as FID with TTL = remaining window; ACCEPTED persisted; job DONE', r.status === 'DONE' && rows.length === 1 && rows[0].dev === d && rows[0].outcome === 'ACCEPTED' && rows[0].code === null && s.length === 1 && s[0].kind === 'FID' && s[0].ttl > 3500 && s[0].ttl <= 3600, { r, rows, s });
    }
    {
      const u = await user('multi');
      const s2 = await login('multi');
      const d1 = await reg(u, val());
      const d2 = await reg(s2, tokenVal(), 'FCM_TOKEN');
      const j = await makeJob(u.id);
      provider.mock.reset();
      await run();
      const rows = await sendRows(j.jid);
      const fields = provider.mock.history().filter((h) => h.notificationId === j.nid).map((h) => h.field).sort();
      check('3 + 5. two devices (FID + legacy token) -> both ACCEPTED; the provider used `fid` and `token` respectively', (await jobRow(j.jid)).status === 'DONE' && rows.map((x) => x.dev).sort().join() === [d1, d2].sort().join() && rows.every((x) => x.outcome === 'ACCEPTED') && fields.join() === 'fid,token', { rows, fields });
    }
    {
      const u = await user('outcomes');
      const sess = [u, await login('outcomes'), await login('outcomes'), await login('outcomes'), await login('outcomes'), await login('outcomes')];
      const ids = {};
      for (const [i, k] of ['mockUnreg', 'mockInvArg'].entries()) ids[k] = await reg(sess[i], val(k));
      const j = await makeJob(u.id);
      await run();
      const rows = await sendRows(j.jid);
      const byDev = Object.fromEntries(rows.map((x) => [x.dev, x]));
      const unreg = await device(ids.mockUnreg);
      const invarg = await device(ids.mockInvArg);
      check('7. INVALID_DESTINATION -> final row + that device revoked (INVALID_REGISTRATION)', byDev[ids.mockUnreg]?.outcome === 'INVALID_DESTINATION' && byDev[ids.mockUnreg].code === 'messaging/installation-id-not-registered' && unreg.reason === 'INVALID_REGISTRATION', { byDev, unreg });
      check('8. INVALID_REQUEST -> final row, device NOT revoked; job DONE (all devices final)', byDev[ids.mockInvArg]?.outcome === 'INVALID_REQUEST' && invarg.revoked_at === null && (await jobRow(j.jid)).status === 'DONE', { invarg });
    }
    for (const [label, prefix, expect] of [
      ['9. INVALID_PAYLOAD -> job FAILED (shared terminal), no row, device NOT revoked', 'mockPayload', { status: 'FAILED', cat: 'INVALID_PAYLOAD' }],
      ['10. TRANSIENT -> job PENDING (retry +30 s), no row, device kept', 'mockUnavail', { status: 'PENDING', cat: 'TRANSIENT', delay: 30_000 }],
      ['11. RATE_LIMITED with Retry-After -> PENDING >= 60 s', 'mockRate', { status: 'PENDING', cat: 'RATE_LIMITED', delay: 60_000 }],
      ['12. CONFIGURATION -> PENDING (>= 5 min), device NOT revoked', 'mockAuth', { status: 'PENDING', cat: 'CONFIGURATION', delay: 300_000 }],
    ]) {
      const u = await user(`o${prefix}`);
      const d = await reg(u, val(prefix));
      const j = await makeJob(u.id);
      await run();
      const r = await jobRow(j.jid);
      const dev = await device(d);
      const ok = r.status === expect.status && r.cat === expect.cat && (await sendRows(j.jid)).length === 0 && dev.revoked_at === null && (expect.delay === undefined || Math.abs(r.delay - expect.delay) < 50);
      check(label, ok, { r, dev });
      evidence[`outcome_${prefix}`] = { status: r.status, cat: r.cat, delayMs: expect.delay ? Math.round(r.delay) : null };
      await quiesce();
      // 30. inbox unaffected by push failures
      const inbox = await api('GET', '/notifications', { token: u.t });
      if (prefix === 'mockAuth') check('30. inbox keeps the notification despite push failures (GET /notifications)', inbox.status === 200 && JSON.stringify(inbox.body).includes('QA push'), inbox.status);
    }

    section('2. Partial delivery: A ACCEPTED, B TRANSIENT, C INVALID_DESTINATION');
    {
      const u = await user('three');
      const sB = await login('three');
      const sC = await login('three');
      const vA = val();
      const vB = val('qaFlaky');
      const vC = val('mockUnreg');
      const dA = await reg(u, vA);
      const dB = await reg(sB, vB);
      const dC = await reg(sC, vC);
      provider.overrides.set(vB, (n) => (n === 1 ? { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: false, retryAfterMs: null } : undefined));
      offsetMs = 0;
      const j = await makeJob(u.id);
      await run();
      const r1 = await jobRow(j.jid);
      const rows1 = await sendRows(j.jid);
      const c = await device(dC);
      check('13. attempt 1: job PENDING (not DONE after partial success); A ACCEPTED and C INVALID_DESTINATION persisted; C revoked; B unresolved', r1.status === 'PENDING' && r1.cat === 'TRANSIENT' && rows1.map((x) => `${x.dev}:${x.outcome}`).join() === `${dA}:ACCEPTED,${dC}:INVALID_DESTINATION` && c.reason === 'INVALID_REGISTRATION', { r1, rows1, c });
      offsetMs = 31_000;
      await run();
      const r2 = await jobRow(j.jid);
      const rows2 = await sendRows(j.jid);
      const counts = Object.fromEntries([vA, vB, vC].map((v) => [v === vA ? 'A' : v === vB ? 'B' : 'C', provider.sent.filter((s) => s.fp === fp(v)).length]));
      evidence.threeDevice = { attempt1: r1.status, attempt2: r2.status, sends: counts, rows: rows2.map((x) => `${x.outcome}@${x.attempt}`) };
      check('14. attempt 2: only B is sent (A and C not resent); B ACCEPTED; job DONE; A/C rows unchanged from attempt 1', r2.status === 'DONE' && r2.attempt_count === 2 && counts.A === 1 && counts.B === 2 && counts.C === 1 && rows2.length === 3 && rows2.find((x) => x.dev === dB)?.attempt === 2 && rows2.find((x) => x.dev === dA)?.attempt === 1, evidence.threeDevice);
      offsetMs = 0;
    }

    section('3. Crash recovery (real child process killed with SIGKILL)');
    const childRun = async (marker, waitFor) => {
      const child = spawn(process.execPath, [__filename, '--child', NAME, JWT_SECRET, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const t0 = Date.now();
      while (!(await waitFor()) && Date.now() - t0 < 20_000) await sleep(100);
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      return out;
    };
    const markers = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    {
      await quiesce();
      const u = await user('crash1');
      const s2 = await login('crash1');
      const vA = val();
      const vB = val('qaHang');
      const dA = await reg(u, vA);
      await reg(s2, vB);
      const j = await makeJob(u.id);
      const marker = path.join(OUT_DIR, 'child-after-save.jsonl');
      const out = await childRun(marker, async () => markers(marker).some((m) => m.fp === fp(vB)) && (await sendRows(j.jid)).some((x) => x.dev === dA));
      const rowsCrash = await sendRows(j.jid);
      offsetMs = 60_000;
      await run({ id: 'recovery-1' });
      offsetMs = 0;
      const rows = await sendRows(j.jid);
      const childSends = markers(marker);
      const parentA = provider.sent.filter((s) => s.fp === fp(vA)).length;
      const parentB = provider.sent.filter((s) => s.fp === fp(vB)).length;
      evidence.crashAfterSave = { childSendsA: childSends.filter((m) => m.fp === fp(vA)).length, childSendsB: childSends.filter((m) => m.fp === fp(vB)).length, recoverySendsA: parentA, recoverySendsB: parentB, rows: rows.map((x) => `${x.outcome}@${x.attempt}`), job: (await jobRow(j.jid)).status };
      check('15. crash after A was saved (B in flight): A row survives; recovery skips A, sends B; A sent exactly once in total; job DONE', rowsCrash.length === 1 && evidence.crashAfterSave.childSendsA === 1 && parentA === 0 && parentB === 1 && rows.length === 2 && evidence.crashAfterSave.job === 'DONE', { ...evidence.crashAfterSave, out: out.slice(-200) });
    }
    {
      await quiesce();
      const u = await user('crash2');
      const vA = val('qaHang');
      await reg(u, vA);
      const j = await makeJob(u.id);
      const marker = path.join(OUT_DIR, 'child-before-save.jsonl');
      await childRun(marker, async () => markers(marker).some((m) => m.fp === fp(vA)));
      const before = await sendRows(j.jid);
      offsetMs = 60_000;
      await run({ id: 'recovery-2' });
      offsetMs = 0;
      const rows = await sendRows(j.jid);
      evidence.crashBeforeSave = { childSends: markers(marker).length, recoverySends: provider.sent.filter((s) => s.fp === fp(vA)).length, rowsBefore: before.length, rowsAfter: rows.map((x) => `${x.outcome}@${x.attempt}`) };
      check('16. crash after the provider accepted but before saving: no row; recovery sends again (documented at-least-once duplicate) and saves attempt 2', before.length === 0 && evidence.crashBeforeSave.childSends === 1 && evidence.crashBeforeSave.recoverySends === 1 && rows.length === 1 && rows[0].attempt === 2, evidence.crashBeforeSave);
    }

    section('4. Lease fencing');
    {
      await quiesce();
      const u = await user('lease');
      const s2 = await login('lease');
      const vA = val('qaGate');
      const vB = val();
      const dA = await reg(u, vA);
      const dB = await reg(s2, vB);
      const j = await makeJob(u.id);
      const g = provider.gate(vA);
      provider.overrides.set(vA, () => ({ outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' }));
      const w1 = makeWorker({ id: 'stale-w1', concurrency: 1 });
      const p1 = w1.runOnce();
      await g.enter; // W1 is inside the provider call for A
      provider.overrides.delete(vA);
      const later = () => new Date(Date.now() + 11_000);
      const t2 = await makeWorker({ ds: dsB, devices: devicesB, id: 'fresh-w2', clk: later }).runOnce();
      g.release();
      const t1 = await p1;
      const rows = await sendRows(j.jid);
      const a = await device(dA);
      evidence.lostLease = { w1: t1.outcomes, w2: t2.outcomes, rows: rows.map((x) => `${x.dev === dA ? 'A' : 'B'}:${x.outcome}@${x.attempt}`), deviceA: a.reason };
      check('17. stale worker (lease taken over while its send was in flight): its INVALID_DESTINATION is not written, device A NOT revoked by it, LOST_LEASE; the new owner wrote all rows (attempt 2)', t1.outcomes.LOST_LEASE === 1 && t2.outcomes.DONE === 1 && rows.length === 2 && rows.every((x) => x.attempt === 2) && rows.every((x) => x.outcome === 'ACCEPTED') && a.revoked_at === null && dB, evidence.lostLease);
    }

    section('5. Session, account and registration changes before dispatch');
    const noSendAfter = async (label, prep, act) => {
      await quiesce();
      const ctx = await prep();
      const j = await makeJob(ctx.u.id);
      const res = await act(ctx);
      await run();
      const r = await jobRow(j.jid);
      check(label, (res === undefined || res) && r.status === 'DONE' && r.cat === 'NO_DESTINATIONS' && sentFor(j.nid).length === 0 && (await sendRows(j.jid)).length === 0, { r, res });
    };
    await noSendAfter('18. logout before dispatch -> nothing sent', async () => { const u = await user('lo'); await reg(u, val()); return { u }; }, async ({ u }) => (await api('POST', '/auth/logout', { token: u.t })).status === 204);
    await noSendAfter('19. logout-all before dispatch (2 sessions) -> nothing sent', async () => { const u = await user('loa'); const s = await login('loa'); await reg(u, val()); await reg(s, val()); return { u }; }, async ({ u }) => (await api('POST', '/auth/logout-all', { token: u.t })).status === 204);
    await noSendAfter('20. password reset before dispatch -> nothing sent', async () => { const u = await user('pr'); await reg(u, val()); return { u }; }, async () => {
      const fg = await api('POST', '/auth/forgot-password', { body: { email: mail('pr') } });
      let token = null;
      for (let i = 0; i < 100 && !token; i++) {
        const m = fs.readdirSync(OUTBOX).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8'))).find((x) => x.to === mail('pr') && x.category === 'PASSWORD_RESET');
        if (m) token = /#token=([A-Za-z0-9_-]{43})/.exec(m.text)[1];
        else await sleep(50);
      }
      const rs = await api('POST', '/auth/reset-password', { body: { token, newPassword: 'ResetPassword789!' } });
      return fg.status === 202 && rs.status === 204;
    });
    await noSendAfter('21. account suspended before dispatch -> nothing sent', async () => { const u = await user('su'); await reg(u, val()); return { u }; }, async ({ u }) => (await api('PATCH', `/admin/users/${u.id}/suspend`, { token: ADMIN.t })).status === 200);
    {
      // Race: the session ends AFTER target selection but BEFORE the send.
      await quiesce();
      const u = await user('race');
      await reg(u, val());
      const j = await makeJob(u.id);
      const racing = Object.create(devicesA);
      racing.findSendTargets = async (id) => {
        const t = await devicesA.findSendTargets(id);
        await api('POST', '/auth/logout', { token: u.t });
        return t;
      };
      await run({ devices: racing });
      const r = await jobRow(j.jid);
      check('18b. logout between target selection and send -> the per-device re-check skips it; nothing sent', r.status === 'DONE' && r.cat === 'NO_DESTINATIONS' && sentFor(j.nid).length === 0, r);
    }
    {
      await quiesce();
      const A = await user('swa');
      const B = await user('swb');
      const shared = val();
      await reg(A, shared);
      const jA = await makeJob(A.id);
      await api('POST', '/auth/logout', { token: A.t });
      const reuse = await api('POST', '/push-devices', { token: A.t, body: { registrationKind: 'FID', registrationValue: val(), platform: 'WEB' } });
      const dB = await reg(B, shared);
      const jB = await makeJob(B.id);
      await run();
      const toShared = provider.sent.filter((s) => s.fp === fp(shared));
      const aInbox = await api('GET', '/notifications', { token: (await login('swa')).t });
      const bInbox = await api('GET', '/notifications', { token: B.t });
      const crossInsert = await rejects(`insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, attempt, attempted_at) values ($1, $2, $3, 'ACCEPTED', 1, now())`, [jA.jid, A.id, dB]);
      evidence.accountSwitch = { jobA: (await jobRow(jA.jid)).cat, jobB: (await jobRow(jB.jid)).status, sendsToSharedInstallation: toShared.map((s) => (s.notificationId === jA.nid ? 'A' : 'B')), revokedSessionRegister: reuse.status, crossInsert };
      check("22. account switch: A's old job sends nothing to the installation now owned by B; B's job is delivered to it once; revoked session cannot register (401)", evidence.accountSwitch.jobA === 'NO_DESTINATIONS' && evidence.accountSwitch.jobB === 'DONE' && toShared.length === 1 && toShared[0].notificationId === jB.nid && reuse.status === 401, evidence.accountSwitch);
      check("22. inbox isolation: A keeps its notification, B never sees it; a send row tying A's job to B's device is impossible (FK 23503)", JSON.stringify(aInbox.body).includes('QA push') && !JSON.stringify(bInbox.body.items ?? bInbox.body).includes(jA.nid) && crossInsert === '23503', { a: aInbox.status, crossInsert });
    }
    {
      await quiesce();
      const A = await user('tra');
      const B = await user('trb');
      const shared = val();
      await reg(A, shared);
      const jA = await makeJob(A.id);
      await reg(B, shared); // transfer while A is still logged in
      await run();
      check('22b. installation transferred to another account (A still logged in): A\'s job sends nothing to it', (await jobRow(jA.jid)).cat === 'NO_DESTINATIONS' && sentFor(jA.nid).length === 0);
    }
    {
      await quiesce();
      const u = await user('rot');
      const v1 = val();
      const v2 = val();
      const d1 = await reg(u, v1);
      const j = await makeJob(u.id);
      const d2 = await reg(u, v2); // rotation on the same session before dispatch
      await run();
      const rows = await sendRows(j.jid);
      check('23. registration rotated before dispatch -> only the new registration (new device row) receives it', d1 !== d2 && rows.length === 1 && rows[0].dev === d2 && provider.sent.filter((s) => s.fp === fp(v1)).length === 0 && provider.sent.filter((s) => s.fp === fp(v2) && s.notificationId === j.nid).length === 1 && (await device(d1)).reason === 'ROTATED', rows);
    }
    {
      await quiesce();
      const u = await user('late');
      const v1 = val('qaGate');
      const d1 = await reg(u, v1);
      const j = await makeJob(u.id);
      const g = provider.gate(v1);
      provider.overrides.set(v1, () => ({ outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' }));
      const p = run();
      await g.enter;
      const d2 = await reg(u, val()); // rotates while the send for v1 is in flight
      g.release();
      await p;
      provider.overrides.delete(v1);
      const old = await device(d1);
      const fresh = await device(d2);
      const rows = await sendRows(j.jid);
      check('24. delayed INVALID_DESTINATION for the old registration after rotation: recorded for the OLD row only; old stays ROTATED, the new registration stays active', rows.length === 1 && rows[0].dev === d1 && rows[0].outcome === 'INVALID_DESTINATION' && old.reason === 'ROTATED' && fresh.revoked_at === null, { rows, old, fresh });

      const v3 = val('qaGate');
      const s3 = await login('late');
      const d3 = await reg(s3, v3);
      const j3 = await makeJob(u.id);
      const g3 = provider.gate(v3);
      provider.overrides.set(v3, () => ({ outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' }));
      const p3 = run();
      await g3.enter;
      await sleep(20);
      await reg(s3, v3); // same installation re-registers (REFRESHED) after the attempt started
      g3.release();
      await p3;
      provider.overrides.delete(v3);
      check('24b. delayed INVALID_DESTINATION after the same registration re-registered -> markInvalid keeps it active (last_seen_at > attempt)', (await device(d3)).revoked_at === null && (await sendRows(j3.jid)).find((x) => x.dev === d3)?.outcome === 'INVALID_DESTINATION');
    }

    section('6. Deadline, cancellation, two workers');
    {
      await quiesce();
      const u = await user('dl');
      await reg(u, val());
      const j = await makeJob(u.id, 100);
      offsetMs = 101_000;
      await run();
      offsetMs = 0;
      const r = await jobRow(j.jid);
      const j2 = await makeJob(u.id, 3);
      offsetMs = 2_500; // claimable (deadline not reached) but < 1 s left for a send
      await run();
      offsetMs = 0;
      const r2 = await jobRow(j2.jid);
      check('25. deadline: overdue job EXPIRED without sending; a job with < 1 s left is not sent and EXPIRES', r.status === 'EXPIRED' && sentFor(j.nid).length === 0 && r2.status === 'EXPIRED' && sentFor(j2.nid).length === 0, { r, r2 });
    }
    {
      await quiesce();
      const u = await user('cancel');
      const s2 = await login('cancel');
      const s3 = await login('cancel');
      const v1 = val();
      const v2 = val('qaGate');
      const v3 = val();
      await reg(u, v1);
      await reg(s2, v2);
      await reg(s3, v3);
      const j = await makeJob(u.id);
      const g = provider.gate(v2);
      const w = makeWorker({ id: 'cancel-w', concurrency: 1, cfg: { shutdownGraceMs: 100, batchSize: 1 } });
      w.start();
      await g.enter;
      await w.stop(); // grace exceeded -> abort while v2 is in flight
      g.release();
      await sleep(300);
      const mid = await sendRows(j.jid);
      const sentMid = [v1, v2, v3].map((v) => provider.sent.filter((s) => s.fp === fp(v) && s.notificationId === j.nid).length);
      offsetMs = 11_000;
      await run({ id: 'after-cancel' });
      offsetMs = 0;
      const final = await sendRows(j.jid);
      const sentFinal = [v1, v2, v3].map((v) => provider.sent.filter((s) => s.fp === fp(v) && s.notificationId === j.nid).length);
      evidence.cancellation = { rowsAfterStop: mid.length, sendsAfterStop: sentMid, finalRows: final.length, finalSends: sentFinal, job: (await jobRow(j.jid)).status };
      check('26. cancellation: no new send after abort (device 3 untouched), outcomes already obtained are kept; recovery sends only device 3; each device exactly once', sentMid.join() === '1,1,0' && mid.length === 2 && sentFinal.join() === '1,1,1' && final.length === 3 && evidence.cancellation.job === 'DONE', evidence.cancellation);
    }
    {
      await quiesce();
      const jobs = [];
      for (let i = 0; i < 10; i++) {
        const u = await user(`tw${i}`);
        await reg(u, val());
        await reg(await login(`tw${i}`), val());
        jobs.push(await makeJob(u.id));
      }
      const wA = makeWorker({ id: 'inst-a', cfg: { batchSize: 3 } });
      const wB = makeWorker({ ds: dsB, devices: devicesB, id: 'inst-b', cfg: { batchSize: 3 } });
      for (let round = 0; round < 6; round++) await Promise.all([wA.runOnce(), wB.runOnce()]);
      const statuses = await all(`select status from notification_deliveries where id = any($1::bigint[])`, [jobs.map((j) => j.jid)]);
      const sends = provider.sent.filter((s) => jobs.some((j) => j.nid === s.notificationId));
      const pairs = new Set(sends.map((s) => `${s.notificationId}/${s.fp}`));
      const rowCount = (await one(`select count(*)::int c from notification_push_sends where delivery_id = any($1::bigint[])`, [jobs.map((j) => j.jid)])).c;
      evidence.twoWorkers = { jobs: 10, done: statuses.filter((s) => s.status === 'DONE').length, sends: sends.length, distinctPairs: pairs.size, rows: rowCount };
      check('27. two worker instances, 10 jobs x 2 devices -> 20 sends, 20 distinct (job, device) pairs, 20 rows, all DONE', evidence.twoWorkers.done === 10 && sends.length === 20 && pairs.size === 20 && rowCount === 20, evidence.twoWorkers);
    }

    section('7. Integrity and logs');
    {
      const [r] = await all(`select delivery_id::text d, recipient_user_id::text r, push_device_id::text p from notification_push_sends limit 1`);
      const errs = {
        duplicate: await rejects(`insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, attempt, attempted_at) values ($1, $2, $3, 'ACCEPTED', 1, now())`, [r.d, r.r, r.p]),
        update: await rejects(`update notification_push_sends set outcome = 'INVALID_REQUEST', provider_code = 'x/y' where delivery_id = $1`, [r.d]),
        badOutcome: await rejects(`insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, attempt, attempted_at) values ($1, $2, $3, 'SENT', 1, now())`, [r.d, r.r, r.p]),
        acceptedWithCode: await rejects(`insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, provider_code, attempt, attempted_at) values ($1, $2, $3, 'ACCEPTED', 'x/y', 1, now())`, [r.d, r.r, r.p]),
        failureWithoutCode: await rejects(`insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, attempt, attempted_at) values ($1, $2, $3, 'INVALID_REQUEST', 1, now())`, [r.d, r.r, r.p]),
        codeWithSecret: await rejects(`insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, provider_code, attempt, attempted_at) values ($1, $2, $3, 'INVALID_REQUEST', 'fid abc leaked', 1, now())`, [r.d, r.r, r.p]),
        wrongRecipient: await rejects(
          `insert into notification_push_sends(delivery_id, recipient_user_id, push_device_id, outcome, attempt, attempted_at)
           select $1, $2, d.id, 'ACCEPTED', 1, now() from push_devices d where d.user_id <> $2 order by d.id limit 1`,
          [r.d, r.r],
        ),
      };
      evidence.constraintErrors = errs;
      check('29. constraints: duplicate 23505; UPDATE refused (insert-only) 23514; bad outcome / code rules / non-token code 23514; wrong recipient 23503', errs.duplicate === '23505' && errs.update === '23514' && errs.badOutcome === '23514' && errs.acceptedWithCode === '23514' && errs.failureWithoutCode === '23514' && errs.codeWithSecret === '23514' && errs.wrongRecipient === '23503', errs);
      const victim = await one(`select s.push_device_id::text p from notification_push_sends s join push_devices d on d.id = s.push_device_id where d.revoked_at is not null limit 1`);
      await db.query(`delete from push_devices where id = $1`, [victim.p]);
      check('29. deleting a (revoked) device row (P3-BE05 retention) cascades its send rows', (await one(`select count(*)::int c from notification_push_sends where push_device_id = $1`, [victim.p])).c === 0);
    }
    {
      const appLog = fs.readFileSync(path.join(OUT_DIR, `app-${NAME}-${PORT}.log`), 'utf8');
      const text = logs.join('\n') + '\n' + appLog;
      fs.writeFileSync(path.join(OUT_DIR, 'qa-logs.txt'), logs.join('\n'));
      const tokens = (await all(`select distinct lease_owner from notification_deliveries where lease_owner is not null`)).map((x) => x.lease_owner);
      const leaked = values.filter((v) => text.includes(v));
      const dbLeak = await one(`select count(*)::int c from notification_push_sends where provider_code ~ $1`, [values.slice(0, 50).map((v) => v.replace(/[^A-Za-z0-9]/g, '')).join('|') || 'zzz']);
      check(`28. no registration value (${values.length} used), lease token or notification content in logs; none stored in send rows`, leaked.length === 0 && !tokens.some((t) => text.includes(t)) && !/QA push body/.test(text) && dbLeak.c === 0, { leaked: leaked.length });
      check('dispatch logs are structured counts per job', /Push dispatch job \d+ \(notification \d+, attempt \d+\): devices=\d+ alreadyFinal=\d+ accepted=\d+/.test(text));
    }
    const dl = await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`);
    check('0 deadlocks', dl.d === 0, dl);
  } finally {
    if (app) await app.stop().catch(() => undefined);
    for (const ds of [dsA, dsB]) if (ds.isInitialized) await ds.destroy().catch(() => undefined);
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'push-dispatch', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
