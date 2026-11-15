/*
 * P3-BE11 release security and staging rehearsal: real processes, real HTTP,
 * real PostgreSQL, disposable QA databases only (pawflow_qa_*).
 *
 *   npm run build
 *   npm run qa:release-security
 *
 * 1. Migration rehearsal (isolated databases): clean apply (17), re-run is a
 *    no-op, the build's expected names equal the applied ones, every
 *    migration rolls back (17 x down) and re-applies, no pending DDL.
 * 2. Least-privilege staging role: a run-owned role with DML only (no DDL);
 *    the staging app runs with it.
 * 3. Startup refusal: unsafe staging configurations stop the process with a
 *    sanitized message and never reach the database; a pending migration
 *    stops a staging boot (MIGRATIONS_CHECK=enforce).
 * 4. NODE_ENV=staging instances (direct exposure and behind a trusted
 *    proxy): health, headers, HSTS, Swagger off, CORS allowlist.
 * 5. Rate limits with real counters: boundary, 429 contract, Retry-After,
 *    X-Request-ID, spoofed forwarding headers, trusted-proxy client
 *    isolation (IPv4, IPv6 /64, malformed), exact enforcement across two
 *    instances under concurrency, window expiry, per-user budgets, auth
 *    policies before bot verification, fail-closed store outage.
 * 6. Readiness during a database outage and after recovery.
 * 7. Logs: JSON only, no secret, no client address or bucket.
 *
 * Every rate-limit scenario starts from an empty counter table (DELETE in
 * the QA database), so scenarios are independent and order-insensitive.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_release_security), QA_PORTS
 * (default 8371,8372,8373,8374,8375), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const { ROOT, DB, Client, sleep, prepareDatabase, dropDatabase, createApp, assertQaDatabaseName } = require('./qa-env.cjs');
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_release_security';
const MIG_NAME = `${NAME}_mig`;
const PORTS = (process.env.QA_PORTS ?? '8371,8372,8373,8374,8375').split(',').map(Number);
const [P_SA, P_SB, P_SP, P_SW, P_T] = PORTS;
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-release-security-'));
const MAIN = path.join(ROOT, 'dist', 'main.js');
const RUN = 'rs' + Date.now().toString(36);
const ROLE = `pawflow_qa_role_${RUN}`;
const ROLE_PASSWORD = `Qa-${randomBytes(18).toString('base64url')}`;
const JWT_SECRET = randomBytes(48).toString('base64url');
const HASH_SECRET = randomBytes(48).toString('base64url');
const TURNSTILE_SECRET = `qa-staging-${randomBytes(16).toString('hex')}`;
const PASSWORD = 'QaReleaseSecurity123!';
const ORIGIN = 'https://staging.pawflow.example';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ROUTE = '/services/public';

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 1200)}`);
}
const section = (title) => console.log(`\n## ${title}`);

/** A complete NODE_ENV=staging configuration for the QA database (placeholders and run-owned secrets only). */
const stagingEnv = (overrides = {}) => ({
  NODE_ENV: 'staging',
  DB_USERNAME: ROLE,
  DB_PASSWORD: ROLE_PASSWORD,
  DB_SSL: 'disable', // same-host PostgreSQL (loopback) in the rehearsal; a remote staging database requires require/no-verify
  JWT_SECRET,
  RATE_LIMIT_HASH_SECRET: HASH_SECRET,
  CORS_ORIGINS: ORIGIN,
  TRUST_PROXY: 'false',
  TURNSTILE_MODE: 'enforce',
  TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
  TURNSTILE_EXPECTED_HOSTNAMES: 'staging.pawflow.example',
  AUTH_RATE_LIMIT: 'enabled',
  API_RATE_LIMIT: 'enabled',
  // Low, test-scoped thresholds so boundaries are reached quickly (production defaults are asserted in Jest).
  RATE_LIMIT_API_IP: '30/60',
  RATE_LIMIT_PUBLIC_IP: '10/60',
  RATE_LIMIT_USER_READ: '1000/60',
  RATE_LIMIT_USER_WRITE: '3/60',
  RATE_LIMIT_LOGIN_IP: '5/300',
  PUSH_DELIVERY_MODE: 'disabled',
  PUSH_REGISTRATION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
  PUSH_REGISTRATION_HASH_KEY: randomBytes(32).toString('base64'),
  MAIL_TRANSPORT: 'disabled',
  LOG_FORMAT: 'json',
  ...overrides,
});

