/*
 * P3-BE07-03 push consent enforcement — real HTTP + real PostgreSQL
 * (disposable QA database only). The compiled worker + PushDispatchExecutor
 * run in-process with a controlled clock and the BE06-04 mock provider
 * wrapped by a deterministic QA script (no Firebase, no network). Phase 2
 * uses the APPLICATION's own worker on instance B while preferences are
 * changed through instance A, with real booking transitions.
 *
 *   npm run build
 *   npm run qa:push-consent
 *
 * Environment: QA_DB_NAME (default pawflow_qa_push_consent), QA_PORTS
 * (default 8311,8312), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_push_consent';
const PORTS = (process.env.QA_PORTS ?? '8311,8312').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-consent-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaConsentPass123!';
const RUN = 'pc' + Date.now().toString(36);
const TZ = 'Asia/Ho_Chi_Minh';
const fp = (v) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const dist = (p) => require(path.join(ROOT, 'dist', p));
const vnDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86400000));

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);

/** BE06-04 MockPushProvider + per-value scripts and gates; records fingerprints only. */
function makeQaProvider() {
  const { MockPushProvider } = dist('push-delivery/provider/push-providers.js');
  const mock = new MockPushProvider(10_000);
  const sent = [];
  const overrides = new Map();
  const gates = new Map();
  return {
    name: 'mock',
    sent,
    overrides,
    gate(value) {
      let release;
      let signal;
      const g = { promise: new Promise((r) => (release = r)), enter: new Promise((r) => (signal = r)) };
      g.release = release;
      g.signal = signal;
      gates.set(value, g);
      return g;
    },
    async send(dest, msg) {
      const n = sent.filter((s) => s.fp === fp(dest.value)).length + 1;
      sent.push({ fp: fp(dest.value), notificationId: msg.notificationId, n });
      const g = gates.get(dest.value);
      if (g) {
        gates.delete(dest.value);
        g.signal();
        await g.promise;
      }
      const o = overrides.get(dest.value);
      return (o ? o(n) : undefined) ?? mock.send(dest, msg);
    },
  };
}

