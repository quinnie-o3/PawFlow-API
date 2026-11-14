/*
 * Shared helpers for the disposable-database QA scripts (demo seed, FE smoke).
 *
 * Safety rules enforced here:
 * - QA database names must match `pawflow_qa_*` and differ from the
 *   development DB_DATABASE in .env; the development database is never
 *   connected to.
 * - `current_database()` is verified before any write.
 * - The app is started from an empty temporary directory with explicit
 *   environment variables, so the repository .env cannot redirect it.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const TZ = 'Asia/Ho_Chi_Minh';
const MAIN = path.join(ROOT, 'dist', 'main.js');

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

function assertQaDatabaseName(name) {
  if (!/^pawflow_qa_[a-z0-9_]+$/.test(name) || name === dotEnv.DB_DATABASE) {
    throw new Error(`Refusing to use "${name}": QA databases must be named pawflow_qa_* and differ from the development database`);
  }
}

function assertBuilt() {
  if (!fs.existsSync(MAIN)) throw new Error('dist/main.js not found: run `npm run build` first');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Number of compiled source migrations (dist/database/migrations/*.js). */
function sourceMigrationCount() {
  return fs.readdirSync(path.join(ROOT, 'dist', 'database', 'migrations')).filter((file) => file.endsWith('.js')).length;
}

/** Business-time-zone calendar date, `offsetDays` from today (YYYY-MM-DD). */
function vnDate(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offsetDays * 86400000));
}
const dayOfWeek = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Drops and recreates the QA database, verifies it, runs every source migration. */
async function prepareDatabase(name) {
  assertQaDatabaseName(name);
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const db = new Client({ ...DB, database: name });
  await db.connect();
  const identity = (await db.query('select current_database() as d')).rows[0].d;
  if (identity !== name) throw new Error('ISOLATION FAILURE: connected to ' + identity);

  const dataSource = new DataSource({
    type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: name,
    synchronize: false,
    entities: [path.join(ROOT, 'dist', '**', '*.entity.js')],
    migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')],
  });
  await dataSource.initialize();
  const executed = await dataSource.runMigrations({ transaction: 'each' });
  const pendingDdl = (await dataSource.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
  await dataSource.destroy();

  return { db, migrations: executed.map((m) => m.name), pendingDdl };
}

async function dropDatabase(name) {
  assertQaDatabaseName(name);
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
}

/** Starts dist/main.js on each port against the QA database. */
/**
 * P3-BE03: QA apps get an explicit bot-protection / rate-limit configuration
 * instead of inheriting the caller's environment. Legacy suites (functional
 * QA, not abuse QA) run with both explicitly disabled, which the application
 * allows only when NODE_ENV is not production. Suites that test protection
 * pass `env` overrides, e.g. { TURNSTILE_MODE: 'enforce', ... }.
 */
const QA_SECURITY_DEFAULTS = { TURNSTILE_MODE: 'disabled', AUTH_RATE_LIMIT: 'disabled' };

function createApp(name, ports, { logDir = os.tmpdir(), jwtSecret = randomUUID() + randomUUID(), env: extraEnv = {} } = {}) {
  assertQaDatabaseName(name);
  assertBuilt();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-qa-run-'));
  const procs = {};

  const start = (port) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(DB_|JWT_|PORT$|QA_|TURNSTILE_|AUTH_RATE_LIMIT|RATE_LIMIT_|TRUST_PROXY$)/.test(key)) delete env[key];
    Object.assign(env, {
      TZ, PORT: String(port), NODE_ENV: 'test',
      DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USERNAME: DB.user, DB_PASSWORD: DB.password, DB_DATABASE: name,
      JWT_SECRET: jwtSecret, JWT_EXPIRES_IN_SECONDS: '86400',
      FRONTEND_URL: process.env.QA_FRONTEND_URL ?? 'http://localhost:3000',
      ...QA_SECURITY_DEFAULTS,
      ...extraEnv,
    });
    const log = fs.openSync(path.join(logDir, `app-${name}-${port}.log`), 'a');
    procs[port] = spawn(process.execPath, [MAIN], { cwd: runDir, env, stdio: ['ignore', log, log] });
    return (async () => {
      for (let i = 0; i < 200; i++) {
        try { await fetch(`http://localhost:${port}/api`); return; } catch { await sleep(150); }
      }
      throw new Error('app did not start on port ' + port);
    })();
  };

  return {
    ports,
    start: () => Promise.all(ports.map(start)),
    stop: () => Promise.all(ports.map((port) => new Promise((resolve) => {
      const child = procs[port];
      // Already exited (normally or by signal): stopping twice must not wait for an 'exit' that already fired.
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    }))),
  };
}

/** Minimal JSON HTTP client; alternates between the given ports. */
function createApi(ports) {
  let next = 0;
  return async function api(method, url, { token, body, key, port, headers: extra } = {}) {
    const target = port ?? ports[next++ % ports.length];
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`http://localhost:${target}/api${url}`, init);
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, replayed: res.headers.get('idempotent-replayed'), headers: res.headers };
  };
}

/** Every key path of a JSON value, e.g. `pet.petType.name`, `[].id`. */
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
const forbiddenIn = (value, keys) => keyPaths(value).filter((p) => keys.includes(p.split('.').pop().replace(/^\[\]/, '')));

/** Booking/capacity/log/idempotency invariants for the given providers. All values must be 0. */
async function bookingInvariants(db, providerIds) {
  return (await db.query(`
    with p as (select unnest($1::bigint[]) as id)
    select
      (select count(*)::int from availability_slots s where s.provider_id in (select id from p)
         and s.booked_count <> (select count(*) from bookings b where b.slot_id = s.id and b.status not in ('CANCELLED','REJECTED'))) as capacity_mismatch,
      (select count(*)::int from availability_slots s where s.provider_id in (select id from p) and s.booked_count > s.capacity) as over_capacity,
      (select count(*)::int from bookings b where b.provider_id in (select id from p)
         and (select count(*) from booking_status_logs l where l.booking_id = b.id and l.old_status is null) <> 1) as initial_log_not_one,
      (select count(*)::int from bookings b where b.provider_id in (select id from p)
         and b.status <> (select l.new_status from booking_status_logs l where l.booking_id = b.id order by l.created_at desc, l.id desc limit 1)) as last_log_mismatch,
      (select count(*)::int from booking_idempotency_keys k left join bookings b on b.id = k.booking_id
         where b.id is null or b.customer_id <> k.customer_id) as key_owner_mismatch,
      (select count(*)::int from provider_working_hours a join provider_working_hours b
         on a.provider_id = b.provider_id and a.day_of_week = b.day_of_week and a.id < b.id
         where a.provider_id in (select id from p) and a.is_active and b.is_active and a.start_time < b.end_time and b.start_time < a.end_time) as overlapping_hours,
      (select count(*)::int from providers pr where pr.id in (select id from p)
         and pr.rating_count <> (select count(*) from reviews r join bookings b on b.id = r.booking_id where b.provider_id = pr.id and r.is_visible)) as rating_count_mismatch,
      (select deadlocks::int from pg_stat_database where datname = current_database()) as deadlocks`, [providerIds.map(Number)])).rows[0];
}

module.exports = {
  ROOT, TZ, DB, Client, sleep, vnDate, dayOfWeek, sourceMigrationCount,
  assertQaDatabaseName, prepareDatabase, dropDatabase, createApp, createApi,
  keyPaths, shape, forbiddenIn, bookingInvariants,
};
