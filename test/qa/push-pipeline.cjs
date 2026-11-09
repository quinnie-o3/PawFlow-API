/*
 * P3-BE06-07 end-to-end push pipeline — real HTTP + real PostgreSQL
 * (disposable QA database only) + the APPLICATION's own worker and executor
 * with the BE06-04 mock provider (no Firebase, no network):
 *
 *   booking transition -> status log -> inbox notification -> outbox job
 *   -> worker claim -> eligibility re-check -> mock provider
 *   -> per-device outcome rows -> final job state
 *
 * Phases
 *   1  2 instances, mock, worker OFF: failed booking transaction; delayed
 *      jobs for the account-switch case; in-process worker (compiled) for
 *      the boundaries that need a controlled clock: device registered
 *      between attempts, crash after all device rows but before the job is
 *      finalized.
 *   2  2 instances, mock, worker ON (the app's worker + PushDispatchExecutor):
 *      delayed jobs, six booking events, concurrency, partial delivery,
 *      configuration failure, logout racing delivery, deadline.
 *   3  push unset (disabled): inbox only, no jobs, provider disabled.
 *
 *   npm run build
 *   npm run qa:push-pipeline
 *
 * Environment: QA_DB_NAME (default pawflow_qa_push_pipeline), QA_PORTS
 * (default 8281,8282), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_push_pipeline';
const PORTS = (process.env.QA_PORTS ?? '8281,8282').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-pipeline-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaPassword123!';
const RUN = 'p' + Date.now().toString(36);
const TZ = 'Asia/Ho_Chi_Minh';
const vnDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86400000));
const dist = (p) => require(path.join(ROOT, 'dist', p));

const MOCK_WORKER_ENV = {
  PUSH_DELIVERY_MODE: 'mock',
  PUSH_SEND_TIMEOUT_MS: '1000',
  PUSH_WORKER_LEASE_SECONDS: '10',
  PUSH_WORKER_JOB_TIMEOUT_MS: '5000',
  PUSH_WORKER_POLL_MS: '200',
  PUSH_RETRY_BASE_MS: '1000',
  PUSH_DELIVERY_MAX_ATTEMPTS: '3',
  PUSH_WORKER_BATCH_SIZE: '10',
};

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  const { Logger } = require(path.join(ROOT, 'node_modules', '@nestjs', 'common'));
  const inprocLogs = [];
  const sink = (m) => inprocLogs.push(String(m));
  Logger.overrideLogger({ log: sink, warn: sink, error: sink, debug: sink, verbose: sink, fatal: sink });

  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const apps = [];
  const startApps = async (tag, env) => {
    const dir = path.join(OUT_DIR, `logs-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const port of PORTS) {
      const app = createApp(NAME, [port], { logDir: dir, jwtSecret: JWT_SECRET, env });
      await app.start();
      apps.push(app);
    }
  };
  const stopApps = async () => { while (apps.length) await apps.pop().stop(); };
  const raw = createApi(PORTS);
  const statuses = [];
  const api = async (method, url, opts = {}) => {
    const r = await raw(method, url, opts);
    statuses.push({ status: r.status, url, injected: Boolean(opts.injected) });
    return r;
  };
  const waitFor = async (label, fn, ms = 30_000) => {
    const t = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t > ms) throw new Error(`timeout: ${label}`);
      await sleep(150);
    }
  };
  const values = [];
  const val = (prefix = 'qa') => {
    const v = `${prefix}${randomBytes(12).toString('base64url')}`;
    values.push(v);
    return v;
  };
  const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [], extra: { max: 10 } });

  try {
    section('0. Schema');
    const objects = await one(`select to_regclass('notification_deliveries') d, to_regclass('notification_push_sends') s,
      (select count(*)::int from pg_trigger where tgname in ('trg_notification_deliveries_guard','trg_notification_push_sends_immutable')) trg,
      (select count(*)::int from pg_constraint where conname in ('uq_notifications_id_recipient','uq_notification_deliveries_id_recipient','uq_push_devices_id_user','fk_notification_push_sends_device','fk_notification_push_sends_delivery','fk_notification_deliveries_notification')) cons`);
    check(`all ${migrations.length} source migrations applied; 0 pending DDL; outbox, per-device table, both triggers and the 6 BE06 keys exist`, migrations.length === sourceMigrationCount() && pendingDdl.length === 0 && objects.d && objects.s && objects.trg === 2 && objects.cons === 6, { objects, pendingDdl });
    await ds.initialize();

    // ------------------------------------------------------------------ phase 1
    section('1. Worker OFF (mock): setup, failed transaction, delayed jobs, controlled-clock boundaries');
    await startApps('p1', { ...MOCK_WORKER_ENV, PUSH_WORKER_ENABLED: 'false' });
    const mail = (n) => `${n}.${RUN}@qa.test`;
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
    const login = async (n) => { const r = await api('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } }); if (r.status !== 200) throw new Error(`login ${n} ${r.status}`); return r.body.accessToken; };
    const ADMIN = await login('admin');
    const CATEGORY = String((await api('POST', '/admin/service-categories', { token: ADMIN, body: { name: `Grooming ${RUN}` } })).body.id);
    const PET_TYPE = String((await api('POST', '/admin/pet-types', { token: ADMIN, body: { name: `Dog ${RUN}` } })).body.id);
    const register = async (n) => { const r = await api('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD } }); if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body)); return { n, t: r.body.accessToken, id: String(r.body.user.id) }; };
    const customer = async (n) => { const c = await register(n); const pet = await api('POST', '/pets', { token: c.t, body: { petTypeId: PET_TYPE, name: `Pet ${n}` } }); return { ...c, pet: String(pet.body.id) }; };
    const regDevice = async (token, value, kind = 'FID') => { const r = await api('POST', '/push-devices', { token, body: { registrationKind: kind, registrationValue: value, platform: 'WEB' } }); if (r.status !== 200) throw new Error('device ' + r.status); return r.body.device.id; };
    const P = await register('owner');
    const prov = await api('POST', '/providers', { token: P.t, body: { businessName: `${RUN} Spa`, address: 'Street', phone: '0911000000', description: 'QA' } });
    P.pid = String(prov.body.id);
    await api('PATCH', `/admin/providers/${P.pid}/approve`, { token: ADMIN });
    for (let d = 0; d <= 6; d++) await api('POST', '/providers/working-hours', { token: P.t, body: { dayOfWeek: d, startTime: '08:00', endTime: '20:00' } });
    P.service = String((await api('POST', '/services', { token: P.t, body: { categoryId: CATEGORY, name: `Grooming ${RUN}`, price: 150000, durationMinutes: 60, description: 'QA' } })).body.id);
    let slotN = 0;
    const slot = async () => {
      const k = slotN++;
      const h = 8 + (k % 11);
      const r = await api('POST', '/availability', { token: P.t, body: { serviceId: P.service, slotDate: vnDate(2 + Math.floor(k / 11)), startTime: `${String(h).padStart(2, '0')}:00`, endTime: `${String(h + 1).padStart(2, '0')}:00`, capacity: 30 } });
      if (r.status !== 201) throw new Error('slot ' + JSON.stringify(r.body));
      return String(r.body.id);
    };
    const book = async (c, opts = {}) => {
      const r = await api('POST', '/bookings', { token: c.t, key: opts.key, body: { petId: c.pet, slotId: opts.slot ?? (await slot()) }, injected: opts.injected });
      if (r.status !== 201 && !opts.allowFailure) throw new Error('book ' + r.status + JSON.stringify(r.body));
      return r;
    };
    const act = (actor, id, verb, body) => api('POST', `/bookings/provider/${id}/${verb}`, { token: actor.t, body: body ?? (['confirm', 'complete'].includes(verb) ? undefined : {}) });

    const S1 = await register('staff1');
    const S2 = await register('staff2');
    const SOFF = await register('staffoff');
    for (const s of [S1, S2]) await api('POST', '/providers/staff', { token: P.t, body: { userId: s.id, position: 'Groomer' } });
    const off = await api('POST', '/providers/staff', { token: P.t, body: { userId: SOFF.id, position: 'Former' } });
    await api('DELETE', `/providers/staff/${off.body.id}`, { token: P.t });
    S1.t = await login('staff1');
    S2.t = await login('staff2');
    SOFF.t = await login('staffoff');
    const C = await customer('alice');
    const U = await customer('unrelated');
    const dev = {};
    dev.owner1 = await regDevice(P.t, val());
    dev.owner2 = await regDevice(await login('owner'), `${randomBytes(8).toString('base64url')}:APA91b${randomBytes(60).toString('base64url')}`, 'FCM_TOKEN');
    dev.staff1 = await regDevice(S1.t, val());
    dev.staff2 = await regDevice(S2.t, val());
    dev.staffOff = await regDevice(SOFF.t, val());
    dev.customer = await regDevice(C.t, val());
    dev.unrelated = await regDevice(U.t, val());

    // Failed booking transaction: the outbox insert fails -> nothing at all is committed.
    {
      const before = await one(`select (select count(*)::int from bookings) b, (select count(*)::int from notifications) n, (select count(*)::int from notification_deliveries) j`);
      await db.query(`create or replace function qa_fail() returns trigger language plpgsql as $$ begin raise exception 'qa injected failure'; end $$`);
      await db.query(`create trigger qa_fail before insert on notification_deliveries for each row when (new.recipient_user_id = ${Number(P.id)}) execute function qa_fail()`);
      const r = await book(C, { allowFailure: true, injected: true });
      await db.query(`drop trigger qa_fail on notification_deliveries; drop function qa_fail()`);
      const after = await one(`select (select count(*)::int from bookings) b, (select count(*)::int from notifications) n, (select count(*)::int from notification_deliveries) j`);
      check('failed booking transaction (outbox insert fails) -> 500, no booking, no inbox row, no delivery job', r.status === 500 && JSON.stringify(before) === JSON.stringify(after), { status: r.status, before, after });
    }

    // Delayed jobs for the account switch (processed in phase 2 by the app worker).
    const SWA = await customer('swa');
    const SWB = await customer('swb');
    const shared = val();
    dev.swaShared = await regDevice(SWA.t, shared);
    const bSwa = String((await book(SWA)).body.id);
    await act(P, bSwa, 'confirm');
    const jobSwa = await one(`select d.id::text jid, n.id::text nid from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_id = $1 and n.type = 'BOOKING_CONFIRMED'`, [bSwa]);
    await api('POST', '/auth/logout', { token: SWA.t });
    dev.swbShared = await regDevice(SWB.t, shared);
    const bSwb = String((await book(SWB)).body.id);
    await act(P, bSwb, 'confirm');
    const jobSwb = await one(`select d.id::text jid, n.id::text nid from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_id = $1 and n.type = 'BOOKING_CONFIRMED'`, [bSwb]);
    check('account-switch setup: both delayed jobs PENDING; A logged out; the same installation is now B\'s (new device row)', jobSwa && jobSwb && dev.swaShared !== dev.swbShared && (await one(`select revocation_reason r from push_devices where id = $1`, [dev.swaShared])).r === 'SESSION_REVOKED');

    // Controlled-clock boundaries with the compiled worker + executor.
    const { PushDevicesService } = dist('push-devices/push-devices.service.js');
    const { PushDispatchExecutor } = dist('push-delivery/dispatch/push-dispatch.executor.js');
    const { PushJobStore } = dist('push-delivery/worker/push-job.store.js');
    const { PushDeliveryWorker } = dist('push-delivery/worker/push-delivery.worker.js');
    const { MockPushProvider } = dist('push-delivery/provider/push-providers.js');
    const devices = new PushDevicesService(ds, { get: (k) => ({ JWT_SECRET, NODE_ENV: 'test' })[k] });
    const mock = new MockPushProvider(10_000);
    let offsetMs = 0;
    const clock = () => new Date(Date.now() + offsetMs);
    const WCFG = { enabled: true, batchSize: 5, pollMs: 200, leaseSeconds: 10, jobTimeoutMs: 5_000, maxAttempts: 5, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 500 };
    const worker = (store, id) => new PushDeliveryWorker(store ?? new PushJobStore(ds, clock), WCFG, new PushDispatchExecutor(ds, devices, mock, { now: () => clock().getTime() }), { random: () => 0.5, now: () => clock().getTime(), workerId: id });
    const jobOfBooking = (bid, type) => one(`select d.id::text jid, n.id::text nid, d.status, d.attempt_count, d.last_error_category cat from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_id = $1 and n.type = $2`, [bid, type]);
    const rowsOf = (jid) => all(`select push_device_id::text dev, outcome, attempt from notification_push_sends where delivery_id = $1 order by push_device_id`, [jid]);
    const mockSends = (nid) => mock.history().filter((h) => h.notificationId === nid);
    // only the jobs of these in-process scenarios are due for the in-process worker
    const parkOthers = (keep) => db.query(`update notification_deliveries set status = 'PROCESSING', lease_owner = 'qa-parked', lease_expires_at = now() + interval '1 hour', attempt_count = attempt_count + 1 where status = 'PENDING' and id <> all($1::bigint[])`, [keep]);
    const unpark = () => db.query(`update notification_deliveries set status = 'PENDING', lease_owner = null, lease_expires_at = null, next_attempt_at = now() where lease_owner = 'qa-parked'`);
    {
      // A device registered between attempts receives the notification on the retry (same recipient only).
      const N = await customer('newdev');
      const nA = await regDevice(N.t, val());
      const nB = await regDevice(await login('newdev'), val('mockUnavail'));
      const bid = String((await book(N)).body.id);
      await act(P, bid, 'confirm');
      const j = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      await parkOthers([j.jid]);
      offsetMs = 0;
      await worker(undefined, 'inproc-1').runOnce();
      const afterFirst = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      const nD = await regDevice(await login('newdev'), val()); // registered AFTER attempt 1
      offsetMs = 120_000;
      await worker(undefined, 'inproc-2').runOnce();
      offsetMs = 0;
      const rows = await rowsOf(j.jid);
      const byDev = Object.fromEntries(rows.map((r) => [r.dev, r]));
      evidence.newDeviceOnRetry = { attempt1: afterFirst.status, rows: rows.map((r) => `${r.dev === nA ? 'A' : r.dev === nD ? 'D(new)' : 'B'}:${r.outcome}@${r.attempt}`), sendsA: mockSends(j.nid).filter((h) => h.destinationFingerprint && true).length };
      check('A. device registered after attempt 1 receives the notification on attempt 2 (recipient\'s own device); A not re-sent; B still retried', afterFirst.status === 'PENDING' && byDev[nA]?.attempt === 1 && byDev[nD]?.attempt === 2 && !byDev[nB] && mockSends(j.nid).length === 1 + 1 + 2, { evidence: evidence.newDeviceOnRetry, mock: mockSends(j.nid).length });
      await db.query(`update notification_deliveries set status = 'EXPIRED', completed_at = now(), last_error_category = 'EXPIRED' where id = $1 and status = 'PENDING'`, [j.jid]);
      await unpark();
    }
    {
      // Crash after every device row was saved but BEFORE the job was finalized (complete() fails).
      const F = await customer('finalize');
      await regDevice(F.t, val());
      await regDevice(await login('finalize'), val());
      const bid = String((await book(F)).body.id);
      await act(P, bid, 'confirm');
      const j = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      await parkOthers([j.jid]);
      const store = new PushJobStore(ds, clock);
      const crashing = Object.create(store);
      crashing.complete = () => Promise.reject(Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }));
      offsetMs = 0;
      const t1 = await worker(crashing, 'crash-before-final').runOnce();
      const mid = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      const rowsMid = await rowsOf(j.jid);
      offsetMs = 11_000;
      const t2 = await worker(undefined, 'recovery').runOnce();
      offsetMs = 0;
      const fin = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      evidence.crashBeforeFinalize = { firstTick: t1.outcomes, stateAfterCrash: mid.status, rowsAfterCrash: rowsMid.length, recoveryTick: t2.outcomes, final: fin.status, attempts: fin.attempt_count, providerSends: mockSends(j.nid).length };
      check('B. crash after both device rows were saved but before the job was finalized: job left PROCESSING; recovery completes it (DONE) WITHOUT re-sending (2 sends total)', t1.outcomes.PERSIST_FAILED === 1 && mid.status === 'PROCESSING' && rowsMid.length === 2 && fin.status === 'DONE' && fin.attempt_count === 2 && mockSends(j.nid).length === 2, evidence.crashBeforeFinalize);
      await unpark();
    }
    await stopApps();

    // ------------------------------------------------------------------ phase 2
    section('2. Worker ON in both app instances (app worker + PushDispatchExecutor + mock provider)');
    await startApps('p2', { ...MOCK_WORKER_ENV, PUSH_WORKER_ENABLED: 'true' });
    for (const u of [P, S1, S2, C]) u.t = await login(u.n);
    const allDone = (jids) => waitFor('jobs settled', async () => (await one(`select count(*)::int c from notification_deliveries where id = any($1::bigint[]) and status in ('PENDING','PROCESSING')`, [jids])).c === 0);
    {
      await allDone([jobSwa.jid, jobSwb.jid]);
      const a = await one(`select status, last_error_category cat from notification_deliveries where id = $1`, [jobSwa.jid]);
      const aRows = await rowsOf(jobSwa.jid);
      const bRows = await rowsOf(jobSwb.jid);
      const bInbox = await api('GET', '/notifications', { token: SWB.t });
      evidence.accountSwitch = { jobA: `${a.status}/${a.cat}`, rowsA: aRows.length, rowsB: bRows.map((r) => r.dev === dev.swbShared ? 'B-device' : r.dev) };
      check("C. account switch: A's delayed job sends to nothing (NO_DESTINATIONS); B's job reaches the shared installation via B's device row only; B's inbox has no A notification", a.status === 'DONE' && a.cat === 'NO_DESTINATIONS' && aRows.length === 0 && bRows.length === 1 && bRows[0].dev === dev.swbShared && !JSON.stringify(bInbox.body).includes(`"id":"${jobSwa.nid}"`), evidence.accountSwitch);
    }

    // Six booking events end to end.
    const b1 = String((await book(C, { key: `key-${RUN}-0001-pipeline` })).body.id);
    await book(C, { key: `key-${RUN}-0001-pipeline`, slot: (await one(`select slot_id::text s from bookings where id = $1`, [b1])).s });
    await act(S1, b1, 'confirm');
    await act(S2, b1, 'complete');
    const b2 = String((await book(C)).body.id);
    await act(S1, b2, 'reject', { reason: 'PRIVATE reason 0909123456' });
    const b3 = String((await book(C)).body.id);
    await api('POST', `/bookings/mine/${b3}/cancel`, { token: C.t, body: { reason: 'PRIVATE reason' } });
    const b4slot = await slot();
    const b4 = String((await book(C, { slot: b4slot })).body.id);
    await act(P, b4, 'confirm');
    await db.query(`update availability_slots set slot_date = $2 where id = $1`, [b4slot, vnDate(-1)]);
    await act(P, b4, 'no-show', { reason: 'PRIVATE' });
    const bookingIds = [b1, b2, b3, b4];
    const jobs = await all(`select d.id::text jid, n.id::text nid, n.type, n.recipient_user_id::text r, n.event_key, n.target_id::text bid from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_type = 'BOOKING' and n.target_id = any($1::bigint[]) order by n.id`, [bookingIds]);
    await allDone(jobs.map((j) => j.jid));
    const activeDevicesOf = async (uid) => (await all(`select id::text from push_devices where user_id = $1 and revoked_at is null order by id`, [uid])).map((r) => r.id);
    const ownerSide = [P.id, S1.id, S2.id].sort();
    const perType = {};
    let allMatch = true;
    const mismatches = [];
    for (const j of jobs) {
      const rows = await rowsOf(j.jid);
      const expected = await activeDevicesOf(j.r);
      perType[j.type] = perType[j.type] ?? new Set();
      perType[j.type].add(j.r);
      const ok = rows.length === expected.length && rows.every((x) => expected.includes(x.dev) && x.outcome === 'ACCEPTED' && x.attempt === 1) && (await one(`select status from notification_deliveries where id = $1`, [j.jid])).status === 'DONE';
      if (!ok) { allMatch = false; mismatches.push({ type: j.type, r: j.r, rows, expected }); }
    }
    const recipients = Object.fromEntries(Object.entries(perType).map(([t, s]) => [t, [...s].sort()]));
    evidence.sixEvents = { notifications: jobs.length, recipients };
    check('six events: BOOKING_CREATED/CANCELLED -> owner + 2 ACTIVE staff; CONFIRMED/REJECTED/COMPLETED/NO_SHOW -> customer; never the inactive staff or the unrelated user', JSON.stringify(recipients.BOOKING_CREATED) === JSON.stringify(ownerSide) && JSON.stringify(recipients.BOOKING_CANCELLED) === JSON.stringify(ownerSide) && ['BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'BOOKING_COMPLETED', 'BOOKING_NO_SHOW'].every((t) => JSON.stringify(recipients[t]) === JSON.stringify([C.id])), recipients);
    check('every job DONE by the app worker; per-device rows = exactly the recipient\'s active devices (owner: FID + legacy token), all ACCEPTED on attempt 1', allMatch, mismatches.slice(0, 3));
    const keys = await one(`select count(*)::int bad from notifications n where n.target_type = 'BOOKING' and n.target_id = any($1::bigint[]) and not exists (select 1 from booking_status_logs l where n.event_key = 'booking:' || l.booking_id || ':log:' || l.id)`, [bookingIds]);
    const dupes = await one(`select count(*)::int c from (select recipient_user_id, event_key from notifications where event_key like 'booking:%' group by 1,2 having count(*) > 1) x`);
    const jobsPerNotif = await one(`select count(*)::int c from (select notification_id from notification_deliveries group by 1 having count(*) > 1) x`);
    const strayRows = await one(`select count(*)::int c from notification_push_sends where push_device_id = any($1::bigint[])`, [[dev.staffOff, dev.unrelated]]);
    const leakedReason = await one(`select count(*)::int c from notifications where body ilike '%PRIVATE%' or payload::text ilike '%PRIVATE%'`);
    check('event keys = booking:{id}:log:{statusLogId}; idempotent replay added nothing; no duplicate notifications; one job per notification; no row for the inactive staff or unrelated user device; no reason text in notifications', keys.bad === 0 && dupes.c === 0 && jobsPerNotif.c === 0 && strayRows.c === 0 && leakedReason.c === 0, { keys, dupes, jobsPerNotif, strayRows, leakedReason });

    // Concurrent duplicate transitions across both instances.
    {
      const bc = String((await book(C)).body.id);
      const conf = await Promise.all(Array.from({ length: 8 }, (_, i) => act([P, S1, S2][i % 3], bc, 'confirm')));
      const j = await jobOfBooking(bc, 'BOOKING_CONFIRMED');
      await allDone([j.jid]);
      const n = await one(`select count(*)::int c from notifications where target_id = $1 and type = 'BOOKING_CONFIRMED'`, [bc]);
      check('D. 8 concurrent confirms (2 instances): one 2xx + 7 409, one notification, one job, delivered once', conf.filter((r) => [200, 201].includes(r.status)).length === 1 && conf.filter((r) => r.status === 409).length === 7 && n.c === 1 && (await rowsOf(j.jid)).length === 1, conf.map((r) => r.status));
    }
    // A. Partial delivery through the app worker.
    {
      const Q = await customer('partial');
      const dA = await regDevice(Q.t, val());
      const dB = await regDevice(await login('partial'), val('mockUnavail'));
      const dC = await regDevice(await login('partial'), val('mockUnreg'));
      const bid = String((await book(Q)).body.id);
      await act(P, bid, 'confirm');
      const j = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      await allDone([j.jid]);
      const fin = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      const rows = await rowsOf(j.jid);
      const devs = await all(`select id::text, revocation_reason r from push_devices where id = any($1::bigint[]) order by id`, [[dA, dB, dC]]);
      evidence.partialApp = { job: `${fin.status}/${fin.cat}`, attempts: fin.attempt_count, rows: rows.map((r) => `${r.dev === dA ? 'A' : r.dev === dC ? 'C' : 'B'}:${r.outcome}@${r.attempt}`), revoked: devs.map((d) => d.r) };
      check('A. app worker: A ACCEPTED@1 and C INVALID_DESTINATION@1 written once; B retried until max attempts (3) -> job FAILED (TRANSIENT, documented terminal); only C revoked', fin.status === 'FAILED' && fin.cat === 'TRANSIENT' && fin.attempt_count === 3 && rows.length === 2 && rows.every((r) => r.attempt === 1) && devs.find((d) => d.id === dC).r === 'INVALID_REGISTRATION' && devs.filter((d) => d.r).length === 1, evidence.partialApp);
    }
    // E. Configuration failure: no revocation; inbox intact.
    {
      const K = await customer('config');
      const dOk = await regDevice(K.t, val());
      const dBad = await regDevice(await login('config'), val('mockAuth'));
      const bid = String((await book(K)).body.id);
      await act(P, bid, 'confirm');
      const j = await jobOfBooking(bid, 'BOOKING_CONFIRMED');
      const pending = await waitFor('configuration retry scheduled', async () => { const x = await jobOfBooking(bid, 'BOOKING_CONFIRMED'); return x.status === 'PENDING' && x.attempt_count === 1 ? x : null; });
      const delay = await one(`select extract(epoch from next_attempt_at - updated_at)::int s from notification_deliveries where id = $1`, [j.jid]);
      const devs = await all(`select revoked_at from push_devices where id = any($1::bigint[])`, [[dOk, dBad]]);
      const inbox = await api('GET', '/notifications', { token: K.t });
      check('E. CONFIGURATION: job retried slowly (>= 5 min), no device revoked, inbox keeps the notification', pending.cat === 'CONFIGURATION' && delay.s >= 239 && devs.every((d) => d.revoked_at === null) && JSON.stringify(inbox.body).includes('Booking confirmed'), { pending, delay, devs });
      await db.query(`update notification_deliveries set status = 'EXPIRED', completed_at = now(), last_error_category = 'EXPIRED' where id = $1 and status = 'PENDING'`, [j.jid]);
    }
    // D. Logout racing delivery.
    {
      const L = await customer('race');
      const dL = await regDevice(L.t, val());
      const bids = [];
      for (let i = 0; i < 6; i++) bids.push(String((await book(L)).body.id));
      const [, ...confs] = await Promise.all([sleep(15).then(() => api('POST', '/auth/logout', { token: L.t })), ...bids.map((b) => act(P, b, 'confirm'))]);
      const lJobs = await all(`select d.id::text jid from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_id = any($1::bigint[]) and n.type = 'BOOKING_CONFIRMED'`, [bids]);
      await allDone(lJobs.map((x) => x.jid));
      const late = await one(`select count(*)::int c, (select revoked_at from push_devices where id = $1) revoked from notification_push_sends s join push_devices d on d.id = s.push_device_id where s.push_device_id = $1 and s.attempted_at > d.revoked_at + interval '1 second'`, [dL]);
      const sent = (await one(`select count(*)::int c from notification_push_sends where push_device_id = $1`, [dL])).c;
      evidence.logoutRace = { confirms: confs.map((r) => r.status), deliveredBeforeLogout: sent, sendsStartedAfterRevocation: late.c };
      check('D. logout racing 6 confirmations: all confirms succeed; no send to the device started after its revocation (beyond the 1 s in-flight window)', confs.every((r) => [200, 201].includes(r.status)) && late.c === 0 && late.revoked, evidence.logoutRace);
    }
    // E. Deadline: an overdue job is expired by the app worker, never sent.
    {
      const nid = (await one(`insert into notifications(recipient_user_id, type, title, body, event_key) values ($1, 'SYSTEM_ANNOUNCEMENT', 'QA', 'QA', $2) returning id::text id`, [C.id, `qa:${RUN}:deadline`])).id;
      const jid = (await one(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at, next_attempt_at) values ($1, $2, now() + interval '1 second', now() + interval '5 minutes') returning id::text id`, [nid, C.id])).id;
      await sleep(1_500);
      const r = await waitFor('deadline expiry', async () => { const x = await one(`select status from notification_deliveries where id = $1`, [jid]); return x.status === 'EXPIRED' ? x : null; }, 10_000);
      check('E. job past its deadline is EXPIRED by the app worker without any send', r.status === 'EXPIRED' && (await rowsOf(jid)).length === 0);
    }
    const p2logs = fs.readdirSync(path.join(OUT_DIR, 'logs-p2')).map((f) => fs.readFileSync(path.join(OUT_DIR, 'logs-p2', f), 'utf8')).join('\n');
    check('app workers started on both instances and processed jobs (no Firebase)', (p2logs.match(/Push delivery worker \S+ started/g) ?? []).length === 2 && /Push dispatch job \d+/.test(p2logs) && !/firebase|googleapis/i.test(p2logs));
    await stopApps();

    // ------------------------------------------------------------------ phase 3
    section('3. Push disabled (unset): inbox only');
    await startApps('p3', {});
    for (const u of [P, C]) u.t = await login(u.n);
    {
      const jobsBefore = (await one(`select count(*)::int c from notification_deliveries`)).c;
      const bd = String((await book(C)).body.id);
      await act(P, bd, 'confirm');
      const notes = (await one(`select count(*)::int c from notifications where target_id = $1`, [bd])).c;
      const jobsAfter = (await one(`select count(*)::int c from notification_deliveries`)).c;
      const p3logs = fs.readdirSync(path.join(OUT_DIR, 'logs-p3')).map((f) => fs.readFileSync(path.join(OUT_DIR, 'logs-p3', f), 'utf8')).join('\n');
      check('E. disabled: booking events still create inbox notifications, 0 delivery jobs; provider disabled, worker disabled, no Firebase', notes === 4 && jobsAfter === jobsBefore && /Push provider: disabled/.test(p3logs) && /worker disabled/.test(p3logs) && !/firebase/i.test(p3logs), { notes, jobsBefore, jobsAfter });
    }
    await stopApps();

    section('4. Global invariants');
    const allLogs = fs.readdirSync(OUT_DIR).filter((d) => d.startsWith('logs-')).flatMap((d) => fs.readdirSync(path.join(OUT_DIR, d)).map((f) => fs.readFileSync(path.join(OUT_DIR, d, f), 'utf8'))).join('\n') + inprocLogs.join('\n');
    const unexpected500 = statuses.filter((s) => s.status >= 500 && !s.injected);
    const dl = await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`);
    evidence.http = { requests: statuses.length, unexpected5xx: unexpected500.length, deadlocks: dl.d, deadlockLogLines: (allLogs.match(/40P01|deadlock detected/g) ?? []).length };
    check('no unexpected HTTP 5xx; 0 deadlocks (database counter and logs)', unexpected500.length === 0 && dl.d === 0 && evidence.http.deadlockLogLines === 0, { unexpected500: unexpected500.slice(0, 5), dl });
    check(`no registration value (${values.length}) in any app or worker log`, !values.some((v) => allLogs.includes(v)));
  } finally {
    await stopApps().catch(() => undefined);
    if (ds.isInitialized) await ds.destroy();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'push-pipeline', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