async function main() {
  const { Logger } = require(path.join(ROOT, 'node_modules', '@nestjs', 'common'));
  const logs = [];
  const sink = (m) => logs.push(String(m));
  Logger.overrideLogger({ log: sink, warn: sink, error: sink, debug: sink, verbose: sink, fatal: sink });

  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
  const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [], extra: { max: 10 } });
  const apps = [];
  const start = async (tag, port, env) => {
    const dir = path.join(OUT_DIR, `logs-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const app = createApp(NAME, [port], { logDir: dir, jwtSecret: JWT_SECRET, env });
    await app.start();
    apps.push(app);
  };
  const stopAll = async () => { while (apps.length) await apps.pop().stop(); };
  const api = createApi(PORTS);
  const statuses = [];
  const call = async (method, url, opts = {}) => { const r = await api(method, url, opts); statuses.push(r.status); return r; };
  const values = [];
  const secrets = [PASSWORD, JWT_SECRET];
  const val = (prefix = 'qa') => { const v = `${prefix}${randomBytes(12).toString('base64url')}`; values.push(v); return v; };
  const mail = (n) => `${n}.${RUN}@qa.test`;

  try {
    check(`all ${migrations.length} source migrations applied; 0 pending DDL`, migrations.length === sourceMigrationCount() && pendingDdl.length === 0, pendingDdl);
    await ds.initialize();
    await start('a', PORTS[0], { PUSH_DELIVERY_MODE: 'mock' });
    await start('b', PORTS[1], { PUSH_DELIVERY_MODE: 'mock' });
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
    const login = async (n, port) => { const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD }, port }); if (r.status !== 200) throw new Error(`login ${n} ${r.status}`); secrets.push(r.body.accessToken); return { t: r.body.accessToken }; };
    const ADMIN = await login('admin');
    const user = async (n) => { const r = await call('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD } }); if (r.status !== 201) throw new Error('register ' + r.status); secrets.push(r.body.accessToken); return { n, id: String(r.body.user.id), t: r.body.accessToken }; };
    let flip = 0;
    const setPush = async (u, on, port) => { const r = await call('PATCH', '/notification-preferences', { token: u.t, body: { pushEnabled: on }, port: port ?? PORTS[flip++ % 2] }); if (r.status !== 200) throw new Error('pref ' + r.status); return r.body; };
    const reg = async (session, value) => { const r = await call('POST', '/push-devices', { token: session.t, body: { registrationKind: 'FID', registrationValue: value, platform: 'WEB' } }); if (r.status !== 200) throw new Error('reg ' + r.status); return r.body.device.id; };
    const makeJob = async (userId) => {
      const nid = (await one(`insert into notifications(recipient_user_id, type, title, body, payload, target_type, target_id, event_key) values ($1, 'BOOKING_CONFIRMED', 'QA consent', 'QA consent body', '{}'::jsonb, 'BOOKING', 1, $2) returning id::text id`, [userId, `qa:${RUN}:${randomUUID()}`])).id;
      const jid = (await one(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at, next_attempt_at) values ($1, $2, now() + interval '1 hour', now() - interval '1 minute') returning id::text id`, [nid, userId])).id;
      return { nid, jid };
    };
    const jobRow = (jid) => one(`select status, attempt_count, last_error_category cat, last_error_code code from notification_deliveries where id = $1`, [jid]);
    const rowsOf = (jid) => all(`select push_device_id::text dev, outcome, attempt from notification_push_sends where delivery_id = $1 order by push_device_id`, [jid]);
    const inboxHas = async (u, nid) => JSON.stringify((await call('GET', '/notifications', { token: u.t })).body).includes(`"id":"${nid}"`);
    const deviceActive = async (id) => (await one(`select revoked_at from push_devices where id = $1`, [id])).revoked_at === null;

    const { PushDevicesService } = dist('push-devices/push-devices.service.js');
    const { PushDispatchExecutor } = dist('push-delivery/dispatch/push-dispatch.executor.js');
    const { PushJobStore } = dist('push-delivery/worker/push-job.store.js');
    const { PushDeliveryWorker } = dist('push-delivery/worker/push-delivery.worker.js');
    const { NotificationPreferencesService } = dist('notification-preferences/notification-preferences.service.js');
    const devices = new PushDevicesService(ds, { get: (k) => ({ JWT_SECRET, NODE_ENV: 'test' })[k] });
    const consent = new NotificationPreferencesService(ds, { get: () => undefined });
    const provider = makeQaProvider();
    const sendsOf = (nid) => provider.sent.filter((s) => s.notificationId === nid);
    let offsetMs = 0;
    const clock = () => new Date(Date.now() + offsetMs);
    const CFG = { enabled: true, batchSize: 10, pollMs: 200, leaseSeconds: 10, jobTimeoutMs: 20_000, maxAttempts: 4, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 500 };
    const worker = ({ consentSvc = consent, concurrency = 4, clk = clock, id, consentTimeoutMs } = {}) =>
      new PushDeliveryWorker(new PushJobStore(ds, clk), CFG, new PushDispatchExecutor(ds, devices, provider, consentSvc, { now: () => clk().getTime(), concurrency, consentTimeoutMs }), { random: () => 0.5, now: () => clk().getTime(), workerId: id });
    const run = (o) => worker(o).runOnce();
    const quiesce = () => db.query(`update notification_deliveries set status = 'EXPIRED', completed_at = now(), lease_owner = null, lease_expires_at = null where status in ('PENDING','PROCESSING')`);
    const suppressed = (r) => r.status === 'DONE' && r.cat === 'PUSH_OPTED_OUT' && r.code === 'pawflow/push-opted-out';

    // ------------------------------------------------------------------ enforcement
    section('1. Preference enforcement (in-process worker, controlled clock)');
    {
      await quiesce();
      const u = await user('nopref');
      const d = await reg(u, val());
      const j = await makeJob(u.id);
      await run();
      const r = await jobRow(j.jid);
      check('1 + 14. no preference row -> job DONE PUSH_OPTED_OUT, 0 sends, 0 rows; inbox keeps it; device NOT revoked', suppressed(r) && sendsOf(j.nid).length === 0 && (await rowsOf(j.jid)).length === 0 && (await inboxHas(u, j.nid)) && (await deviceActive(d)), r);
    }
    {
      const u = await user('off');
      await setPush(u, true);
      await setPush(u, false);
      await reg(u, val());
      const j = await makeJob(u.id);
      await run();
      check('2. explicit OFF -> suppressed, nothing sent', suppressed(await jobRow(j.jid)) && sendsOf(j.nid).length === 0);
    }
    {
      const u = await user('on');
      await setPush(u, true);
      await reg(u, val());
      await reg((await login('on')), val());
      const j = await makeJob(u.id);
      await run();
      const r = await jobRow(j.jid);
      const rows = await rowsOf(j.jid);
      check('3 + 21. ON with 2 devices -> DONE (delivered), 2 ACCEPTED rows, 2 sends', r.status === 'DONE' && r.cat === null && rows.length === 2 && rows.every((x) => x.outcome === 'ACCEPTED') && sendsOf(j.nid).length === 2, { r, rows });
    }
    {
      const u = await user('nodev');
      await setPush(u, true);
      const j = await makeJob(u.id);
      await run();
      const r = await jobRow(j.jid);
      check('4 + 14. ON without devices -> DONE NO_DESTINATIONS (consent is independent of devices)', r.status === 'DONE' && r.cat === 'NO_DESTINATIONS');
    }
    {
      const u = await user('epoch');
      const p1 = await setPush(u, true);
      await reg(u, val());
      const old = await makeJob(u.id);
      await setPush(u, false);
      const p2 = await setPush(u, true);
      const fresh = await makeJob(u.id);
      await run();
      check('5 + 11. OFF -> ON starts a new consent period: the older notification is suppressed (stays in the inbox), the newer one is delivered', Date.parse(p2.pushEnabledAt) > Date.parse(p1.pushEnabledAt) && suppressed(await jobRow(old.jid)) && sendsOf(old.nid).length === 0 && (await inboxHas(u, old.nid)) && (await jobRow(fresh.jid)).status === 'DONE' && sendsOf(fresh.nid).length === 1, { p1: p1.pushEnabledAt, p2: p2.pushEnabledAt });
    }
    {
      const u = await user('repeat');
      const p1 = await setPush(u, true, PORTS[0]);
      await reg(u, val());
      const j = await makeJob(u.id);
      const p2 = await setPush(u, true, PORTS[1]);
      await run();
      check('6. repeated ON (other instance) keeps the period -> the pending notification is still delivered', p1.pushEnabledAt === p2.pushEnabledAt && sendsOf(j.nid).length === 1 && (await jobRow(j.jid)).status === 'DONE');
    }
    {
      const u = await user('preclaim');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      await setPush(u, false);
      await run();
      check('7. opt-out while the job waits (before claim) -> suppressed, nothing sent', suppressed(await jobRow(j.jid)) && sendsOf(j.nid).length === 0);
    }
    {
      // Opt-out lands after the attempt-start check but before device selection.
      const u = await user('preselect');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      let calls = 0;
      const racing = { getPushConsentForNotification: async (uid, nid) => { const c = await consent.getPushConsentForNotification(uid, nid); if (++calls === 1) await setPush(u, false); return c; } };
      await run({ consentSvc: racing });
      check('8. opt-out between the attempt-start check and device selection -> per-device re-check suppresses; nothing sent', suppressed(await jobRow(j.jid)) && sendsOf(j.nid).length === 0 && calls === 2, { calls });
    }
    {
      // Opt-out while device 1's send is in flight (concurrency 1).
      const u = await user('midsend');
      await setPush(u, true);
      const v1 = val('qaGate');
      const v2 = val();
      const d1 = await reg(u, v1);
      await reg(await login('midsend'), v2);
      const j = await makeJob(u.id);
      const g = provider.gate(v1);
      const p = run({ concurrency: 1 });
      await g.enter;
      await setPush(u, false);
      g.release();
      await p;
      const rows = await rowsOf(j.jid);
      check('9. opt-out between selection and send: the in-flight send completes and is recorded; the next device is never sent; job DONE PUSH_OPTED_OUT', suppressed(await jobRow(j.jid)) && rows.length === 1 && rows[0].dev === d1 && provider.sent.filter((s) => s.fp === fp(v2)).length === 0, rows);
    }
    {
      // Critical scenario: A ACCEPTED, B RATE_LIMITED (stops the attempt), C not yet sent; then opt-out.
      await quiesce();
      const u = await user('critical');
      await setPush(u, true);
      const [vA, vB, vC] = [val(), val('qaB'), val()];
      const dA = await reg(u, vA);
      await reg(await login('critical'), vB);
      await reg(await login('critical'), vC);
      provider.overrides.set(vB, (n) => (n === 1 ? { outcome: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 60_000 } : undefined));
      const j = await makeJob(u.id);
      offsetMs = 0;
      await run({ concurrency: 1 });
      const r1 = await jobRow(j.jid);
      await setPush(u, false);
      offsetMs = 61_000;
      await run({ concurrency: 1 });
      const r2 = await jobRow(j.jid);
      const counts = [vA, vB, vC].map((v) => provider.sent.filter((s) => s.fp === fp(v)).length);
      const rows = await rowsOf(j.jid);
      await setPush(u, true);
      offsetMs = 2 * 3_600_000;
      const again = await run({ concurrency: 1 });
      offsetMs = 0;
      evidence.critical = { attempt1: `${r1.status}/${r1.cat}`, afterOptOut: `${r2.status}/${r2.cat}`, sendsABC: counts, rows: rows.map((x) => `${x.dev === dA ? 'A' : x.dev}:${x.outcome}@${x.attempt}`), reclaimedAfterOptIn: again.claimed };
      check('10 + 28 (critical). A ACCEPTED, B rate-limited, C unsent -> opt-out -> job DONE PUSH_OPTED_OUT; A row durable; B and C never sent again; inbox intact; re-enabling does not reactivate the job', r1.status === 'PENDING' && suppressed(r2) && rows.length === 1 && rows[0].dev === dA && rows[0].attempt === 1 && counts.join() === '1,1,0' && again.claimed === 0 && (await jobRow(j.jid)).status === 'DONE' && (await inboxHas(u, j.nid)), evidence.critical);
    }
    {
      const u = await user('storm');
      await setPush(u, true);
      await reg(u, val());
      const jobs = [];
      for (let i = 0; i < 5; i++) jobs.push(await makeJob(u.id));
      const storm = await Promise.all(Array.from({ length: 20 }, (_, i) => call('PATCH', '/notification-preferences', { token: u.t, body: { pushEnabled: i % 4 !== 1 }, port: PORTS[i % 2] })));
      const pref = await one(`select push_enabled, push_enabled_at from notification_preferences where user_id = $1`, [u.id]);
      await run();
      const rows = await Promise.all(jobs.map((j) => jobRow(j.jid)));
      evidence.storm = { requests: 20, statuses: [...new Set(storm.map((r) => r.status))], finalPushEnabled: pref.push_enabled, suppressedJobs: rows.filter(suppressed).length };
      check('12. 20 concurrent OFF/ON requests (2 instances): the authoritative final state decides; jobs created before the latest consent period are all suppressed, none sent (no stale positive decision)', storm.every((r) => r.status === 200) && rows.every(suppressed) && jobs.every((j) => sendsOf(j.nid).length === 0), evidence.storm);
    }
    {
      // Equality and sub-millisecond boundaries, evaluated by PostgreSQL (microseconds).
      await quiesce();
      const u = await user('boundary');
      await setPush(u, true);
      await reg(u, val());
      const j1 = await makeJob(u.id);
      await db.query(`update notification_preferences set push_enabled_at = (select created_at from notifications where id = $2) where user_id = $1`, [u.id, j1.nid]);
      await run();
      const j2 = await makeJob(u.id);
      await db.query(`update notification_preferences set push_enabled_at = (select created_at from notifications where id = $2) + interval '1 microsecond' where user_id = $1`, [u.id, j2.nid]);
      await run();
      const j3 = await makeJob(u.id);
      await db.query(`update notification_preferences set push_enabled_at = date_trunc('milliseconds', (select created_at from notifications where id = $2)) + interval '999 microseconds' where user_id = $1`, [u.id, j3.nid]);
      const sub = await one(`select (n.created_at < p.push_enabled_at) before_epoch, date_trunc('milliseconds', n.created_at) = date_trunc('milliseconds', p.push_enabled_at) same_ms from notifications n, notification_preferences p where n.id = $1 and p.user_id = $2`, [j3.nid, u.id]);
      await run();
      evidence.boundary = { equal: (await jobRow(j1.jid)).cat ?? 'delivered', plus1us: (await jobRow(j2.jid)).cat, subMs: { ...sub, result: (await jobRow(j3.jid)).cat } };
      check('13. boundary: created_at == pushEnabledAt -> delivered (inclusive); pushEnabledAt = created_at + 1 µs -> suppressed; same millisecond but earlier by µs -> suppressed (the JS-Date truncation trap does not apply)', sendsOf(j1.nid).length === 1 && suppressed(await jobRow(j2.jid)) && sendsOf(j2.nid).length === 0 && (!sub.same_ms || sub.before_epoch) && suppressed(await jobRow(j3.jid)) && sendsOf(j3.nid).length === 0, evidence.boundary);
    }

    section('2. Preference read failures (fail closed)');
    {
      await quiesce();
      const u = await user('dbdown');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      const deadDs = { query: async () => { const c = new Client({ ...DB, port: 1, database: NAME }); await c.connect(); return []; } };
      const deadConsent = new NotificationPreferencesService(deadDs, { get: () => undefined });
      await run({ consentSvc: deadConsent });
      const r1 = await jobRow(j.jid);
      offsetMs = 120_000;
      await run();
      offsetMs = 0;
      const r2 = await jobRow(j.jid);
      check('15 + 18 + 19 + 20. database unreachable during the consent read -> no send, job PENDING (pawflow/consent-unavailable, not PUSH_OPTED_OUT); after recovery the retry delivers', r1.status === 'PENDING' && r1.code === 'pawflow/consent-unavailable' && r1.cat === 'TRANSIENT' && r2.status === 'DONE' && r2.cat === null && sendsOf(j.nid).length === 1, { r1, r2 });
    }
    {
      const u = await user('timeout');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      const hanging = { getPushConsentForNotification: () => new Promise(() => undefined) };
      const t = Date.now();
      await run({ consentSvc: hanging, consentTimeoutMs: 300 });
      const ms = Date.now() - t;
      const r = await jobRow(j.jid);
      check('16. consent read hangs -> bounded (300 ms) -> no send, job PENDING consent-unavailable', r.status === 'PENDING' && r.code === 'pawflow/consent-unavailable' && sendsOf(j.nid).length === 0 && ms < 5_000, { r, ms });
      await quiesce();
    }
    {
      const u = await user('notable');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      await db.query(`alter table notification_preferences rename to notification_preferences_qa_hidden`);
      try {
        await run();
      } finally {
        await db.query(`alter table notification_preferences_qa_hidden rename to notification_preferences`);
      }
      const r1 = await jobRow(j.jid);
      offsetMs = 120_000;
      await run();
      offsetMs = 0;
      const r2 = await jobRow(j.jid);
      check('17 + 20. preferences table missing (42P01) -> no send, job PENDING (not DONE); table restored -> retry delivers', r1.status === 'PENDING' && r1.code === 'pawflow/consent-unavailable' && r2.status === 'DONE' && sendsOf(j.nid).length === 1, { r1, r2 });
    }
    {
      const u = await user('midfail');
      await setPush(u, true);
      const d1 = await reg(u, val());
      const v2 = val();
      await reg(await login('midfail'), v2);
      const j = await makeJob(u.id);
      let n = 0;
      const flaky = { getPushConsentForNotification: (uid, nid) => (++n === 3 ? Promise.reject(Object.assign(new Error('read timeout'), { code: '57014' })) : consent.getPushConsentForNotification(uid, nid)) };
      await run({ consentSvc: flaky, concurrency: 1 });
      const r = await jobRow(j.jid);
      const rows = await rowsOf(j.jid);
      check('19. consent read fails before the 2nd device: 1st device row kept, 2nd not sent, job PENDING for retry (not DONE)', r.status === 'PENDING' && r.code === 'pawflow/consent-unavailable' && rows.length === 1 && rows[0].dev === d1 && provider.sent.filter((s) => s.fp === fp(v2)).length === 0, { r, rows });
      await quiesce();
    }

    section('3. Security (P3-BE05/06 checks still enforced)');
    {
      // Account switching: A opts in + registers; A logs out; B (no preference) registers the same installation.
      const A = await user('swa');
      await setPush(A, true);
      const shared = val();
      await reg(A, shared);
      const jA = await makeJob(A.id);
      await call('POST', '/auth/logout', { token: A.t });
      const B = await user('swb');
      await reg(B, shared);
      const jB = await makeJob(B.id);
      await run();
      const rA = await jobRow(jA.jid);
      const rB = await jobRow(jB.jid);
      const A2 = await login('swa');
      const aInbox = JSON.stringify((await call('GET', '/notifications', { token: A2.t })).body);
      const bInbox = JSON.stringify((await call('GET', '/notifications', { token: B.t })).body);
      const bPref = (await call('GET', '/notification-preferences', { token: B.t })).body;
      evidence.accountSwitch = { jobA: `${rA.status}/${rA.cat}`, jobB: `${rB.status}/${rB.cat}`, sendsToInstallation: provider.sent.filter((s) => s.fp === fp(shared)).length, bPushEnabled: bPref.pushEnabled };
      check("22 + 23. account switch on a shared installation: A's revoked registration gets nothing (NO_DESTINATIONS); B stays opted out by default (suppressed); the installation receives 0 pushes; inboxes stay separate", rA.status === 'DONE' && rA.cat === 'NO_DESTINATIONS' && suppressed(rB) && evidence.accountSwitch.sendsToInstallation === 0 && bPref.pushEnabled === false && aInbox.includes(`"id":"${jA.nid}"`) && !aInbox.includes(`"id":"${jB.nid}"`) && bInbox.includes(`"id":"${jB.nid}"`) && !bInbox.includes(`"id":"${jA.nid}"`), evidence.accountSwitch);
    }
    {
      const u = await user('revoked');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      await call('POST', '/auth/logout', { token: u.t });
      await run();
      const r = await jobRow(j.jid);
      check('24. opted in but session revoked (logout) -> NO_DESTINATIONS, nothing sent', r.status === 'DONE' && r.cat === 'NO_DESTINATIONS' && sendsOf(j.nid).length === 0);
    }
    {
      const u = await user('susp');
      await setPush(u, true);
      await reg(u, val());
      const j = await makeJob(u.id);
      const s = await call('PATCH', `/admin/users/${u.id}/suspend`, { token: ADMIN.t });
      await run();
      const r = await jobRow(j.jid);
      check('25. opted in but account suspended -> nothing sent (NO_DESTINATIONS); stored preference untouched', s.status === 200 && r.cat === 'NO_DESTINATIONS' && sendsOf(j.nid).length === 0 && (await one(`select push_enabled from notification_preferences where user_id = $1`, [u.id])).push_enabled === true);
    }
    {
      const u = await user('rotate');
      await setPush(u, true);
      const v1 = val();
      const v2 = val();
      await reg(u, v1);
      const j = await makeJob(u.id);
      await reg(u, v2);
      await run();
      check('26. registration rotated before dispatch -> only the new registration receives it', provider.sent.filter((s) => s.fp === fp(v1)).length === 0 && provider.sent.filter((s) => s.fp === fp(v2) && s.notificationId === j.nid).length === 1);
    }
    {
      // Stale lease + opt-out: W1 is mid-send, the user opts out, W2 reclaims after lease expiry.
      await quiesce();
      const u = await user('stale');
      await setPush(u, true);
      const v1 = val('qaGate');
      const v2 = val();
      await reg(u, v1);
      await reg(await login('stale'), v2);
      const j = await makeJob(u.id);
      const g = provider.gate(v1);
      const w1 = run({ concurrency: 1, id: 'w1' });
      await g.enter;
      await setPush(u, false);
      const later = () => new Date(Date.now() + 11_000);
      const t2 = await run({ clk: later, id: 'w2' });
      g.release();
      const t1 = await w1;
      const rows = await rowsOf(j.jid);
      evidence.staleLease = { w1: t1.outcomes, w2: t2.outcomes, rows: rows.length, inFlightSends: provider.sent.filter((s) => s.fp === fp(v1)).length, secondDevice: provider.sent.filter((s) => s.fp === fp(v2)).length };
      check("27. stale lease + opt-out: the new owner suppresses (DONE PUSH_OPTED_OUT); the stale worker's in-flight result is NOT recorded (LOST_LEASE); 2nd device never sent", suppressed(await jobRow(j.jid)) && t1.outcomes.LOST_LEASE === 1 && rows.length === 0 && evidence.staleLease.secondDevice === 0, evidence.staleLease);
    }
    {
      const P = await user('isoa');
      const Q = await user('isob');
      await setPush(P, true);
      const pg = (await call('GET', '/notification-preferences', { token: P.t })).body;
      const qg = (await call('GET', '/notification-preferences', { token: Q.t })).body;
      check("29. preference responses are per account: A sees ON with its own period, B sees OFF/null (no cross-account values)", pg.pushEnabled === true && pg.pushEnabledAt && qg.pushEnabled === false && qg.pushEnabledAt === null && qg.updatedAt === null);
    }
    await stopAll();

    // ------------------------------------------------------------------ multi-instance
    section('4. Multi-instance: preferences via instance A, the APPLICATION worker on instance B; real bookings');
    await quiesce();
    await start('a2', PORTS[0], { PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'false' });
    await start('b2', PORTS[1], { PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'true', PUSH_WORKER_POLL_MS: '200' });
    {
      const A = PORTS[0];
      const waitDone = async (jid) => { for (let i = 0; i < 100; i++) { const r = await jobRow(jid); if (['DONE', 'FAILED', 'EXPIRED'].includes(r.status)) return r; await sleep(150); } return jobRow(jid); };
      const adminT = (await login('admin', A)).t;
      const CATEGORY = String((await call('POST', '/admin/service-categories', { token: adminT, body: { name: `Grooming ${RUN}` }, port: A })).body.id);
      const PET_TYPE = String((await call('POST', '/admin/pet-types', { token: adminT, body: { name: `Dog ${RUN}` }, port: A })).body.id);
      const O = await user('mowner');
      const prov = await call('POST', '/providers', { token: O.t, body: { businessName: `${RUN} Spa`, address: 'Street', phone: '0911000000', description: 'QA' }, port: A });
      await call('PATCH', `/admin/providers/${prov.body.id}/approve`, { token: adminT, port: A });
      for (let d = 0; d <= 6; d++) await call('POST', '/providers/working-hours', { token: O.t, body: { dayOfWeek: d, startTime: '08:00', endTime: '20:00' }, port: A });
      const svc = await call('POST', '/services', { token: O.t, body: { categoryId: CATEGORY, name: `Grooming ${RUN}`, price: 100000, durationMinutes: 60, description: 'QA' }, port: A });
      const slot = await call('POST', '/availability', { token: O.t, body: { serviceId: svc.body.id, slotDate: vnDate(3), startTime: '10:00', endTime: '11:00', capacity: 3 }, port: A });
      const C = await user('mcust');
      const pet = await call('POST', '/pets', { token: C.t, body: { petTypeId: PET_TYPE, name: 'Pet' }, port: A });
      await reg(O, val()); // owner HAS a device but never opts in
      await reg(C, val());
      await setPush(C, true, A); // customer opts in via instance A
      const b = await call('POST', '/bookings', { token: C.t, body: { petId: String(pet.body.id), slotId: String(slot.body.id) }, port: A });
      const created = await one(`select d.id::text jid, n.id::text nid from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_id = $1 and n.type = 'BOOKING_CREATED' and n.recipient_user_id = $2`, [String(b.body.id), O.id]);
      const rCreated = await waitDone(created.jid);
      const conf = await call('POST', `/bookings/provider/${b.body.id}/confirm`, { token: O.t, port: A });
      const confirmed = await one(`select d.id::text jid, n.id::text nid from notifications n join notification_deliveries d on d.notification_id = n.id where n.target_id = $1 and n.type = 'BOOKING_CONFIRMED' and n.recipient_user_id = $2`, [String(b.body.id), C.id]);
      const rConfirmed = await waitDone(confirmed.jid);
      const confirmedRows = await rowsOf(confirmed.jid);
      const ownerInbox = await call('GET', '/notifications', { token: O.t, port: A });
      evidence.bookingCases = { created: `${rCreated.status}/${rCreated.cat}`, confirmed: `${rConfirmed.status}/${rConfirmed.cat}`, confirmedRows: confirmedRows.map((x) => x.outcome) };
      check('Case 1 (booking, recipient OFF): BOOKING_CREATED for the owner (device registered, never opted in) -> inbox has it; application worker on instance B suppresses it', b.status === 201 && suppressed(rCreated) && (await rowsOf(created.jid)).length === 0 && JSON.stringify(ownerInbox.body).includes(`"id":"${created.nid}"`), evidence.bookingCases);
      check('Case 2 (booking, recipient ON via instance A): BOOKING_CONFIRMED for the customer -> delivered by the worker on instance B (ACCEPTED row)', [200, 201].includes(conf.status) && rConfirmed.status === 'DONE' && rConfirmed.cat === null && confirmedRows.length === 1 && confirmedRows[0].outcome === 'ACCEPTED', evidence.bookingCases);

      // Opt-out through instance A while the job is pending -> the worker on B (other process) must honour it.
      const M = await user('mopt');
      await setPush(M, true, A);
      await reg(M, val());
      await setPush(M, false, A);
      const j = await makeJob(M.id);
      const r = await waitDone(j.jid);
      check('multi-instance: opt-out committed through instance A is honoured by the worker running in instance B (suppressed, 0 rows)', suppressed(r) && (await rowsOf(j.jid)).length === 0, r);
    }
    const appLogs = fs.readdirSync(OUT_DIR).filter((d) => d.startsWith('logs-')).flatMap((d) => fs.readdirSync(path.join(OUT_DIR, d)).map((f) => fs.readFileSync(path.join(OUT_DIR, d, f), 'utf8'))).join('\n');
    await stopAll();

    section('5. Logs and global');
    const allLogs = appLogs + '\n' + logs.join('\n');
    fs.writeFileSync(path.join(OUT_DIR, 'qa-logs.txt'), logs.join('\n'));
    const leaked = [...values, ...secrets].filter(Boolean).filter((s) => allLogs.includes(s)).length;
    check(`30. no registration value (${values.length}), password, JWT secret or access token in any app/worker log; no Firebase credentials`, leaked === 0 && !/private_key|client_email|eyJhbGciOi/.test(allLogs), { leaked });
    check('suppressions are logged as job/notification ids only', /Push dispatch job \d+ \(notification \d+, attempt \d+\): recipient not opted in for this notification -> SUPPRESSED/.test(allLogs) && !/QA consent body/.test(allLogs));
    check('no HTTP 5xx in the whole run', !statuses.some((s) => s >= 500), statuses.filter((s) => s >= 500));
    const dl = await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`);
    check('0 deadlocks', dl.d === 0, dl);
  } finally {
    await stopAll().catch(() => undefined);
    if (ds.isInitialized) await ds.destroy();
    await db.query(`alter table if exists notification_preferences_qa_hidden rename to notification_preferences`).catch(() => undefined);
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'push-consent', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