/** Starts dist/main.js once and waits for it to exit (startup refusal) or to answer (unexpected success). */
function bootOnce(env, port, label) {
  return new Promise((resolve) => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-qa-boot-'));
    const base = { ...process.env };
    for (const key of Object.keys(base)) if (/^(DB_|JWT_|PORT$|QA_|TURNSTILE_|AUTH_RATE_LIMIT|API_RATE_LIMIT|RATE_LIMIT_|TRUST_PROXY$|CORS_ORIGINS$|SWAGGER_|HSTS_|MIGRATIONS_CHECK$|HEALTH_|NODE_ENV$|PUSH_|MAIL_|LOG_)/.test(key)) delete base[key];
    const child = spawn(process.execPath, [MAIN], {
      cwd: runDir,
      env: { ...base, TZ: 'Asia/Ho_Chi_Minh', PORT: String(port), DB_HOST: DB.host, DB_PORT: String(DB.port), DB_DATABASE: NAME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    let answered = false;
    const poll = setInterval(async () => {
      try { await fetch(`http://localhost:${port}/api/health/live`); answered = true; child.kill(); } catch { /* not up */ }
    }, 300);
    const timer = setTimeout(() => child.kill(), 40_000);
    child.on('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      fs.writeFileSync(path.join(OUT_DIR, `boot-${label}.log`), output);
      resolve({ code, output, answered });
    });
  });
}

async function main() {
  assertQaDatabaseName(MIG_NAME);
  const prepared = await prepareDatabase(NAME);
  const db = prepared.db;
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const apps = [];
  let roleCreated = false;
  const secrets = [JWT_SECRET, HASH_SECRET, TURNSTILE_SECRET, ROLE_PASSWORD, PASSWORD, DB.password].filter((s) => s && s.length >= 6);
  const responses = [];
  const call = async (port, method, url, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const init = { method, headers: h };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`http://localhost:${port}/api${url}`, init);
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const r = { status: res.status, body: json, headers: res.headers };
    responses.push({ port, method, url, status: r.status, requestId: res.headers.get('x-request-id') });
    return r;
  };
  const resetCounters = () => db.query('DELETE FROM auth_rate_limits');

  try {
    // ------------------------------------------------------------------ 1
    section('1. Migration rehearsal (isolated databases)');
    {
      const expected = require(path.join(ROOT, 'dist', 'health', 'schema-status.service.js')).expectedMigrationNames();
      check('clean database: all 17 migrations apply, 0 pending DDL', prepared.migrations.length === 17 && prepared.pendingDdl.length === 0, { count: prepared.migrations.length, pendingDdl: prepared.pendingDdl });
      check('the build\'s expected migration names (used by the startup schema check) equal the applied names', JSON.stringify([...expected].sort()) === JSON.stringify([...prepared.migrations].sort()), { expected, applied: prepared.migrations });

      const ds = (database) => new DataSource({
        type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database, synchronize: false,
        entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')],
      });
      const again = ds(NAME);
      await again.initialize();
      const rerun = await again.runMigrations({ transaction: 'each' });
      await again.destroy();
      check('re-running migrations on an up-to-date database is a no-op (0 executed)', rerun.length === 0, rerun.map((m) => m.name));

      const mig = await prepareDatabase(MIG_NAME);
      await mig.db.end();
      const m = ds(MIG_NAME);
      await m.initialize();
      const undone = [];
      let downError = null;
      try {
        for (let i = 0; i < 17; i++) {
          const before = (await m.query('SELECT count(*)::int c FROM migrations'))[0].c;
          await m.undoLastMigration({ transaction: 'each' });
          undone.push(before - (await m.query('SELECT count(*)::int c FROM migrations'))[0].c);
        }
      } catch (error) {
        downError = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error);
      }
      const leftover = (await m.query(`SELECT count(*)::int c FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`))[0].c;
      check('every migration rolls back in order (17 x down): no error, no application table left', downError === null && undone.length === 17 && undone.every((n) => n === 1) && leftover === 0, { downError, undone, leftover });
      const reup = await m.runMigrations({ transaction: 'each' });
      const pendingAfter = (await m.driver.createSchemaBuilder().log()).upQueries.length;
      check('after a full rollback the chain re-applies (17) with 0 pending DDL', reup.length === 17 && pendingAfter === 0, { reup: reup.length, pendingAfter });
      await m.undoLastMigration({ transaction: 'each' }); // leave MIG one migration behind for the startup check below
      await m.destroy();
    }

    // ------------------------------------------------------------------ 2
    section('2. Least-privilege staging role');
    {
      await db.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      roleCreated = true;
      for (const database of [NAME, MIG_NAME]) {
        const admin = new Client({ ...DB, database });
        await admin.connect();
        await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${ROLE}`);
        await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
        await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
        await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
        await admin.end();
      }
      const app = new Client({ ...DB, user: ROLE, password: ROLE_PASSWORD, database: NAME });
      await app.connect();
      const ddl = await app.query('CREATE TABLE qa_should_fail (id int)').then(() => 'allowed', (e) => e.code);
      const drop = await app.query('DROP TABLE users').then(() => 'allowed', (e) => e.code);
      const dml = await app.query('SELECT count(*)::int c FROM users').then(() => 'ok', (e) => e.code);
      await app.end();
      check('the staging role can read/write rows but cannot create or drop tables (42501)', ddl === '42501' && drop === '42501' && dml === 'ok', { ddl, drop, dml });
    }

    // ------------------------------------------------------------------ 3
    section('3. Startup refusal (sanitized, before any database access)');
    {
      const variants = [
        ['development database name', { DB_DATABASE: 'pet_care_db' }, /DB_DATABASE must be a dedicated/],
        ['NODE_ENV typo', { NODE_ENV: 'prod' }, /NODE_ENV must be one of/],
        ['missing CORS_ORIGINS', { CORS_ORIGINS: '' }, /CORS_ORIGINS is required/],
        ['TRUST_PROXY unset', { TRUST_PROXY: '' }, /TRUST_PROXY must be set explicitly/],
        ['TRUST_PROXY=true', { TRUST_PROXY: 'true' }, /TRUST_PROXY=true would trust spoofed/],
        ['weak JWT secret', { JWT_SECRET: 'short-secret' }, /JWT_SECRET must be a random value/],
        ['superuser database account', { DB_USERNAME: 'postgres' }, /least-privilege role/],
        ['API rate limit disabled', { API_RATE_LIMIT: 'disabled' }, /API_RATE_LIMIT=disabled is not allowed/],
        ['wildcard CORS origin', { CORS_ORIGINS: 'https://*.pawflow.example' }, /wildcards/],
      ];
      const failures = [];
      for (const [label, override, expected] of variants) {
        const r = await bootOnce(stagingEnv(override), P_SA, label.replace(/\W+/g, '-'));
        const refused = r.code !== 0 && !r.answered && /"event":"app\.startup_refused"/.test(r.output) && expected.test(r.output);
        const neverConnected = !/InstanceLoader|TypeOrmModule/.test(r.output);
        const leaks = secrets.filter((s) => r.output.includes(s));
        if (!refused || !neverConnected || leaks.length) failures.push({ label, code: r.code, answered: r.answered, neverConnected, leaks: leaks.length, out: r.output.slice(-300) });
      }
      check(`${variants.length} unsafe staging configurations: process refuses before Nest starts (no database access), names the variable, prints no secret`, failures.length === 0, failures);

      // Rules enforced by the existing module loaders (BE11 regression: they used to apply to production only).
      const loaderVariants = [
        ['bot protection disabled', { TURNSTILE_MODE: 'disabled' }, /TURNSTILE_MODE=disabled is not allowed when NODE_ENV=staging/],
        ['Cloudflare test secret', { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }, /Cloudflare test secret/],
        ['auth rate limit disabled', { AUTH_RATE_LIMIT: 'disabled' }, /AUTH_RATE_LIMIT=disabled is not allowed when NODE_ENV=staging/],
        ['file mail transport', { MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: os.tmpdir() }, /MAIL_TRANSPORT=file is not allowed when NODE_ENV=staging/],
        ['text logs', { LOG_FORMAT: 'text' }, /LOG_FORMAT=text is not allowed when NODE_ENV=staging/],
        ['derived push keys', { PUSH_REGISTRATION_KEYS: '', PUSH_REGISTRATION_HASH_KEY: '' }, /required when NODE_ENV=staging/],
      ];
      const loaderFailures = [];
      for (const [label, override, expected] of loaderVariants) {
        const r = await bootOnce(stagingEnv(override), P_SA, label.replace(/\W+/g, '-'));
        const leaks = secrets.filter((s) => r.output.includes(s));
        if (r.code === 0 || r.answered || !expected.test(r.output) || leaks.length) loaderFailures.push({ label, code: r.code, answered: r.answered, leaks: leaks.length, out: r.output.slice(-300) });
      }
      check(`${loaderVariants.length} development shortcuts are refused in staging (regression: previously production-only)`, loaderFailures.length === 0, loaderFailures);

      const pending = await bootOnce(stagingEnv({ DB_DATABASE: MIG_NAME }), P_SA, 'pending-migration');
      check('staging boot on a database one migration behind -> refused by the schema check (1 pending), nothing served', pending.code !== 0 && !pending.answered && /Database schema check failed \(1 pending, 0 not in this build\)/.test(pending.output), { code: pending.code, answered: pending.answered, out: pending.output.slice(-400) });
    }

    // ------------------------------------------------------------------ 4
    section('4. Staging instances: health, headers, HSTS, Swagger, CORS');
    const logDir = path.join(OUT_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const start = async (port, env) => { const app = createApp(NAME, [port], { logDir, jwtSecret: JWT_SECRET, env }); await app.start(); apps.push(app); };
    await start(P_SA, stagingEnv());
    await start(P_SB, stagingEnv());
    await start(P_SP, stagingEnv({ TRUST_PROXY: 'loopback' }));
    await start(P_SW, stagingEnv({ RATE_LIMIT_PUBLIC_IP: '5/3' }));
    // A test-mode instance on the same database and JWT secret, only to log users in (staging enforces Turnstile).
    await start(P_T, { NODE_ENV: 'test', TURNSTILE_MODE: 'disabled', AUTH_RATE_LIMIT: 'disabled' });
    {
      const live = await call(P_SA, 'GET', '/health/live');
      const ready = await call(P_SA, 'GET', '/health/ready');
      check('liveness 200 {status:ok}; readiness 200 {database:up, schema:current}; bodies minimal', live.status === 200 && JSON.stringify(live.body) === '{"status":"ok"}' && ready.status === 200 && JSON.stringify(ready.body) === '{"status":"ready","checks":{"database":"up","schema":"current"}}', { live: live.body, ready: ready.body });
      const h = ready.headers;
      check('security headers on staging responses; no X-Powered-By; X-Request-ID', h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' && h.get('referrer-policy') === 'no-referrer' && /default-src 'none'/.test(h.get('content-security-policy') ?? '') && h.get('cache-control') === 'no-store' && h.get('x-powered-by') === null && UUID_V4.test(h.get('x-request-id') ?? ''), Object.fromEntries(h.entries()));
      const docs = await call(P_SA, 'GET', '/docs');
      const docsJson = await call(P_SA, 'GET', '/docs-json');
      check('Swagger is not exposed in staging by default (/api/docs and /api/docs-json -> 404)', docs.status === 404 && docsJson.status === 404, { docs: docs.status, docsJson: docsJson.status });
      const direct = await call(P_SA, 'GET', '/health/live');
      const spoof = await call(P_SA, 'GET', '/health/live', { headers: { 'X-Forwarded-Proto': 'https' } });
      const proxied = await call(P_SP, 'GET', '/health/live', { headers: { 'X-Forwarded-Proto': 'https' } });
      const proxiedHttp = await call(P_SP, 'GET', '/health/live', { headers: { 'X-Forwarded-Proto': 'http' } });
      check('HSTS only for HTTPS via the trusted proxy: none on direct HTTP, none for spoofed X-Forwarded-Proto, none for proxied HTTP', direct.headers.get('strict-transport-security') === null && spoof.headers.get('strict-transport-security') === null && proxied.headers.get('strict-transport-security') === 'max-age=15552000; includeSubDomains' && proxiedHttp.headers.get('strict-transport-security') === null, { direct: direct.headers.get('strict-transport-security'), spoof: spoof.headers.get('strict-transport-security'), proxied: proxied.headers.get('strict-transport-security') });
      const allowed = await call(P_SA, 'GET', '/health/live', { headers: { Origin: ORIGIN } });
      const localhost = await call(P_SA, 'GET', '/health/live', { headers: { Origin: 'http://localhost:3000' } });
      const suffix = await call(P_SA, 'GET', '/health/live', { headers: { Origin: `${ORIGIN}.attacker.example` } });
      const preflight = await fetch(`http://localhost:${P_SA}/api/bookings`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
      check('CORS in staging: only the configured origin (credentials, X-Request-ID exposed); localhost and look-alike origins get nothing; preflight 204', allowed.headers.get('access-control-allow-origin') === ORIGIN && allowed.headers.get('access-control-allow-credentials') === 'true' && /X-Request-ID/.test(allowed.headers.get('access-control-expose-headers') ?? '') && localhost.headers.get('access-control-allow-origin') === null && suffix.headers.get('access-control-allow-origin') === null && preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === ORIGIN, { allowed: allowed.headers.get('access-control-allow-origin'), localhost: localhost.headers.get('access-control-allow-origin'), preflight: preflight.status });
      const anon = await call(P_SA, 'GET', '/bookings/mine', { headers: { Origin: ORIGIN } });
      check('an allowed origin does not replace authentication (401)', anon.status === 401, anon.status);
    }

    // ------------------------------------------------------------------ 5
    section('5. Rate limits (PostgreSQL counters shared by all instances)');
    const burst = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push(await fn(i)); return out; };
    {
      await resetCounters();
      const ok = await burst(10, () => call(P_SA, 'GET', PUBLIC_ROUTE));
      const over = await call(P_SA, 'GET', PUBLIC_ROUTE, { headers: { 'X-Request-ID': `qa-429-${RUN}` } });
      const retry = Number(over.headers.get('retry-after'));
      check('public_ip 10/60: requests 1-10 -> 200, request 11 -> 429', ok.every((r) => r.status === 200) && over.status === 429, { ok: ok.map((r) => r.status), over: over.status });
      check('429 contract: { statusCode, error, message, code: RATE_LIMITED, retryAfterSeconds } = Retry-After (1..60 s); X-Request-ID kept; security headers present',
        JSON.stringify(Object.keys(over.body ?? {})) === JSON.stringify(['statusCode', 'error', 'message', 'code', 'retryAfterSeconds']) && over.body.code === 'RATE_LIMITED' && over.body.retryAfterSeconds === retry && retry >= 1 && retry <= 60 && over.headers.get('x-request-id') === `qa-429-${RUN}` && over.headers.get('x-content-type-options') === 'nosniff',
        { body: over.body, retry });
    }
    {
      await resetCounters();
      const floods = await burst(31, () => call(P_SA, 'GET', '/bookings/mine', { token: 'forged.token.value' }));
      check('api_ip 30/60 applies before authentication: 30 x 401, then 429 (token guessing is throttled, never 500)', floods.slice(0, 30).every((r) => r.status === 401) && floods[30].status === 429, floods.map((r) => r.status).join(','));
    }
    {
      await resetCounters();
      const spoofed = await burst(11, (i) => call(P_SA, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': `198.51.100.${i}`, 'CF-Connecting-IP': `203.0.113.${i}`, 'X-Real-IP': `192.0.2.${i}`, Forwarded: `for=192.0.2.${i}` } }));
      check('direct exposure: rotating X-Forwarded-For / CF-Connecting-IP / X-Real-IP / Forwarded does not create new budgets (11th -> 429)', spoofed.slice(0, 10).every((r) => r.status === 200) && spoofed[10].status === 429, spoofed.map((r) => r.status).join(','));
    }
    {
      await resetCounters();
      const clientA = await burst(11, () => call(P_SP, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': '203.0.113.1' } }));
      const clientB = await call(P_SP, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': '203.0.113.2' } });
      check('trusted proxy: each forwarded client has its own budget (A: 10 x 200 + 429; B: 200)', clientA.slice(0, 10).every((r) => r.status === 200) && clientA[10].status === 429 && clientB.status === 200, { a: clientA.map((r) => r.status).join(','), b: clientB.status });
      await resetCounters();
      const v6 = await burst(10, (i) => call(P_SP, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': `2001:db8:0:1::${i + 1}` } }));
      const sameNet = await call(P_SP, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': '2001:db8:0:1:ffff::99' } });
      const otherNet = await call(P_SP, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': '2001:db8:0:2::1' } });
      check('IPv6 clients are grouped per /64: 10 addresses of one /64 exhaust it (429), another /64 is independent (200)', v6.every((r) => r.status === 200) && sameNet.status === 429 && otherNet.status === 200, { sameNet: sameNet.status, otherNet: otherNet.status });
      await resetCounters();
      const junk = await burst(11, (i) => call(P_SP, 'GET', PUBLIC_ROUTE, { headers: { 'X-Forwarded-For': `not-an-ip-${i}` } }));
      check('malformed X-Forwarded-For values share one bucket (no bypass): 11th -> 429', junk.slice(0, 10).every((r) => r.status === 200) && junk[10].status === 429, junk.map((r) => r.status).join(','));
    }
    {
      await resetCounters();
      const concurrent = await Promise.all(Array.from({ length: 24 }, (_, i) => call(i % 2 ? P_SB : P_SA, 'GET', PUBLIC_ROUTE)));
      const okCount = concurrent.filter((r) => r.status === 200).length;
      const row = await one(`SELECT coalesce(max(hits), 0)::int hits FROM auth_rate_limits WHERE policy = 'public_ip'`);
      check('24 concurrent requests on 2 instances: exactly 10 x 200 and 14 x 429 (one shared PostgreSQL counter, hits = 24)', okCount === 10 && concurrent.filter((r) => r.status === 429).length === 14 && row.hits === 24, { okCount, hits: row.hits });
    }
    {
      await resetCounters();
      const first = await burst(6, () => call(P_SW, 'GET', PUBLIC_ROUTE));
      const retry = Number(first[5].headers.get('retry-after'));
      await sleep(retry * 1000 + 500);
      const after = await call(P_SW, 'GET', PUBLIC_ROUTE);
      check(`window expiry (public_ip 5/3 s): 5 x 200, 429 with Retry-After ${retry} s (<= 3), 200 again after it`, first.slice(0, 5).every((r) => r.status === 200) && first[5].status === 429 && retry >= 1 && retry <= 3 && after.status === 200, { first: first.map((r) => r.status).join(','), retry, after: after.status });
    }
    {
      const hash = await bcrypt.hash(PASSWORD, 10);
      for (const n of ['alice', 'bob']) await db.query(`INSERT INTO users(full_name, email, password_hash, role, status) VALUES ($1, $2, $3, 'CUSTOMER', 'ACTIVE')`, [`QA ${n}`, `${n}.${RUN}@qa.test`, hash]);
      const login = async (n) => { const r = await call(P_T, 'POST', '/auth/login', { body: { email: `${n}.${RUN}@qa.test`, password: PASSWORD } }); secrets.push(r.body.accessToken, r.body.refreshToken); return r.body.accessToken; };
      const A = await login('alice');
      const B = await login('bob');
      await resetCounters();
      const writes = await burst(4, (i) => call(P_SA, 'PATCH', '/users/me', { token: A, body: { fullName: `Alice ${i}` } }));
      const bobWrite = await call(P_SA, 'PATCH', '/users/me', { token: B, body: { fullName: 'Bob' } });
      const aliceRead = await call(P_SA, 'GET', '/auth/me', { token: A });
      check('user_write 3/60 per verified user: Alice 3 x 200 then 429; Bob (same IP) 200; Alice\'s reads have their own budget (200)', writes.slice(0, 3).every((r) => r.status === 200) && writes[3].status === 429 && bobWrite.status === 200 && aliceRead.status === 200, { writes: writes.map((r) => r.status).join(','), bob: bobWrite.status, read: aliceRead.status });
      const spoofUser = await call(P_SA, 'PATCH', '/users/me', { token: A, body: { fullName: 'Alice x' }, headers: { 'X-User-Id': '999' } });
      check('a client-supplied X-User-Id does not escape the per-user budget (still 429)', spoofUser.status === 429, spoofUser.status);
    }
    {
      await resetCounters();
      const attempts = await burst(6, () => call(P_SA, 'POST', '/auth/login', { body: { email: `alice.${RUN}@qa.test`, password: 'wrong-password-1' } }));
      check('auth policy before bot verification: login_ip 5/300 -> 5 x 403 TURNSTILE_REQUIRED, 6th -> 429 RATE_LIMITED (not 403)', attempts.slice(0, 5).every((r) => r.status === 403 && r.body.code === 'TURNSTILE_REQUIRED') && attempts[5].status === 429 && attempts[5].body.code === 'RATE_LIMITED', attempts.map((r) => `${r.status}:${r.body?.code}`).join(','));
    }
    {
      await resetCounters();
      await db.query(`CREATE FUNCTION qa_rl_down_${RUN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa rate-limit store down'; END $$`);
      await db.query(`CREATE TRIGGER qa_rl_down_${RUN} BEFORE INSERT OR UPDATE ON auth_rate_limits FOR EACH ROW EXECUTE FUNCTION qa_rl_down_${RUN}()`);
      let down, live, ready;
      try {
        down = await call(P_SA, 'GET', PUBLIC_ROUTE);
        live = await call(P_SA, 'GET', '/health/live');
        ready = await call(P_SA, 'GET', '/health/ready');
      } finally {
        await db.query(`DROP TRIGGER qa_rl_down_${RUN} ON auth_rate_limits`);
        await db.query(`DROP FUNCTION qa_rl_down_${RUN}()`);
      }
      check('fail closed: rate-limit store failure -> 503 RATE_LIMIT_UNAVAILABLE + Retry-After 5 (not served unmetered); health probes still answer', down.status === 503 && down.body.code === 'RATE_LIMIT_UNAVAILABLE' && down.headers.get('retry-after') === '5' && live.status === 200 && ready.status === 200, { down: [down.status, down.body?.code], live: live.status, ready: ready.status });
    }

    // ------------------------------------------------------------------ 6
    section('6. Readiness during a database outage');
    {
      // Outage of THIS run's QA database only: refuse new connections and close the apps' existing ones
      // (issued from the maintenance database, since a database cannot block connections to itself).
      const admin = new Client({ ...DB, database: 'postgres' });
      await admin.connect();
      const suitePid = (await one('SELECT pg_backend_pid() pid')).pid;
      let outage, liveDuring;
      let started = Date.now();
      try {
        await admin.query(`ALTER DATABASE ${NAME} ALLOW_CONNECTIONS false`);
        await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> $2`, [NAME, suitePid]);
        started = Date.now();
        outage = await call(P_SA, 'GET', '/health/ready');
        liveDuring = await call(P_SA, 'GET', '/health/live');
      } finally {
        await admin.query(`ALTER DATABASE ${NAME} ALLOW_CONNECTIONS true`);
        await admin.end();
      }
      const elapsed = Date.now() - started;
      check('database unreachable: readiness 503 (database down/timeout) within the probe bound, liveness 200, no detail leaked', outage.status === 503 && ['down', 'timeout'].includes(outage.body.checks.database) && liveDuring.status === 200 && elapsed < 6000 && !/ECONN|password|5432|localhost/.test(JSON.stringify(outage.body)), { outage: outage.body, live: liveDuring.status, elapsed });
      let recovered = null;
      for (let i = 0; i < 30 && recovered?.status !== 200; i++) { recovered = await call(P_SA, 'GET', '/health/ready'); if (recovered.status !== 200) await sleep(300); }
      check('after recovery readiness returns to 200 without a restart', recovered.status === 200, recovered.body);
    }

    // ------------------------------------------------------------------ 7
    section('7. Logs');
    {
      await sleep(300);
      const raw = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
      const lines = raw.split('\n').filter((l) => l.trim());
      const nonJson = lines.filter((l) => { try { return typeof JSON.parse(l) !== 'object'; } catch { return true; } });
      check(`every log line (${lines.length}) is a JSON object`, nonJson.length === 0, nonJson.slice(0, 3));
      const leaked = secrets.filter((s) => raw.includes(s));
      check(`no secret in any log (${secrets.length} values: JWT/HMAC/Turnstile secrets, DB role password, passwords, tokens)`, leaked.length === 0 && !/eyJhbGciOi/.test(raw), { leaked: leaked.length });
      const rlLines = lines.filter((l) => /Rate limit exceeded/.test(l));
      check('rate-limit log lines name policies only: no client address, forwarded value or bucket', rlLines.length > 0 && !rlLines.some((l) => /203\.0\.113|198\.51\.100|2001:db8|not-an-ip|[0-9a-f]{64}/.test(l)), rlLines.slice(0, 2));
      const missingId = responses.filter((r) => !r.requestId);
      check(`every response (${responses.length}) carried X-Request-ID`, missingId.length === 0, missingId.slice(0, 3));
    }
  } finally {
    for (const app of apps) await app.stop();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') {
      await dropDatabase(NAME);
      await dropDatabase(MIG_NAME);
    }
    if (roleCreated) {
      const admin = new Client({ ...DB, database: 'postgres' });
      await admin.connect();
      await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch((e) => console.log(`role cleanup failed: ${e.code}`));
      await admin.end();
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed  (out: ${OUT_DIR})`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('QA run aborted:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
