/*
 * PawFlow MVP end-to-end HTTP QA (P2-10).
 *
 * Drives the built application (dist/main.js) over real HTTP against a
 * disposable PostgreSQL database, with real JWT authorization and real
 * transactions, and checks database invariants after every scenario.
 *
 *   npm run build
 *   node test/qa/mvp-e2e.cjs            # or: npm run qa:mvp-e2e
 *
 * Safety:
 * - The QA database name must start with `pawflow_qa_` and differ from the
 *   development DB_DATABASE; it is dropped and recreated on every run, and
 *   `current_database()` is verified before any write.
 * - The development database is never connected to.
 * - The app is started from an empty temporary directory with explicit
 *   environment variables, so the repository `.env` cannot redirect it.
 *
 * Configuration (environment variables, all optional):
 *   QA_DB_HOST / QA_DB_PORT / QA_DB_USERNAME / QA_DB_PASSWORD
 *       default to DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD from .env
 *   QA_DB_NAME        default `pawflow_qa_mvp_e2e`
 *   QA_PORTS          default `8191,8192` (two app instances, one database)
 *   QA_OUT_DIR        where results/evidence JSON is written (default: OS temp)
 *   QA_KEEP_DB=1      keep the QA database after the run
 *
 * Time: the app runs with TZ=Asia/Ho_Chi_Minh. Main flows use slots at least
 * three days ahead during business hours, so results do not depend on the
 * time of day. Clock-boundary checks (past date, slot already started today)
 * are labelled "[boundary]" and use rows that are deterministic at any time.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const TZ = 'Asia/Ho_Chi_Minh';
const MAIN = path.join(ROOT, 'dist', 'main.js');

// ------------------------------------------------------------------ config

function readDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

const dotEnv = readDotEnv();
const DB = {
  host: process.env.QA_DB_HOST ?? dotEnv.DB_HOST ?? 'localhost',
  port: Number(process.env.QA_DB_PORT ?? dotEnv.DB_PORT ?? 5432),
  user: process.env.QA_DB_USERNAME ?? dotEnv.DB_USERNAME ?? 'postgres',
  password: process.env.QA_DB_PASSWORD ?? dotEnv.DB_PASSWORD ?? '',
};
const QA_DB = process.env.QA_DB_NAME ?? 'pawflow_qa_mvp_e2e';
const PORTS = (process.env.QA_PORTS ?? '8191,8192').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-qa-'));

if (!/^pawflow_qa_[a-z0-9_]+$/.test(QA_DB) || QA_DB === dotEnv.DB_DATABASE) {
  throw new Error(`Refusing to use "${QA_DB}": the QA database must be named pawflow_qa_* and differ from the development database`);
}
if (!fs.existsSync(MAIN)) {
  throw new Error('dist/main.js not found: run `npm run build` first');
}

// ------------------------------------------------------------------ results

const results = [];
const skipped = [];
const evidence = {};
const examples = [];
let currentScenario = 'setup';
const scenario = (name) => { currentScenario = name; console.log(`\n## ${name}`); };
function check(name, condition, detail) {
  results.push({ scenario: currentScenario, name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + JSON.stringify(detail).slice(0, 500)}`);
}

// Personal data and credentials are replaced before evidence is written.
const REDACT = new Set(['accessToken', 'password', 'passwordHash', 'email', 'phone', 'fullName']);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.has(k) && v !== null ? '<redacted>' : redact(v)]));
  }
  return value;
}
function example(label, method, url, request, response) {
  examples.push({ label, request: { method, url, body: redact(request ?? null) }, response: { status: response.status, headers: response.replayed === null ? undefined : { 'Idempotent-Replayed': response.replayed }, body: redact(response.body) } });
}

// ------------------------------------------------------------------ time (business time zone)

function vnDate(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const dowOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

// ------------------------------------------------------------------ database

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (sql, params) => (await db.query(sql, params)).rows;

async function recreateDatabase() {
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${QA_DB}`);
  await admin.query(`CREATE DATABASE ${QA_DB}`);
  await admin.end();
}

async function dropDatabase() {
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${QA_DB}`);
  await admin.end();
}

async function migrate() {
  const dataSource = new DataSource({
    type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: QA_DB,
    synchronize: false,
    entities: [path.join(ROOT, 'dist', '**', '*.entity.js')],
    migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')],
  });
  await dataSource.initialize();
  const identity = (await dataSource.query('select current_database() as d'))[0].d;
  if (identity !== QA_DB) throw new Error('ISOLATION FAILURE: migrations connected to ' + identity);
  const executed = await dataSource.runMigrations({ transaction: 'each' });
  // Entity metadata vs migrated schema: no pending DDL expected.
  const pending = await dataSource.driver.createSchemaBuilder().log();
  await dataSource.destroy();
  return { executed: executed.map((m) => m.name), pendingSchemaChanges: pending.upQueries.map((q) => q.query) };
}

// ------------------------------------------------------------------ application instances

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-qa-run-'));
const JWT_SECRET = randomUUID() + randomUUID();
const procs = {};

function startInstance(port) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(DB_|JWT_|PORT$|QA_)/.test(key)) delete env[key];
  Object.assign(env, {
    TZ, PORT: String(port), NODE_ENV: 'test',
    DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USERNAME: DB.user, DB_PASSWORD: DB.password, DB_DATABASE: QA_DB,
    JWT_SECRET, JWT_EXPIRES_IN_SECONDS: '3600', FRONTEND_URL: 'http://localhost:3001',
  });
  const log = fs.openSync(path.join(OUT_DIR, `app-${port}.log`), 'a');
  procs[port] = spawn(process.execPath, [MAIN], { cwd: RUN_DIR, env, stdio: ['ignore', log, log] });
  return (async () => {
    for (let i = 0; i < 200; i++) {
      try { await fetch(`http://localhost:${port}/api`); return; } catch { await sleep(150); }
    }
    throw new Error('app did not start on port ' + port);
  })();
}
const stopAll = () => Promise.all(PORTS.map((port) => new Promise((resolve) => {
  const child = procs[port];
  if (!child || child.exitCode !== null) return resolve();
  child.once('exit', resolve);
  child.kill();
})));
const startAll = () => Promise.all(PORTS.map(startInstance));

// ------------------------------------------------------------------ HTTP

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let roundRobin = 0;
async function api(method, url, { token, body, key, port, raw } = {}) {
  const target = port ?? PORTS[roundRobin++ % PORTS.length];
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const init = { method, headers };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) init.body = payload;
  const res = await fetch(`http://localhost:${target}/api${url}`, init);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, replayed: res.headers.get('idempotent-replayed') };
}
const tally = (responses) => responses.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
const message = (r) => (r.body && r.body.message) || '';

// ------------------------------------------------------------------ contract helpers

function keyPaths(value, prefix = '') {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => keyPaths(item, `${prefix}[]`)))];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      const p = prefix ? `${prefix}.${key}` : key;
      return [p, ...keyPaths(child, p)];
    });
  }
  return [];
}
const shape = (value) => [...new Set(keyPaths(value))].sort();
const lastSegment = (p) => p.split('.').pop().replace(/^\[\]/, '');

const SECRET_KEYS = ['passwordHash', 'password', 'accessTokenSecret'];
const BOOKING_FORBIDDEN = ['passwordHash', 'password', 'email', 'phone', 'role', 'owner', 'ownerId', 'approvalStatus', 'customerId', 'petId', 'providerId', 'serviceId', 'slotId', 'categoryId', 'petTypeId', 'bookingId', 'changedBy', 'capacity', 'bookedCount', 'ratingAvg', 'ratingCount', 'price'];
const PUBLIC_FORBIDDEN = ['passwordHash', 'password', 'email', 'phone', 'owner', 'ownerId', 'approvalStatus', 'customerId', 'bookingId', 'respondedBy', 'isVisible', 'role'];
const forbiddenIn = (value, keys) => keyPaths(value).filter((p) => keys.includes(lastSegment(p)));

const BASE_VIEW = ['bookedPrice', 'createdAt', 'customerNote', 'id', 'service', 'service.durationMinutes', 'service.id', 'service.name', 'slot', 'slot.endTime', 'slot.id', 'slot.slotDate', 'slot.startTime', 'status', 'updatedAt'];
const PET_VIEW = ['pet', 'pet.breed', 'pet.id', 'pet.name', 'pet.petType', 'pet.petType.id', 'pet.petType.name'];
const CUSTOMER_VIEW = [...BASE_VIEW, ...PET_VIEW, 'provider', 'provider.address', 'provider.businessName', 'provider.id'].sort();
const PROVIDER_VIEW = [...BASE_VIEW, ...PET_VIEW, 'pet.birthDate', 'pet.healthNote', 'pet.weight', 'customer', 'customer.fullName', 'customer.id'].sort();
const LOG_VIEW = ['statusLogs', 'statusLogs[].createdAt', 'statusLogs[].id', 'statusLogs[].newStatus', 'statusLogs[].oldStatus', 'statusLogs[].reason'];
const CUSTOMER_DETAIL = [...CUSTOMER_VIEW, ...LOG_VIEW].sort();
const PROVIDER_DETAIL = [...PROVIDER_VIEW, ...LOG_VIEW].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isIdString = (v) => typeof v === 'string' && /^[1-9]\d*$/.test(v);
const isMoney = (v) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v);

// ------------------------------------------------------------------ database invariants (scoped to this run's providers)

const runProviders = [];
async function invariants(label) {
  const ids = runProviders.map(Number);
  const inv = await one(`
    with p as (select unnest($1::bigint[]) as id)
    select
      (select count(*)::int from availability_slots s where s.provider_id in (select id from p)
         and s.booked_count <> (select count(*) from bookings b where b.slot_id = s.id and b.status not in ('CANCELLED','REJECTED'))) as capacity_mismatch,
      (select count(*)::int from availability_slots s where s.provider_id in (select id from p) and s.booked_count > s.capacity) as over_capacity,
      (select count(*)::int from bookings b where b.provider_id in (select id from p)
         and (select count(*) from booking_status_logs l where l.booking_id = b.id and l.old_status is null) <> 1) as initial_log_not_one,
      (select count(*)::int from bookings b where b.provider_id in (select id from p)
         and b.status <> (select l.new_status from booking_status_logs l where l.booking_id = b.id order by l.created_at desc, l.id desc limit 1)) as last_log_mismatch,
      (select count(*)::int from bookings b join availability_slots s on s.id = b.slot_id where b.provider_id in (select id from p)
         and (s.provider_id <> b.provider_id or s.service_id <> b.service_id)) as slot_context_mismatch,
      (select count(*)::int from bookings b join availability_slots s on s.id = b.slot_id join services v on v.id = b.service_id
         where b.provider_id in (select id from p) and b.status in ('PENDING_CONFIRMATION','CONFIRMED') and s.slot_date >= $2::date
         and extract(epoch from (s.end_time - s.start_time)) < v.duration_minutes * 60) as active_on_short_slot,
      (select count(*)::int from bookings b join availability_slots s on s.id = b.slot_id
         where b.provider_id in (select id from p) and b.status in ('PENDING_CONFIRMATION','CONFIRMED') and s.slot_date >= $2::date
         and not exists (select 1 from provider_working_hours w where w.provider_id = s.provider_id and w.is_active
           and w.day_of_week = extract(dow from s.slot_date) and w.start_time <= s.start_time and w.end_time >= s.end_time)) as active_outside_hours,
      (select count(*)::int from provider_working_hours a join provider_working_hours b
         on a.provider_id = b.provider_id and a.day_of_week = b.day_of_week and a.id < b.id
         where a.provider_id in (select id from p) and a.is_active and b.is_active and a.start_time < b.end_time and b.start_time < a.end_time) as overlapping_hours,
      (select count(*)::int from booking_idempotency_keys k left join bookings b on b.id = k.booking_id
         where b.id is null or b.customer_id <> k.customer_id) as key_owner_mismatch,
      (select count(*)::int from providers pr where pr.id in (select id from p)
         and pr.rating_count <> (select count(*) from reviews r join bookings b on b.id = r.booking_id where b.provider_id = pr.id and r.is_visible)) as rating_count_mismatch,
      (select count(*)::int from payments pay join bookings b on b.id = pay.booking_id where b.provider_id in (select id from p) and pay.amount <> b.booked_price) as payment_amount_mismatch,
      (select deadlocks::int from pg_stat_database where datname = current_database()) as deadlocks`, [ids, vnDate(0)]);
  const clean = Object.values(inv).every((v) => v === 0);
  check(`[invariants] ${label}`, clean, inv);
  evidence.invariants = evidence.invariants ?? {};
  evidence.invariants[label] = inv;
}

// ------------------------------------------------------------------ fixtures

const RUN = 'e2e' + Date.now().toString(36);
const PASSWORD = 'QaPassword123!';
const mail = (name) => `${name}.${RUN}@qa.test`;
let ADMIN, CATEGORY, PET_TYPE;

async function register(name) {
  const r = await api('POST', '/auth/register', { body: { fullName: `QA ${name}`, email: mail(name), password: PASSWORD } });
  if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body));
  return { name, t: r.body.accessToken, id: String(r.body.user.id) };
}
const login = async (name) => (await api('POST', '/auth/login', { body: { email: mail(name), password: PASSWORD } })).body.accessToken;
async function customer(name, petExtra = {}) {
  const c = await register(name);
  const pet = await api('POST', '/pets', { token: c.t, body: { petTypeId: PET_TYPE, name: `Pet ${name}`, ...petExtra } });
  if (pet.status !== 201) throw new Error('pet ' + JSON.stringify(pet.body));
  return { ...c, pet: String(pet.body.id) };
}
async function provider(name, { approve = true, hours = true } = {}) {
  const owner = await register(name);
  const p = await api('POST', '/providers', { token: owner.t, body: { businessName: `${RUN} ${name} Spa`, address: `${name} Street, District 1`, phone: '0911000000', description: `QA provider ${name}` } });
  if (p.status !== 201) throw new Error('provider ' + JSON.stringify(p.body));
  const pid = String(p.body.id);
  runProviders.push(pid);
  if (approve) await api('PATCH', `/admin/providers/${pid}/approve`, { token: ADMIN });
  if (approve && hours) {
    for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
      const r = await api('POST', '/providers/working-hours', { token: owner.t, body: { dayOfWeek, startTime: '08:00', endTime: '20:00' } });
      if (r.status !== 201) throw new Error('hours ' + JSON.stringify(r.body));
    }
  }
  return { ...owner, pid };
}
async function service(P, { duration = 60, price = 150000.5, name = 'Full grooming' } = {}) {
  const r = await api('POST', '/services', { token: P.t, body: { categoryId: CATEGORY, name: `${name} ${RUN}`, price, durationMinutes: duration, description: 'Bath, cut and nails' } });
  if (r.status !== 201) throw new Error('service ' + JSON.stringify(r.body));
  return String(r.body.id);
}
async function slot(P, serviceId, slotDate, startTime, endTime, capacity = 3) {
  const r = await api('POST', '/availability', { token: P.t, body: { serviceId, slotDate, startTime, endTime, capacity } });
  if (r.status !== 201) throw new Error('slot ' + JSON.stringify(r.body));
  return String(r.body.id);
}
const book = (c, slotId, { key, note, port } = {}) =>
  api('POST', '/bookings', { token: c.t, key, port, body: { petId: c.pet, slotId, ...(note === undefined ? {} : { customerNote: note }) } });
async function bookOk(c, slotId, opts) {
  const r = await book(c, slotId, opts);
  if (r.status !== 201) throw new Error('book ' + JSON.stringify(r.body));
  return String(r.body.id);
}
const action = (actor, id, verb, body, port) => api('POST', `/bookings/provider/${id}/${verb}`, { token: actor.t, port, body: body ?? (['confirm', 'complete'].includes(verb) ? undefined : {}) });
const cancel = (c, id, body = {}, port) => api('POST', `/bookings/mine/${id}/cancel`, { token: c.t, body, port });
const bookingRow = (id) => one(`select status, booked_price::text price, slot_id::text slot from bookings where id = $1`, [id]);
const bookedCount = async (slotId) => (await one('select booked_count::int c from availability_slots where id = $1', [slotId])).c;
const logsOf = (id) => rows(`select old_status, new_status, changed_by::text by, reason from booking_status_logs where booking_id = $1 order by created_at, id`, [id]);
const tableHash = async () => (await one(`select md5(string_agg(t || ':' || (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, ''|'' order by x::text), '''')) h from %I x', t), false, true, '')))[1]::text, ',' order by t)) h from (select tablename t from pg_tables where schemaname = 'public') s`)).h;

// ================================================================== main

async function main() {
  console.log(`PawFlow MVP E2E  run=${RUN}  db=${QA_DB}  ports=${PORTS.join(',')}  TZ=${TZ}  out=${OUT_DIR}`);

  // ---------------------------------------------------------------- environment
  scenario('0. QA environment');
  await recreateDatabase();
  db = new Client({ ...DB, database: QA_DB });
  await db.connect();
  const identity = (await one('select current_database() as d')).d;
  check('connected database is the disposable QA database', identity === QA_DB, identity);
  if (identity !== QA_DB) throw new Error('ISOLATION FAILURE');
  const migration = await migrate();
  evidence.migrations = migration.executed;
  check('all 9 source migrations executed on QA', migration.executed.length === 9, migration.executed);
  check('entity metadata matches the migrated schema (no pending DDL)', migration.pendingSchemaChanges.length === 0, migration.pendingSchemaChanges);
  await startAll();
  check('two app instances started against the QA database', true);

  await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
  ADMIN = await login('admin');
  CATEGORY = String((await api('POST', '/admin/service-categories', { token: ADMIN, body: { name: `Grooming ${RUN}` } })).body.id);
  PET_TYPE = String((await api('POST', '/admin/pet-types', { token: ADMIN, body: { name: `Dog ${RUN}` } })).body.id);

  const P = await provider('owner');
  const P2 = await provider('otherowner');
  const PENDING = await provider('pendingowner', { approve: false });
  const STAFF = await register('staff');
  const STAFF_OFF = await register('staffoff');
  await api('POST', '/providers/staff', { token: P.t, body: { userId: STAFF.id, position: 'Groomer' } });
  const off = await api('POST', '/providers/staff', { token: P.t, body: { userId: STAFF_OFF.id, position: 'Former' } });
  await api('DELETE', `/providers/staff/${off.body.id}`, { token: P.t });
  const S1 = await service(P);
  const D3 = vnDate(3), D4 = vnDate(4), D5 = vnDate(5), D6 = vnDate(6);

  // ---------------------------------------------------------------- A. customer journey
  scenario('A. Customer booking journey');
  const C1 = await customer('alice', { breed: 'Corgi', weight: 12.5, healthNote: 'Allergic to oat shampoo', birthDate: '2022-05-01' });
  check('A1 customer registered (CUSTOMER role, no password hash in response)', C1.t && forbiddenIn(await api('GET', '/auth/me', { token: C1.t }), SECRET_KEYS).length === 0);
  check('A2 pet created and owned by the customer', (await one('select owner_id::text o from pets where id = $1', [C1.pet])).o === C1.id);
  const slotA = await slot(P, S1, D3, '09:00', '10:00', 3);
  const provSearch = await api('GET', `/providers/public/search?q=${encodeURIComponent(RUN)}`);
  example('Public provider search', 'GET', `/providers/public/search?q=<run>`, null, provSearch);
  const visibleIds = provSearch.body.items.map((i) => i.id);
  check('A3 provider search lists APPROVED providers, hides PENDING ones', visibleIds.includes(P.pid) && !visibleIds.includes(PENDING.pid), visibleIds);
  check('A3 provider search items expose no internal fields', forbiddenIn(provSearch.body, PUBLIC_FORBIDDEN).length === 0, forbiddenIn(provSearch.body, PUBLIC_FORBIDDEN));
  const provDetail = await api('GET', `/providers/public/${P.pid}`);
  example('Public provider detail', 'GET', '/providers/public/:id', null, provDetail);
  check('A4 provider detail 200, ratingAvg NUMERIC string, no internal fields', provDetail.status === 200 && isMoney(provDetail.body.ratingAvg) && forbiddenIn(provDetail.body, PUBLIC_FORBIDDEN).length === 0, provDetail.body);
  check('A4 PENDING provider detail -> 404', (await api('GET', `/providers/public/${PENDING.pid}`)).status === 404);
  const svcSearch = await api('GET', `/services/public/search?providerId=${P.pid}`);
  example('Public service search', 'GET', '/services/public/search?providerId=:id', null, svcSearch);
  const svcItem = svcSearch.body.items.find((i) => i.id === S1);
  check('A5 service search lists the service with its price as a NUMERIC string', !!svcItem && svcItem.price === '150000.50', svcSearch.body.items);
  const svcDetail = await api('GET', `/services/public/${S1}`);
  check('A6 service detail 200, durationMinutes 60, no internal fields', svcDetail.status === 200 && svcDetail.body.durationMinutes === 60 && forbiddenIn(svcDetail.body, PUBLIC_FORBIDDEN).length === 0, svcDetail.body);
  const avail = await api('GET', `/availability/public/search?providerId=${P.pid}&serviceId=${S1}&date=${D3}`);
  example('Public availability search', 'GET', '/availability/public/search?providerId&serviceId&date', null, avail);
  check('A7 availability search returns the slot for provider+service+date', avail.status === 200 && avail.body.items.some((i) => i.id === slotA), avail.body);
  const slotDetail = await api('GET', `/availability/public/${slotA}`);
  check('A8 slot public detail matches the selection (provider, service, date, time)', slotDetail.status === 200 && slotDetail.body.provider.id === P.pid && slotDetail.body.service.id === S1 && slotDetail.body.slotDate === D3 && slotDetail.body.startTime === '09:00:00', slotDetail.body);
  check('A8 slot public detail exposes no internal fields', forbiddenIn(slotDetail.body, PUBLIC_FORBIDDEN).length === 0, forbiddenIn(slotDetail.body, PUBLIC_FORBIDDEN));

  const keyA = randomUUID();
  const created = await book(C1, slotA, { key: keyA, note: 'Please be gentle' });
  example('Create booking with Idempotency-Key', 'POST', '/bookings', { petId: C1.pet, slotId: slotA, customerNote: 'Please be gentle' }, created);
  const bA = String(created.body.id);
  check('A9 POST /bookings with Idempotency-Key -> 201, Idempotent-Replayed: false', created.status === 201 && created.replayed === 'false', created);
  check('A10 booking starts PENDING_CONFIRMATION', created.body.status === 'PENDING_CONFIRMATION');
  check('A12 creation response = customer projection', same(shape(created.body), CUSTOMER_VIEW), shape(created.body));
  check('A12 no internal/personal field at any depth', forbiddenIn(created.body, BOOKING_FORBIDDEN).length === 0, forbiddenIn(created.body, BOOKING_FORBIDDEN));
  const mineList = await api('GET', '/bookings/mine', { token: C1.t });
  check('A11 /bookings/mine lists the booking with the same projection', mineList.status === 200 && mineList.body.length === 1 && mineList.body[0].id === bA && same(shape(mineList.body[0]), CUSTOMER_VIEW), mineList.body);
  const mineDetail = await api('GET', `/bookings/mine/${bA}`, { token: C1.t });
  example('Customer booking detail', 'GET', '/bookings/mine/:id', null, mineDetail);
  check('A11 /bookings/mine/:id = customer projection + statusLogs', same(shape(mineDetail.body), CUSTOMER_DETAIL), shape(mineDetail.body));
  const dbSlot = await one(`select s.provider_id::text p, s.service_id::text s, s.slot_date::text d, s.start_time::text st, s.end_time::text et, s.booked_count::int bc,
      extract(epoch from (s.end_time - s.start_time))::int len, v.duration_minutes::int dur, v.price::text price
    from availability_slots s join services v on v.id = s.service_id where s.id = $1`, [slotA]);
  const fits = await one(`select count(*)::int c from provider_working_hours where provider_id = $1 and is_active and day_of_week = $2 and start_time <= $3 and end_time >= $4`, [P.pid, dowOf(D3), dbSlot.st, dbSlot.et]);
  const rowA = await bookingRow(bA);
  check('A slot belongs to the selected provider and service', dbSlot.p === P.pid && dbSlot.s === S1);
  check('A working hours permit the slot (one active interval covers it)', fits.c === 1, fits);
  check('A slot duration covers the service duration', dbSlot.len >= dbSlot.dur * 60, dbSlot);
  check('A slot has not started (3 days ahead)', dbSlot.d === D3 && dbSlot.d > vnDate(0));
  check('A bookedCount increased exactly once (0 -> 1)', dbSlot.bc === 1, dbSlot);
  check('A price snapshotted from the service (150000.50)', rowA.price === dbSlot.price && created.body.bookedPrice === '150000.50', rowA);
  check('A exactly one initial status log', same(await logsOf(bA), [{ old_status: null, new_status: 'PENDING_CONFIRMATION', by: C1.id, reason: null }]), await logsOf(bA));
  check('A BIGINT ids are strings, NUMERIC as 2-decimal strings', [created.body.id, created.body.pet.id, created.body.provider.id, created.body.service.id, created.body.slot.id].every(isIdString) && isMoney(created.body.bookedPrice));
  await invariants('after A');

  // ---------------------------------------------------------------- B. provider fulfillment
  scenario('B. Provider fulfillment');
  const pList = await api('GET', '/bookings/provider', { token: P.t });
  check('B1 owner lists the booking with the provider projection', pList.status === 200 && pList.body.some((b) => b.id === bA) && pList.body.every((b) => same(shape(b), PROVIDER_VIEW)), pList.body.map(shape));
  const pDetail = await api('GET', `/bookings/provider/${bA}`, { token: P.t });
  example('Provider booking detail', 'GET', '/bookings/provider/:id', null, pDetail);
  check('B2 owner detail = provider projection + statusLogs, customer name only', same(shape(pDetail.body), PROVIDER_DETAIL) && pDetail.body.customer.id === C1.id && pDetail.body.pet.healthNote === 'Allergic to oat shampoo', shape(pDetail.body));
  check('B2 provider view has no email/phone/credentials', forbiddenIn(pDetail.body, BOOKING_FORBIDDEN).length === 0, forbiddenIn(pDetail.body, BOOKING_FORBIDDEN));
  check('B unrelated customer -> 404', (await api('GET', `/bookings/mine/${bA}`, { token: (await customer('mallory')).t })).status === 404);
  check('B unrelated provider -> 404 (detail and confirm)', (await api('GET', `/bookings/provider/${bA}`, { token: P2.t })).status === 404 && (await action(P2, bA, 'confirm')).status === 404);
  check('B inactive staff -> 403', (await api('GET', '/bookings/provider', { token: await login('staffoff') })).status === 403);
  STAFF.t = await login('staff');
  check('B active staff lists the same bookings', same((await api('GET', '/bookings/provider', { token: STAFF.t })).body, pList.body));
  const conf = await action(P, bA, 'confirm');
  example('Provider confirms', 'POST', '/bookings/provider/:id/confirm', null, conf);
  check('B3/B4 owner confirm -> 201 CONFIRMED, provider projection', conf.status === 201 && conf.body.status === 'CONFIRMED' && same(shape(conf.body), PROVIDER_VIEW), conf);
  const comp = await action(STAFF, bA, 'complete');
  check('B5/B6 active staff complete -> 201 COMPLETED', comp.status === 201 && comp.body.status === 'COMPLETED', comp);
  check('B capacity unchanged by confirm/complete (still 1)', (await bookedCount(slotA)) === 1);
  const history = await logsOf(bA);
  check('B7 status history: null->PENDING (customer), ->CONFIRMED (owner), ->COMPLETED (staff)', same(history.map((l) => [l.old_status, l.new_status, l.by]), [[null, 'PENDING_CONFIRMATION', C1.id], ['PENDING_CONFIRMATION', 'CONFIRMED', P.id], ['CONFIRMED', 'COMPLETED', STAFF.id]]), history);
  const custAfter = await api('GET', `/bookings/mine/${bA}`, { token: C1.t });
  check('B8 customer projection shows COMPLETED and the 3-step history, no changedBy', custAfter.body.status === 'COMPLETED' && custAfter.body.statusLogs.length === 3 && same(shape(custAfter.body), CUSTOMER_DETAIL), custAfter.body);
  check('B8 the two projections differ only as designed', !('customer' in custAfter.body) && !('provider' in pDetail.body) && !('healthNote' in custAfter.body.pet));
  await invariants('after B');

  // ---------------------------------------------------------------- C. cancellation and rejection
  scenario('C. Cancellation and rejection');
  const C2 = await customer('bob');
  const slotC = await slot(P, S1, D3, '10:00', '11:00', 3);
  const bCancel = await bookOk(C2, slotC);
  const bReject = await bookOk(C2, slotC);
  check('C setup: two bookings, bookedCount 2', (await bookedCount(slotC)) === 2);
  const can = await cancel(C2, bCancel, { reason: 'Plans changed' });
  example('Customer cancels', 'POST', '/bookings/mine/:id/cancel', { reason: 'Plans changed' }, can);
  check('C1 customer cancellation -> 201 CANCELLED, capacity released (1)', can.status === 201 && can.body.status === 'CANCELLED' && (await bookedCount(slotC)) === 1, can);
  const can2 = await cancel(C2, bCancel);
  check('C repeated cancellation -> 409, no second release or log', can2.status === 409 && (await bookedCount(slotC)) === 1 && (await logsOf(bCancel)).length === 2, can2);
  const rej = await action(P, bReject, 'reject', { reason: 'Fully staffed' });
  check('C2 provider rejection -> 201 REJECTED, capacity released (0)', rej.status === 201 && rej.body.status === 'REJECTED' && (await bookedCount(slotC)) === 0, rej);
  const invalid = {
    'reject again': await action(P, bReject, 'reject'),
    'confirm REJECTED': await action(P, bReject, 'confirm'),
    'cancel REJECTED': await cancel(C2, bReject),
    'confirm CANCELLED': await action(P, bCancel, 'confirm'),
    'complete CANCELLED': await action(STAFF, bCancel, 'complete'),
    'no-show CANCELLED': await action(P, bCancel, 'no-show'),
    'cancel COMPLETED': await cancel(C1, bA),
    'confirm COMPLETED': await action(P, bA, 'confirm'),
  };
  check('C invalid transitions -> 409 each', Object.values(invalid).every((r) => r.status === 409), Object.fromEntries(Object.entries(invalid).map(([k, r]) => [k, r.status])));
  const bPend = await bookOk(C2, slotC);
  const pendInvalid = [await action(P, bPend, 'complete'), await action(P, bPend, 'no-show')];
  check('C complete / no-show on PENDING -> 409', pendInvalid.every((r) => r.status === 409));
  check('C no duplicate logs: cancelled=2, rejected=2, pending=1', (await logsOf(bCancel)).length === 2 && (await logsOf(bReject)).length === 2 && (await logsOf(bPend)).length === 1);
  const bDouble = await bookOk(C2, slotC);
  const cancels = await Promise.all(Array.from({ length: 6 }, (_, i) => cancel(C2, bDouble, {}, PORTS[i % 2])));
  check('C 6 concurrent cancellations of one booking -> 1x201 + 5x409, released once', tally(cancels)['201'] === 1 && tally(cancels)['409'] === 5 && (await bookedCount(slotC)) === 1 && (await logsOf(bDouble)).filter((l) => l.new_status === 'CANCELLED').length === 1, tally(cancels));
  await invariants('after C');

  // ---------------------------------------------------------------- D. retry and concurrency
  scenario('D. Retry and concurrency');
  const C3 = await customer('carol');
  const slotD = await slot(P, S1, D4, '09:00', '10:00', 5);
  const keyD = randomUUID();
  const [d1, d2] = await Promise.all([book(C3, slotD, { key: keyD, port: PORTS[0] }), book(C3, slotD, { key: keyD, port: PORTS[1] })]);
  check('D1 double-click (same key, two instances) -> both 201, one created + one replay, same booking', d1.status === 201 && d2.status === 201 && d1.body.id === d2.body.id && [d1.replayed, d2.replayed].sort().join() === 'false,true' && (await bookedCount(slotD)) === 1, [d1.replayed, d2.replayed]);
  check('D1 replay body equals the original body', same(d1.body, d2.body));
  const lost = await book(C3, slotD, { key: keyD });
  example('Retry after lost response (replay)', 'POST', '/bookings', { petId: C3.pet, slotId: slotD }, lost);
  check('D2 retry after a lost response -> 201 replay, no new capacity', lost.status === 201 && lost.replayed === 'true' && lost.body.id === d1.body.id && (await bookedCount(slotD)) === 1, lost);
  await stopAll();
  await startAll();
  const afterRestart = await book(C3, slotD, { key: keyD });
  check('D3 retry after restarting both backends -> 201 replay (key stored in PostgreSQL)', afterRestart.status === 201 && afterRestart.replayed === 'true' && afterRestart.body.id === d1.body.id && (await bookedCount(slotD)) === 1, afterRestart);
  const diff = await book(C3, slotD, { key: keyD, note: 'different' });
  example('Same key, different payload', 'POST', '/bookings', { petId: C3.pet, slotId: slotD, customerNote: 'different' }, diff);
  check('D4 same key + different payload -> 409, nothing written', diff.status === 409 && /different booking request/.test(message(diff)) && (await bookedCount(slotD)) === 1, diff);
  const C4 = await customer('dave');
  const other = await book(C4, slotD, { key: keyD });
  check('D5 another customer with the same key -> independent booking', other.status === 201 && other.replayed === 'false' && other.body.id !== d1.body.id && (await bookedCount(slotD)) === 2, other);
  check('D malformed key -> 400', (await book(C4, slotD, { key: 'short' })).status === 400);

  const crowd = await Promise.all(Array.from({ length: 12 }, (_, i) => customer('crowd' + i)));
  const slotFull = await slot(P, S1, D4, '11:00', '12:00', 5);
  const rush = await Promise.all(crowd.map((c, i) => book(c, slotFull, { key: i % 2 ? randomUUID() : undefined, port: PORTS[i % 2] })));
  evidence.capacityRush = tally(rush);
  check('D6 12 concurrent bookings on capacity 5 -> 5x201 + 7x409, bookedCount 5', tally(rush)['201'] === 5 && tally(rush)['409'] === 7 && (await bookedCount(slotFull)) === 5, tally(rush));
  check('D6 failed keyed attempts stored no key', (await one(`select count(*)::int c from booking_idempotency_keys k join bookings b on b.id = k.booking_id where b.slot_id = $1`, [slotFull])).c === rush.filter((r, i) => i % 2 && r.status === 201).length);
  await invariants('after D retry/capacity');

  // Provider confirmation vs admin suspension (dedicated provider).
  const PS = await provider('raceowner');
  const SS = await service(PS);
  const slotS = await slot(PS, SS, D5, '09:00', '10:00', 30);
  const C5 = await customer('erin');
  evidence.suspensionRace = { confirmFirst: 0, suspendFirst: 0 };
  let suspensionConsistent = true;
  for (let round = 0; round < 10; round++) {
    const b = await bookOk(C5, slotS);
    const [c, s] = await Promise.all([
      sleep(((round + 2) % 4) * 8).then(() => action(PS, b, 'confirm', undefined, PORTS[round % 2])),
      sleep((round % 4) * 8).then(() => api('PATCH', `/admin/providers/${PS.pid}/suspend`, { token: ADMIN, port: PORTS[(round + 1) % 2] })),
    ]);
    const status = (await bookingRow(b)).status;
    const ok = s.status === 200 && ((c.status === 201 && status === 'CONFIRMED') || (c.status === 403 && status === 'PENDING_CONFIRMATION'));
    suspensionConsistent &&= ok;
    evidence.suspensionRace[c.status === 201 ? 'confirmFirst' : 'suspendFirst']++;
    if (!ok) evidence.suspensionRace.failure = { round, confirm: c.status, suspend: s.status, status };
    await api('PATCH', `/admin/providers/${PS.pid}/reactivate`, { token: ADMIN });
  }
  check('D7 confirm vs admin suspend (10 rounds): every round serial, never a confirmation on a stale APPROVED', suspensionConsistent, evidence.suspensionRace);

  // Schedule change vs booking creation (dedicated provider, P2-06B rule).
  const PH = await provider('hoursowner', { hours: false });
  const SH = await service(PH);
  evidence.scheduleRace = [];
  let scheduleConsistent = true;
  const hourCustomers = await Promise.all(Array.from({ length: 3 }, (_, i) => customer('hours' + i)));
  for (let round = 0; round < 6; round++) {
    const day = vnDate(7 + round);
    const wh = (await api('POST', '/providers/working-hours', { token: PH.t, body: { dayOfWeek: dowOf(day), startTime: '08:00', endTime: '12:00' } })).body.id;
    const s = await slot(PH, SH, day, '11:00', '12:00', 5);
    const [u, ...bs] = await Promise.all([
      sleep((round % 3) * 20).then(() => api('PATCH', `/providers/working-hours/${wh}`, { token: PH.t, body: { endTime: '11:00' }, port: PORTS[round % 2] })),
      ...hourCustomers.map((c, i) => book(c, s, { port: PORTS[(round + i) % 2] })),
    ]);
    const booked = bs.filter((r) => r.status === 201).length;
    const end = (await one('select end_time::text e from provider_working_hours where id = $1', [wh])).e;
    const ok = (u.status === 200 && booked === 0 && end === '11:00:00') || (u.status === 409 && booked >= 1 && end === '12:00:00');
    scheduleConsistent &&= ok && ![u, ...bs].some((r) => r.status >= 500);
    evidence.scheduleRace.push({ update: u.status, booked });
  }
  check('D8 working-hours shrink vs concurrent bookings (6 rounds): never an active booking outside committed hours', scheduleConsistent, evidence.scheduleRace);
  await invariants('after D races');

  // ---------------------------------------------------------------- E. reviews, complaints, payment
  scenario('E. Reviews, complaints, payment');
  const reviewBody = { rating: 5, comment: 'Milo looks great' };
  const rev = await api('POST', `/bookings/${bA}/reviews`, { token: C1.t, body: reviewBody });
  example('Create review', 'POST', '/bookings/:id/reviews', reviewBody, rev);
  check('E1 review on own COMPLETED booking -> 201', rev.status === 201, rev);
  check('E1 duplicate review -> 409', (await api('POST', `/bookings/${bA}/reviews`, { token: C1.t, body: reviewBody })).status === 409);
  check('E1 review on a non-completed booking -> 409', (await api('POST', `/bookings/${bPend}/reviews`, { token: C2.t, body: reviewBody })).status === 409);
  check("E1 review on someone else's booking -> 404", (await api('POST', `/bookings/${bA}/reviews`, { token: C2.t, body: reviewBody })).status === 404);
  check('E1 rating out of range -> 400', (await api('POST', `/bookings/${bA}/reviews`, { token: C1.t, body: { rating: 6 } })).status === 400);
  const pubRev = await api('GET', `/reviews/provider/${P.pid}`);
  example('Public provider reviews', 'GET', '/reviews/provider/:providerId', null, pubRev);
  check('E2 public reviews list it without booking/customer fields', pubRev.status === 200 && pubRev.body.length === 1 && forbiddenIn(pubRev.body, PUBLIC_FORBIDDEN).length === 0, pubRev.body);
  check('E2 provider rating updated (5.00 / 1)', (await api('GET', `/providers/public/${P.pid}`)).body.ratingAvg === '5.00');
  const reviewId = String(rev.body.id);
  const hide = await api('PATCH', `/admin/reviews/${reviewId}/hide`, { token: ADMIN });
  const hiddenPublic = await api('GET', `/reviews/provider/${P.pid}`);
  const ratingHidden = (await api('GET', `/providers/public/${P.pid}`)).body;
  check('E3 admin hide -> 200, gone from public list, rating recomputed (0 / 0.00)', hide.status === 200 && hiddenPublic.body.length === 0 && ratingHidden.ratingCount === 0 && ratingHidden.ratingAvg === '0.00', { hide: hide.status, ratingHidden });
  check('E3 hide again -> 409', (await api('PATCH', `/admin/reviews/${reviewId}/hide`, { token: ADMIN })).status === 409);
  const restore = await api('PATCH', `/admin/reviews/${reviewId}/restore`, { token: ADMIN });
  check('E3 admin restore -> 200, visible again, rating 5.00 / 1', restore.status === 200 && (await api('GET', `/reviews/provider/${P.pid}`)).body.length === 1 && (await api('GET', `/providers/public/${P.pid}`)).body.ratingCount === 1, restore);
  check('E3 customer cannot moderate -> 403', (await api('PATCH', `/admin/reviews/${reviewId}/hide`, { token: C1.t })).status === 403);

  const complaintBody = { reason: 'The groomer arrived late.' };
  const cmp = await api('POST', `/bookings/${bCancel}/complaints`, { token: C2.t, body: complaintBody });
  example('Create complaint', 'POST', '/bookings/:id/complaints', complaintBody, cmp);
  check('E4 complaint on own CANCELLED booking -> 201 OPEN', cmp.status === 201 && cmp.body.status === 'OPEN', cmp);
  check('E5 duplicate active complaint -> 409', (await api('POST', `/bookings/${bCancel}/complaints`, { token: C2.t, body: complaintBody })).status === 409);
  check('E4 complaint on a PENDING booking -> 409', (await api('POST', `/bookings/${bPend}/complaints`, { token: C2.t, body: complaintBody })).status === 409);
  check("E4 complaint on someone else's booking -> 404", (await api('POST', `/bookings/${bCancel}/complaints`, { token: C1.t, body: complaintBody })).status === 404);
  check('E4 blank reason -> 400', (await api('POST', `/bookings/${bA}/complaints`, { token: C1.t, body: { reason: '   ' } })).status === 400);
  const cid = String(cmp.body.id);
  check('E6 resolve before review -> 409', (await api('PATCH', `/admin/complaints/${cid}/resolve`, { token: ADMIN, body: {} })).status === 409);
  const review = await api('PATCH', `/admin/complaints/${cid}/review`, { token: ADMIN, body: {} });
  const resolve = await api('PATCH', `/admin/complaints/${cid}/resolve`, { token: ADMIN, body: { adminNote: 'Refund voucher issued' } });
  check('E6 admin OPEN -> IN_REVIEW -> RESOLVED', review.status === 200 && review.body.status === 'IN_REVIEW' && resolve.status === 200 && resolve.body.status === 'RESOLVED', [review.status, resolve.status]);
  const cmp2 = await api('POST', `/bookings/${bCancel}/complaints`, { token: C2.t, body: { reason: 'Second issue' } });
  check('E5 new complaint allowed once the previous one is resolved', cmp2.status === 201, cmp2);
  await api('PATCH', `/admin/complaints/${cmp2.body.id}/review`, { token: ADMIN, body: {} });
  const rejectC = await api('PATCH', `/admin/complaints/${cmp2.body.id}/reject`, { token: ADMIN, body: { adminNote: 'Not substantiated' } });
  check('E6 admin rejects the second complaint -> REJECTED', rejectC.status === 200 && rejectC.body.status === 'REJECTED', rejectC);
  check('E customer sees own complaints only', (await api('GET', '/complaints/mine', { token: C2.t })).body.length === 2 && (await api('GET', '/complaints/mine', { token: C1.t })).body.length === 0);

  const payBody = { paymentStatus: 'PAID', method: 'CASH' };
  const pay = await api('PUT', `/payments/provider/booking/${bA}`, { token: P.t, body: payBody });
  example('Simulated payment (owner)', 'PUT', '/payments/provider/booking/:id', payBody, pay);
  check('E7 owner records payment on the COMPLETED booking -> 200 PAID, amount = bookedPrice', pay.status === 200 && pay.body.paymentStatus === 'PAID' && pay.body.amount === '150000.50' && pay.body.paidAt, pay);
  const paidAt = pay.body.paidAt;
  const pay2 = await api('PUT', `/payments/provider/booking/${bA}`, { token: P.t, body: payBody });
  check('E7 repeated PAID keeps the original paidAt', pay2.status === 200 && pay2.body.paidAt === paidAt, pay2.body);
  check('E7 staff cannot manage payments -> 403 (owner-only policy)', (await api('PUT', `/payments/provider/booking/${bA}`, { token: STAFF.t, body: payBody })).status === 403);
  check('E7 customer -> 403, other owner -> 404', (await api('PUT', `/payments/provider/booking/${bA}`, { token: C1.t, body: payBody })).status === 403 && (await api('PUT', `/payments/provider/booking/${bA}`, { token: P2.t, body: payBody })).status === 404);
  check('E7 payment on a non-completed booking -> 409', (await api('PUT', `/payments/provider/booking/${bPend}`, { token: P.t, body: payBody })).status === 409);
  check('E7 invalid payment status -> 400', (await api('PUT', `/payments/provider/booking/${bA}`, { token: P.t, body: { paymentStatus: 'REFUNDED' } })).status === 400);
  check('E7 owner reads payments', (await api('GET', `/payments/provider/booking/${bA}`, { token: P.t })).status === 200 && (await api('GET', '/payments/provider', { token: P.t })).status === 200);
  await invariants('after E');

  // ---------------------------------------------------------------- F. security and contracts
  scenario('F. Security and contract validation');
  const protectedCalls = [['GET', '/bookings/mine'], ['GET', '/bookings/provider'], ['POST', '/bookings'], ['GET', '/pets'], ['GET', '/admin/providers'], ['GET', '/dashboard/provider'], ['PUT', `/payments/provider/booking/${bA}`]];
  const unauth = await Promise.all(protectedCalls.map(([m, u]) => api(m, u, { body: m === 'GET' ? undefined : {} })));
  check('F 401 without a token on every protected route', unauth.every((r) => r.status === 401), unauth.map((r) => r.status));
  check('F 401 with a forged token', (await api('GET', '/bookings/mine', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.forged' })).status === 401);
  const wrongRole = {
    'customer -> admin': await api('GET', '/admin/providers', { token: C1.t }),
    'customer -> provider bookings': await api('GET', '/bookings/provider', { token: C1.t }),
    'owner -> create booking': await book({ t: P.t, pet: C1.pet }, slotA),
    'staff -> services': await api('POST', '/services', { token: STAFF.t, body: { categoryId: CATEGORY, name: 'x', price: 1, durationMinutes: 30 } }),
    'admin -> customer bookings': await api('GET', '/bookings/mine', { token: ADMIN }),
    'customer -> dashboard': await api('GET', '/dashboard/provider', { token: C1.t }),
  };
  check('F 403 for wrong roles', Object.values(wrongRole).every((r) => r.status === 403), Object.fromEntries(Object.entries(wrongRole).map(([k, r]) => [k, r.status])));
  const strict = {
    'unknown field': await api('POST', '/bookings', { token: C1.t, body: { petId: C1.pet, slotId: slotA, status: 'CONFIRMED' } }),
    'non-numeric id': await api('GET', '/bookings/mine/abc', { token: C1.t }),
    'zero id': await api('POST', '/bookings/provider/0/confirm', { token: P.t }),
    'malformed JSON': await api('POST', '/bookings', { token: C1.t, raw: '{"petId":' }),
    'bad slot time': await api('POST', '/availability', { token: P.t, body: { serviceId: S1, slotDate: D6, startTime: '25:00', endTime: '26:00', capacity: 1 } }),
    'invalid date': await api('GET', '/availability/public/search?date=2027-02-30'),
  };
  check('F 400 for strict DTO validation', Object.values(strict).every((r) => r.status === 400), Object.fromEntries(Object.entries(strict).map(([k, r]) => [k, r.status])));
  const before = await tableHash();
  await Promise.all([...unauth.map(() => api('GET', '/bookings/mine')), api('GET', '/admin/providers', { token: C1.t }), api('POST', '/bookings/provider/0/confirm', { token: P.t }), api('POST', '/bookings', { token: C1.t, body: { petId: C1.pet, slotId: slotA, status: 'CONFIRMED' } }), api('GET', `/bookings/mine/${bA}`, { token: C2.t })]);
  check('F 401/403/400/404 requests leave every table unchanged', (await tableHash()) === before);

  // Clock boundaries (deterministic at any time of day).
  const pastSlot = (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity) values ($1, $2, $3, '09:00', '10:00', 2) returning id::text`, [P.pid, S1, vnDate(-1)])).id;
  const startedSlot = (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity) values ($1, $2, $3, '00:00:00', '23:59:59', 2) returning id::text`, [P.pid, S1, vnDate(0)])).id;
  check('[boundary] booking a slot dated yesterday -> 400', (await book(C2, pastSlot)).status === 400);
  check('[boundary] booking a slot that started today at 00:00:00 -> 400 "already started"', ((r) => r.status === 400 && /already started/.test(message(r)))(await book(C2, startedSlot)));
  check('[boundary] neither slot is publicly listed', (await api('GET', `/availability/public/${pastSlot}`)).status === 404 && (await api('GET', `/availability/public/${startedSlot}`)).status === 404);
  check('[boundary] creating a slot for yesterday via the API -> 400', (await api('POST', '/availability', { token: P.t, body: { serviceId: S1, slotDate: vnDate(-1), startTime: '09:00', endTime: '10:00', capacity: 1 } })).status === 400);

  // Provider visibility and suspension.
  await api('PATCH', `/admin/providers/${P2.pid}/suspend`, { token: ADMIN });
  const S2 = await (async () => { await api('PATCH', `/admin/providers/${P2.pid}/reactivate`, { token: ADMIN }); const s = await service(P2); await api('PATCH', `/admin/providers/${P2.pid}/suspend`, { token: ADMIN }); return s; })();
  check('F SUSPENDED provider hidden: detail 404, search, services', (await api('GET', `/providers/public/${P2.pid}`)).status === 404 && !(await api('GET', `/providers/public/search?q=${RUN}`)).body.items.some((i) => i.id === P2.pid) && (await api('GET', `/services/public/${S2}`)).status === 404);
  await api('PATCH', `/admin/providers/${P2.pid}/reactivate`, { token: ADMIN });
  check('F reactivated provider visible again', (await api('GET', `/providers/public/${P2.pid}`)).status === 200);

  // Swagger vs. actual responses.
  const doc = (await api('GET', '/docs-json')).body;
  const schemaPaths = (schema, prefix = '') => {
    if (!schema) return [];
    if (schema.type === 'array') return schemaPaths(schema.items, `${prefix}[]`);
    return Object.entries(schema.properties ?? {}).flatMap(([k, v]) => { const p = prefix ? `${prefix}.${k}` : k; return [p, ...schemaPaths(v, p)]; });
  };
  const success = (p, m, code) => doc.paths[p]?.[m]?.responses?.[code]?.content?.['application/json']?.schema;
  const swaggerChecks = [
    ['/api/bookings', 'post', '201', CUSTOMER_VIEW],
    ['/api/bookings/mine', 'get', '200', CUSTOMER_VIEW.map((p) => `[].${p}`)],
    ['/api/bookings/mine/{id}', 'get', '200', CUSTOMER_DETAIL],
    ['/api/bookings/mine/{id}/cancel', 'post', '201', CUSTOMER_VIEW],
    ['/api/bookings/provider', 'get', '200', PROVIDER_VIEW.map((p) => `[].${p}`)],
    ['/api/bookings/provider/{id}', 'get', '200', PROVIDER_DETAIL],
    ...['confirm', 'reject', 'complete', 'no-show'].map((v) => [`/api/bookings/provider/{id}/${v}`, 'post', '201', PROVIDER_VIEW]),
  ];
  const swaggerMismatch = swaggerChecks.filter(([p, m, code, expected]) => !same(schemaPaths(success(p, m, code)).map((x) => x.replace(/^\[\]\./, '[].')).sort(), [...expected].sort()));
  check('F Swagger booking schemas match the actual projections and success codes', swaggerMismatch.length === 0, swaggerMismatch.map((x) => x[0]));
  check('F Swagger documents Idempotency-Key and Idempotent-Replayed', doc.paths['/api/bookings'].post.parameters.some((x) => x.name === 'Idempotency-Key' && x.required === false) && !!doc.paths['/api/bookings'].post.responses['201'].headers['Idempotent-Replayed']);
  check('F CORS exposes Idempotent-Replayed to the browser', await (async () => {
    const r = await fetch(`http://localhost:${PORTS[0]}/api/bookings`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'POST' } });
    const pre = await fetch(`http://localhost:${PORTS[0]}/api/providers/public/${P.pid}`, { headers: { Origin: 'http://localhost:3001' } });
    return r.status < 300 && /idempotent-replayed/i.test(pre.headers.get('access-control-expose-headers') ?? '');
  })());
  await invariants('final');

  evidence.skipped = skipped;
  await stopAll();
  await db.end();
  if (process.env.QA_KEEP_DB !== '1') await dropDatabase();
}

main()
  .catch(async (error) => {
    check('harness completed without errors', false, error.stack);
    await stopAll();
  })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    const byScenario = {};
    for (const r of results) {
      byScenario[r.scenario] = byScenario[r.scenario] ?? { pass: 0, fail: 0 };
      byScenario[r.scenario][r.pass ? 'pass' : 'fail']++;
    }
    fs.writeFileSync(path.join(OUT_DIR, 'mvp-e2e-results.json'), JSON.stringify({ run: RUN, database: QA_DB, byScenario, results, evidence }, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'mvp-e2e-examples.json'), JSON.stringify(examples, null, 2));
    console.log('\nSCENARIOS', JSON.stringify(byScenario));
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}  SKIPPED ${skipped.length}`);
    console.log(`Results: ${OUT_DIR}`);
    process.exitCode = failed.length ? 1 : 0;
  });
