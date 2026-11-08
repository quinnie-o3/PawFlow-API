/*
 * P3-BE03 Turnstile verification + auth rate limiting — real HTTP + real
 * PostgreSQL (disposable QA database only).
 *
 *   npm run build
 *   npm run qa:bot-protection
 *
 * Instances:
 *   A, B (QA_PORTS, default 8151,8152): TURNSTILE_MODE=enforce against a local
 *     Siteverify stub (deterministic: single-use tokens, idempotency keys,
 *     timeouts, 5xx, garbage, bad secret), rate limiting with short windows,
 *     TRUST_PROXY=loopback (each test client uses its own X-Forwarded-For).
 *   C (8153): same, but no trusted proxy (X-Forwarded-For must be ignored).
 *   D/E/F (8154-8156): the REAL Cloudflare Siteverify with the official test
 *     secrets (1x pass, 2x fail, 3x spent). Skipped if Cloudflare is unreachable.
 *
 * Environment: QA_DB_NAME, QA_PORTS, QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { randomUUID } = require('crypto');
const { DataSource } = require(require('path').join(__dirname, '..', '..', 'node_modules', 'typeorm'));
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_bot_protection';
const PORTS = (process.env.QA_PORTS ?? '8151,8152').split(',').map(Number);
const PORT_NO_PROXY = 8153;
const PORTS_CF = { pass: 8154, fail: 8155, spent: 8156 };
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-bot-'));
const OUTBOX = path.join(OUT_DIR, 'outbox');
const SECRET = 'qa-turnstile-secret-' + randomUUID();
const HOST = 'app.pawflow.test';
const PASSWORD = 'QaPassword123!';
const RUN = 'b' + Date.now().toString(36);
const NEW_MIGRATION = 'CreateAuthRateLimits1795000000000';
const LIMITS = { RATE_LIMIT_LOGIN_IP: '5/20', RATE_LIMIT_LOGIN_EMAIL: '8/20', RATE_LIMIT_REGISTER_IP: '50/60', RATE_LIMIT_FORGOT_IP: '6/20', RATE_LIMIT_FORGOT_EMAIL: '3/20', RATE_LIMIT_RESET_IP: '5/20' };

const results = [];
const evidence = {};
const seenTokens = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, skipped: false, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 500)}`);
}
function skip(name, reason) {
  results.push({ name, pass: true, skipped: true, detail: reason });
  console.log(`SKIP  ${name}  (${reason})`);
}
const section = (title) => console.log(`\n## ${title}`);
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

// ------------------------------------------------------------ Siteverify stub
// Token grammar: <kind>:<hostname>:<action>:<nonce>. Real Turnstile semantics:
// a token verifies once; a repeat with the SAME idempotency_key returns the
// first result, with another key -> timeout-or-duplicate.
function startSiteverifyStub() {
  const used = new Map();
  const stub = { requests: [], flaky: new Map(), server: null, port: 0 };
  stub.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* handled below */ }
      stub.requests.push({ at: Date.now(), secretOk: body.secret === SECRET, token: body.response, idempotencyKey: body.idempotency_key, remoteip: body.remoteip, contentType: req.headers['content-type'] });
      const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (body.secret !== SECRET) return reply(200, { success: false, 'error-codes': ['invalid-input-secret'] });
      const token = String(body.response ?? '');
      const [kind, hostname, action] = token.split(':');
      switch (kind) {
        case 'slow': // answers far too late: the backend must have timed out by then
          return void setTimeout(() => { if (!res.writableEnded && !res.destroyed) reply(200, { success: true, hostname: HOST, action: 'login' }); }, 8000).unref();
        case 'http500': return reply(500, { error: 'internal' });
        case 'garbage': res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>not json</html>');
        case 'badsecret': return reply(200, { success: false, 'error-codes': ['invalid-input-secret'] });
        case 'invalid': return reply(200, { success: false, 'error-codes': ['invalid-input-response'] });
        case 'expired': return reply(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
        case 'flaky': {
          const n = (stub.flaky.get(token) ?? 0) + 1;
          stub.flaky.set(token, n);
          if (n === 1) return reply(503, { error: 'unavailable' });
          break;
        }
        case 'ok': break;
        default: return reply(200, { success: false, 'error-codes': ['invalid-input-response'] });
      }
      const prior = used.get(token);
      if (prior && prior.key !== body.idempotency_key) return reply(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
      const result = { success: true, 'error-codes': [], challenge_ts: new Date().toISOString(), hostname, action, cdata: '' };
      used.set(token, { key: body.idempotency_key, result });
      return reply(200, result);
    });
  });
  return new Promise((resolve) => stub.server.listen(0, '127.0.0.1', () => { stub.port = stub.server.address().port; resolve(stub); }));
}

let nonce = 0;
const tok = (kind, action, hostname = HOST) => { const t = `${kind}:${hostname}:${action}:${RUN}-${++nonce}-${randomUUID()}`; seenTokens.push(t); return t; };
let ipSeq = 0;
const freshIp = () => { ipSeq++; return `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; };

async function waitForNextWindow(windowSeconds) {
  const ms = windowSeconds * 1000 - (Date.now() % (windowSeconds * 1000)) + 300;
  await sleep(ms);
}

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  fs.mkdirSync(OUTBOX, { recursive: true });
  // Everything below runs inside one try/finally, so a failure at any point
  // (including app start-up) never leaves instances, sockets or the QA database behind.
  let stub = null;
  let app = null;
  let appNoProxy = null;
  try {
  stub = await startSiteverifyStub();

  // ------------------------------------------------------------ schema + migration rehearsal
  section('0. Schema and migration rehearsal (disposable database)');
  check(`all ${migrations.length} source migrations applied (last = CreateAuthRateLimits), 0 pending DDL`, migrations.length === sourceMigrationCount() && migrations.at(-1) === NEW_MIGRATION && pendingDdl.length === 0, { migrations, pendingDdl });
  {
    const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')] });
    await ds.initialize();
    await db.query(`insert into auth_rate_limits values ('login_ip', $1, now(), 1, now() + interval '1 minute')`, ['a'.repeat(64)]);
    await ds.undoLastMigration({ transaction: 'each' });
    const gone = (await one(`select to_regclass('auth_rate_limits') t`)).t === null;
    const usersIntact = (await one(`select to_regclass('auth_user_tokens') t`)).t !== null;
    const again = await ds.runMigrations({ transaction: 'each' });
    const pending = (await ds.driver.createSchemaBuilder().log()).upQueries.length;
    await ds.destroy();
    check('down drops only auth_rate_limits (P3-BE02 schema intact); up again -> 0 pending DDL', gone && usersIntact && again.length === 1 && again[0].name === NEW_MIGRATION && pending === 0, { gone, usersIntact, again: again.map((m) => m.name), pending });
    const rejects = async (sql, params) => db.query(sql, params).then(() => false, () => true);
    check('DB rejects raw (non-HMAC) buckets, hits <= 0 and windows ending before they start', await rejects(`insert into auth_rate_limits values ('login_ip', '10.0.0.1', now(), 1, now() + interval '1 minute')`) && await rejects(`insert into auth_rate_limits values ('login_ip', $1, now(), 0, now() + interval '1 minute')`, ['b'.repeat(64)]) && await rejects(`insert into auth_rate_limits values ('login_ip', $1, now(), 1, now())`, ['c'.repeat(64)]));
  }

  const enforceEnv = {
    TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_EXPECTED_HOSTNAMES: `${HOST}, www.${HOST}`,
    TURNSTILE_SITEVERIFY_URL: `http://127.0.0.1:${stub.port}/turnstile/v0/siteverify`, TURNSTILE_TIMEOUT_MS: '1000',
    AUTH_RATE_LIMIT: 'enabled', ...LIMITS,
    MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: OUTBOX, MAIL_LINK_BASE_URL: 'http://fe.qa.test',
  };
  const jwtSecret = randomUUID() + randomUUID();
  app = createApp(NAME, PORTS, { logDir: OUT_DIR, jwtSecret, env: { ...enforceEnv, TRUST_PROXY: 'loopback' } });
  appNoProxy = createApp(NAME, [PORT_NO_PROXY], { logDir: OUT_DIR, jwtSecret, env: enforceEnv });
  await app.start();
  await appNoProxy.start();
  const rawApi = createApi(PORTS);
  const statuses = [];
  const api = async (method, url, opts = {}) => { const r = await rawApi(method, url, opts); statuses.push(r.status); return r; };
  const as = (ip) => ({ 'X-Forwarded-For': ip });
  const mail = (n) => `${n}.${RUN}@qa.test`;
  const userCount = async (email) => (await one('select count(*)::int c from users where lower(email) = lower($1)', [email])).c;
  const sessionsOf = async (email) => (await one('select count(*)::int c from auth_sessions s join users u on u.id = s.user_id where lower(u.email) = lower($1)', [email])).c;
  const register = async (n, ip = freshIp()) => {
    const r = await api('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD, turnstileToken: tok('ok', 'register') }, headers: as(ip) });
    if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body));
    return { id: r.body.user.id, ...r.body };
  };
  const login = (n, token, ip = freshIp(), port) => api('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD, ...(token === undefined ? {} : { turnstileToken: token }) }, headers: as(ip), port });
  // Functional sections (1-4) test Turnstile, not rate limiting: they clear
  // the QA counters first so their many requests for one e-mail do not hit the
  // per-e-mail limit. Section 5 tests the limits with clean windows.
  const resetCounters = () => db.query('delete from auth_rate_limits');
  const outboxToken = async (email, category) => {
    for (let i = 0; i < 100; i++) {
      const found = fs.readdirSync(OUTBOX).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8'))).filter((m) => m.to === email && m.category === category).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      if (found.length) return /#token=([A-Za-z0-9_-]{43})/.exec(found.at(-1).text)[1];
      await sleep(50);
    }
    throw new Error('no mail');
  };

  try {
    // ------------------------------------------------------------ login
    section('1. Login');
    await resetCounters();
    await register('alice');
    const before = await sessionsOf(mail('alice'));
    const okLogin = await login('alice', tok('ok', 'login'));
    check('valid challenge for action "login" -> 200 and a session', okLogin.status === 200 && (await sessionsOf(mail('alice'))) === before + 1, okLogin.status);
    const lastReq = stub.requests.at(-1);
    check('Siteverify received the server secret, the token, an idempotency key and the client IP (trusted proxy)', lastReq.secretOk && /^[0-9a-f-]{36}$/.test(lastReq.idempotencyKey) && /^10\.77\./.test(lastReq.remoteip) && /application\/json/.test(lastReq.contentType), lastReq);
    const failures = {
      missing: [undefined, 403, 'TURNSTILE_REQUIRED'],
      empty: ['', 403, 'TURNSTILE_REQUIRED'],
      invalid: [tok('invalid', 'login'), 403, 'TURNSTILE_INVALID'],
      expired: [tok('expired', 'login'), 403, 'TURNSTILE_EXPIRED'],
      'wrong hostname': [tok('ok', 'login', 'evil.example'), 403, 'TURNSTILE_INVALID'],
      'wrong action (register token)': [tok('ok', 'register'), 403, 'TURNSTILE_INVALID'],
      'unknown kind (forged)': ['forged-token-value', 403, 'TURNSTILE_INVALID'],
    };
    const loginFailures = {};
    for (const [label, [token, status, code]] of Object.entries(failures)) {
      const r = await login('alice', token);
      loginFailures[label] = r.status === status && r.body.code === code && !r.body.accessToken && Object.keys(r.body).sort().join() === 'code,error,message,statusCode';
    }
    check('missing / empty / invalid / expired / wrong-hostname / wrong-action / forged challenges -> 403 with the documented code, no Cloudflare diagnostics', Object.values(loginFailures).every(Boolean), loginFailures);
    check('none of the failed challenges created a session', (await sessionsOf(mail('alice'))) === before + 1);
    await resetCounters();
    const used = tok('ok', 'login');
    const first = await login('alice', used);
    const replay = await login('alice', used);
    check('replaying a token that already passed -> 403 TURNSTILE_EXPIRED (single use, not cached)', first.status === 200 && replay.status === 403 && replay.body.code === 'TURNSTILE_EXPIRED', [first.status, replay.body]);
    const wrongPw = await api('POST', '/auth/login', { body: { email: mail('alice'), password: 'WrongPassword1', turnstileToken: tok('ok', 'login') }, headers: as(freshIp()) });
    check('valid challenge + wrong password -> 401 (credentials still checked; the token is spent)', wrongPw.status === 401);
    const oversize = await login('alice', 'ok:' + 'x'.repeat(2050));
    const nonString = await api('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, turnstileToken: 12345 }, headers: as(freshIp()) });
    check('oversized (>2048) or non-string token -> 400 validation, Cloudflare not called', oversize.status === 400 && nonString.status === 400 && !stub.requests.some((r) => String(r.token).length > 2048));
    const bypass = await api('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, captchaBypass: true }, headers: { ...as(freshIp()), 'X-Turnstile-Bypass': '1', 'CF-Turnstile-Response': 'ok' } });
    check('client-side bypass attempts (extra field, headers) -> rejected, no session', [400, 403].includes(bypass.status) && !bypass.body.accessToken, bypass);

    // ------------------------------------------------------------ register
    section('2. Registration');
    await resetCounters();
    const regFail = {};
    for (const [label, token] of Object.entries({ missing: undefined, invalid: tok('invalid', 'register'), 'login token': tok('ok', 'login'), expired: tok('expired', 'register') })) {
      const email = mail(`reg-${label.replace(/\W/g, '')}`);
      const r = await api('POST', '/auth/register', { body: { fullName: 'QA Reg', email, password: PASSWORD, ...(token === undefined ? {} : { turnstileToken: token }) }, headers: as(freshIp()) });
      regFail[label] = { status: r.status, code: r.body.code, users: await userCount(email) };
    }
    check('failed challenges -> 403 and NO user/session/token row written', Object.values(regFail).every((v) => v.status === 403 && v.users === 0), regFail);
    const reg = await api('POST', '/auth/register', { body: { fullName: 'QA Reg', email: mail('reg-ok'), password: PASSWORD, turnstileToken: tok('ok', 'register') }, headers: as(freshIp()) });
    check('valid challenge -> 201 with exactly 1 user + 1 session (atomic registration unchanged)', reg.status === 201 && (await userCount(mail('reg-ok'))) === 1 && (await sessionsOf(mail('reg-ok'))) === 1);

    // ------------------------------------------------------------ forgot / reset
    section('3. Forgot and reset password');
    await resetCounters();
    const bob = await register('bob');
    const fExisting = await api('POST', '/auth/forgot-password', { body: { email: mail('bob'), turnstileToken: tok('invalid', 'forgot_password') }, headers: as(freshIp()) });
    const fUnknown = await api('POST', '/auth/forgot-password', { body: { email: mail('nobody'), turnstileToken: tok('invalid', 'forgot_password') }, headers: as(freshIp()) });
    check('forgot-password with a failed challenge: identical 403 for existing and unknown e-mail; no link issued', fExisting.status === 403 && JSON.stringify(fExisting.body) === JSON.stringify(fUnknown.body) && (await one(`select count(*)::int c from auth_user_tokens where user_id = $1 and purpose = 'PASSWORD_RESET'`, [bob.id])).c === 0, [fExisting.body, fUnknown.body]);
    const fOk = await api('POST', '/auth/forgot-password', { body: { email: mail('bob'), turnstileToken: tok('ok', 'forgot_password') }, headers: as(freshIp()) });
    const fOkUnknown = await api('POST', '/auth/forgot-password', { body: { email: mail('nobody2'), turnstileToken: tok('ok', 'forgot_password') }, headers: as(freshIp()) });
    check('forgot-password with a valid challenge: same generic 202 for existing and unknown e-mail', fOk.status === 202 && fOkUnknown.status === 202 && JSON.stringify(fOk.body) === JSON.stringify(fOkUnknown.body));
    const resetToken = await outboxToken(mail('bob'), 'PASSWORD_RESET');
    const hashBefore = (await one('select password_hash from users where id = $1', [bob.id])).password_hash;
    const rBad = await api('POST', '/auth/reset-password', { body: { token: resetToken, newPassword: 'NewPassword456!', turnstileToken: tok('expired', 'reset_password') }, headers: as(freshIp()) });
    const rWrongAction = await api('POST', '/auth/reset-password', { body: { token: resetToken, newPassword: 'NewPassword456!', turnstileToken: tok('ok', 'login') }, headers: as(freshIp()) });
    const tokenRow = await one(`select consumed_at, revoked_at from auth_user_tokens where user_id = $1 and purpose = 'PASSWORD_RESET'`, [bob.id]);
    check('reset with a failed challenge -> 403; reset token NOT consumed, password and sessions unchanged', rBad.status === 403 && rWrongAction.status === 403 && tokenRow.consumed_at === null && tokenRow.revoked_at === null && (await one('select password_hash from users where id = $1', [bob.id])).password_hash === hashBefore && (await one('select count(*)::int c from auth_sessions where user_id = $1 and revoked_at is null', [bob.id])).c === 1, { rBad: rBad.body, tokenRow });
    const rOk = await api('POST', '/auth/reset-password', { body: { token: resetToken, newPassword: 'NewPassword456!', turnstileToken: tok('ok', 'reset_password') }, headers: as(freshIp()) });
    const rReplay = await api('POST', '/auth/reset-password', { body: { token: resetToken, newPassword: 'Another789!', turnstileToken: tok('ok', 'reset_password') }, headers: as(freshIp()) });
    check('valid challenge -> 204 (P3-BE02 reset unchanged: sessions revoked); reset-token replay with a fresh valid challenge -> 400', rOk.status === 204 && (await one('select count(*)::int c from auth_sessions where user_id = $1 and revoked_at is null', [bob.id])).c === 0 && rReplay.status === 400);

    // ------------------------------------------------------------ provider failures
    section('4. Verification-service failures (fail closed)');
    await resetCounters();
    const reqs = () => stub.requests.length;
    let n0 = reqs();
    let t0 = Date.now();
    const slow = await login('alice', tok('slow', 'login'));
    const slowMs = Date.now() - t0;
    check('Siteverify hangs -> 503 TURNSTILE_UNAVAILABLE after 2 bounded attempts (~2 x 1 s), Retry-After: 5, no session', slow.status === 503 && slow.body.code === 'TURNSTILE_UNAVAILABLE' && slow.headers.get('retry-after') === '5' && reqs() - n0 === 2 && slowMs >= 2000 && slowMs < 5000, { status: slow.status, slowMs, attempts: reqs() - n0 });
    n0 = reqs();
    const h500 = await login('alice', tok('http500', 'login'));
    const h500keys = new Set(stub.requests.slice(n0).map((r) => r.idempotencyKey));
    check('Siteverify HTTP 500 -> one retry with the SAME idempotency key, then 503', h500.status === 503 && reqs() - n0 === 2 && h500keys.size === 1);
    n0 = reqs();
    const flaky = await login('alice', tok('flaky', 'login'));
    check('transient 503 then success -> login succeeds after one retry (same idempotency key, not reported as duplicate)', flaky.status === 200 && reqs() - n0 === 2 && new Set(stub.requests.slice(n0).map((r) => r.idempotencyKey)).size === 1, flaky.status);
    const garbage = await login('alice', tok('garbage', 'login'));
    const badSecret = await login('alice', tok('badsecret', 'login'));
    check('non-JSON response and invalid-secret response -> 503 TURNSTILE_UNAVAILABLE (never 500, never success)', garbage.status === 503 && badSecret.status === 503 && badSecret.body.code === 'TURNSTILE_UNAVAILABLE');
    const sessionsAlice = await sessionsOf(mail('alice'));
    check('provider failures created no session (only the 3 successful logins + registration exist)', sessionsAlice === 4, sessionsAlice);

    // ------------------------------------------------------------ rate limiting
    section('5. Rate limiting and HTTP 429');
    await waitForNextWindow(20);
    const ipA = freshIp();
    const burst = [];
    for (let i = 0; i < 7; i++) burst.push(await rawApi('POST', '/auth/login', { body: { email: mail(`rl${i}`), password: PASSWORD }, headers: as(ipA), port: PORTS[i % 2] }));
    const sixth = burst[5];
    const retryAfter = Number(sixth.headers.get('retry-after'));
    evidence.loginBurst = burst.map((r) => r.status);
    check('login per IP (5/20 s), alternating 2 instances: 5 allowed (403 here), 6th and 7th -> 429 (shared counter)', burst.slice(0, 5).every((r) => r.status === 403) && burst.slice(5).every((r) => r.status === 429), evidence.loginBurst);
    check('429 body = { statusCode, error, message, code: RATE_LIMITED, retryAfterSeconds } and Retry-After header = retryAfterSeconds (1..20)', sixth.body.code === 'RATE_LIMITED' && sixth.body.retryAfterSeconds === retryAfter && retryAfter >= 1 && retryAfter <= 20 && Object.keys(sixth.body).sort().join() === 'code,error,message,retryAfterSeconds,statusCode', { body: sixth.body, header: retryAfter });
    const n429 = reqs();
    await rawApi('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, turnstileToken: tok('ok', 'login') }, headers: as(ipA) });
    check('a rate-limited request never reaches Siteverify or the password check (valid token + correct password still 429, no session)', reqs() === n429 && (await sessionsOf(mail('alice'))) === sessionsAlice);
    check('another client IP is not affected', (await rawApi('POST', '/auth/login', { body: { email: mail('x'), password: PASSWORD }, headers: as(freshIp()) })).status === 403);
    await app.stop();
    await app.start();
    check('restart of both instances: the counter survives (still 429 in the same window)', (await rawApi('POST', '/auth/login', { body: { email: mail('x'), password: PASSWORD }, headers: as(ipA) })).status === 429);
    await sleep(retryAfter * 1000 + 300);
    check('after Retry-After seconds the window has expired: allowed again', (await rawApi('POST', '/auth/login', { body: { email: mail('x'), password: PASSWORD }, headers: as(ipA) })).status === 403);

    await waitForNextWindow(20);
    const ipB = freshIp();
    const concurrent = await Promise.all(Array.from({ length: 24 }, (_, i) => rawApi('POST', '/auth/login', { body: { email: mail(`c${i}`), password: PASSWORD }, headers: as(ipB), port: PORTS[i % 2] })));
    evidence.concurrentAtLimit = tally(concurrent);
    check('24 concurrent requests from one IP over 2 instances at the boundary -> exactly 5 pass, 19 x 429 (atomic upsert)', evidence.concurrentAtLimit['403'] === 5 && evidence.concurrentAtLimit['429'] === 19, evidence.concurrentAtLimit);

    await waitForNextWindow(20);
    const target = mail('alice');
    const perEmail = [];
    for (let i = 0; i < 9; i++) perEmail.push((await rawApi('POST', '/auth/login', { body: { email: target, password: PASSWORD }, headers: as(freshIp()) })).status);
    const perEmailUnknown = [];
    for (let i = 0; i < 9; i++) perEmailUnknown.push((await rawApi('POST', '/auth/login', { body: { email: mail('ghost'), password: PASSWORD }, headers: as(freshIp()) })).status);
    evidence.perEmail = { existing: perEmail, unknown: perEmailUnknown };
    check('login per e-mail (8/20 s) across different IPs: 9th -> 429; identical sequence for an existing and an unknown e-mail (no enumeration)', perEmail.slice(0, 8).every((s) => s === 403) && perEmail[8] === 429 && JSON.stringify(perEmail) === JSON.stringify(perEmailUnknown), evidence.perEmail);

    await waitForNextWindow(20);
    const fgExisting = [];
    const fgUnknown = [];
    for (let i = 0; i < 4; i++) fgExisting.push((await rawApi('POST', '/auth/forgot-password', { body: { email: mail('bob'), turnstileToken: tok('ok', 'forgot_password') }, headers: as(freshIp()) })).status);
    for (let i = 0; i < 4; i++) fgUnknown.push((await rawApi('POST', '/auth/forgot-password', { body: { email: mail('ghost2'), turnstileToken: tok('ok', 'forgot_password') }, headers: as(freshIp()) })).status);
    evidence.forgotPerEmail = { existing: fgExisting, unknown: fgUnknown };
    check('forgot-password per e-mail (3/20 s): 202,202,202,429 for BOTH an existing and an unknown address', JSON.stringify(fgExisting) === '[202,202,202,429]' && JSON.stringify(fgUnknown) === '[202,202,202,429]', evidence.forgotPerEmail);

    const ipR = freshIp();
    const resetBurst = [];
    for (let i = 0; i < 6; i++) resetBurst.push((await rawApi('POST', '/auth/reset-password', { body: { token: 'Q'.repeat(43), newPassword: 'Password123!' }, headers: as(ipR) })).status);
    check('reset-password per IP (5/20 s): 6th -> 429', resetBurst.slice(0, 5).every((s) => s === 403) && resetBurst[5] === 429, resetBurst);

    // X-Forwarded-For is honoured only from trusted proxies.
    await waitForNextWindow(20);
    const spoof = [];
    for (let i = 0; i < 7; i++) spoof.push((await rawApi('POST', '/auth/login', { body: { email: mail(`sp${i}`), password: PASSWORD }, headers: as(`198.51.100.${i + 1}`), port: PORT_NO_PROXY })).status);
    evidence.spoofedXffWithoutTrustedProxy = spoof;
    check('instance without TRUST_PROXY: rotating X-Forwarded-For does not reset the limit (6th -> 429)', spoof.slice(0, 5).every((s) => s === 403) && spoof[5] === 429 && spoof[6] === 429, spoof);
    const rlRows = await db.query('select policy, bucket from auth_rate_limits');
    check('auth_rate_limits holds only HMAC buckets (no raw IP or e-mail)', rlRows.rows.length > 0 && rlRows.rows.every((r) => /^[0-9a-f]{64}$/.test(r.bucket)) && !rlRows.rows.some((r) => /10\.77|198\.51|@/.test(r.bucket)), rlRows.rows.length);

    // ------------------------------------------------------------ official Cloudflare test keys
    section('6. Real Cloudflare Siteverify with the official test secrets (protocol check)');
    let reachable = false;
    try {
      const probe = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: '1x0000000000000000000000000000000AA', response: 'XXXX.DUMMY.TOKEN.XXXX' }), signal: AbortSignal.timeout(5000) });
      reachable = probe.ok;
    } catch { reachable = false; }
    if (!reachable) {
      skip('official test keys against challenges.cloudflare.com', 'Cloudflare unreachable from this machine');
    } else {
      const cfEnv = (secret) => ({ TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: secret, TURNSTILE_EXPECTED_HOSTNAMES: 'example.com', TURNSTILE_CHECK_ACTION: 'false', AUTH_RATE_LIMIT: 'disabled' });
      const cf = {
        pass: createApp(NAME, [PORTS_CF.pass], { logDir: OUT_DIR, env: cfEnv('1x0000000000000000000000000000000AA') }),
        fail: createApp(NAME, [PORTS_CF.fail], { logDir: OUT_DIR, env: cfEnv('2x0000000000000000000000000000000AA') }),
        spent: createApp(NAME, [PORTS_CF.spent], { logDir: OUT_DIR, env: cfEnv('3x0000000000000000000000000000000AA') }),
      };
      await Promise.all(Object.values(cf).map((a) => a.start()));
      try {
        const dummy = 'XXXX.DUMMY.TOKEN.XXXX';
        const p = await rawApi('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, turnstileToken: dummy }, port: PORTS_CF.pass });
        const f = await rawApi('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, turnstileToken: dummy }, port: PORTS_CF.fail });
        const s = await rawApi('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, turnstileToken: dummy }, port: PORTS_CF.spent });
        const m = await rawApi('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD }, port: PORTS_CF.pass });
        evidence.officialTestKeys = { alwaysPass: p.status, alwaysFail: [f.status, f.body.code], spent: [s.status, s.body.code], missingToken: [m.status, m.body.code] };
        check('official keys: 1x (pass) -> 200; 2x (fail) -> 403 TURNSTILE_INVALID; 3x (spent) -> 403 TURNSTILE_EXPIRED; no token -> 403 TURNSTILE_REQUIRED', p.status === 200 && f.status === 403 && f.body.code === 'TURNSTILE_INVALID' && s.status === 403 && s.body.code === 'TURNSTILE_EXPIRED' && m.status === 403 && m.body.code === 'TURNSTILE_REQUIRED', evidence.officialTestKeys);
        const wrongHost = createApp(NAME, [PORTS_CF.pass], { logDir: OUT_DIR, env: { ...cfEnv('1x0000000000000000000000000000000AA'), TURNSTILE_EXPECTED_HOSTNAMES: HOST } });
        await cf.pass.stop();
        await wrongHost.start();
        const wh = await rawApi('POST', '/auth/login', { body: { email: mail('alice'), password: PASSWORD, turnstileToken: dummy }, port: PORTS_CF.pass });
        await wrongHost.stop();
        check('official 1x key, but the response hostname (example.com) is not in the allowlist -> 403 TURNSTILE_INVALID', wh.status === 403 && wh.body.code === 'TURNSTILE_INVALID', wh.body);
      } finally {
        await Promise.all(Object.values(cf).map((a) => a.stop()));
      }
    }

    // ------------------------------------------------------------ invariants, logs
    section('7. Invariants and log safety');
    const inv = await one(`select
      (select count(*)::int from auth_sessions s join users u on u.id = s.user_id where u.status <> 'ACTIVE' and s.revoked_at is null) live_sessions_inactive,
      (select count(*)::int from (select session_id from auth_refresh_tokens where used_at is null group by 1 having count(*) > 1) x) multiple_unused_tokens,
      (select count(*)::int from users u where u.email like '%.${RUN}@qa.test' and not exists (select 1 from auth_sessions s where s.user_id = u.id)) orphan_registrations,
      (select deadlocks::int from pg_stat_database where datname = current_database()) deadlocks`);
    evidence.invariants = inv;
    check('no orphan registrations, consistent sessions/refresh tokens, 0 deadlocks', Object.values(inv).every((v) => v === 0), inv);
    evidence.statusCounts = tally(statuses.map((status) => ({ status })));
    check('no HTTP 500 in any response', !statuses.includes(500));
    const logs = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(`app-${NAME}-`)).map((f) => fs.readFileSync(path.join(OUT_DIR, f), 'utf8')).join('\n');
    const leakedTokens = seenTokens.filter((t) => t.length > 10 && logs.includes(t)).length;
    check(`logs contain no challenge token (${seenTokens.length} checked), no Turnstile secret, no password`, leakedTokens === 0 && !logs.includes(SECRET) && !logs.includes(PASSWORD) && !logs.includes('XXXX.DUMMY.TOKEN.XXXX'), { leakedTokens });
    check('logs show the enforcement state, rejections by code and rate-limit policy names', /Turnstile enforcement ON/.test(logs) && /Turnstile rejected login: TURNSTILE_EXPIRED/.test(logs) && /Rate limit exceeded \(login: login_ip\)/.test(logs) && /Trust proxy: \["loopback"\]/.test(logs) && /Trust proxy: off/.test(logs));
  } finally {
    // inner block: nothing to release here; see the outer finally
  }
  } finally {
    if (app) await app.stop();
    if (appNoProxy) await appNoProxy.stop();
    if (stub) {
      stub.server.closeAllConnections(); // aborted "slow" requests may still hold sockets
      await new Promise((resolve) => stub.server.close(resolve));
    }
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }
}

main()
  .catch((error) => check('harness completed without errors', false, error.stack))
  .finally(() => {
    const failed = results.filter((r) => !r.pass).length;
    const skipped = results.filter((r) => r.skipped).length;
    fs.writeFileSync(path.join(OUT_DIR, 'bot-protection-results.json'), JSON.stringify({ results, evidence }, null, 2));
    console.log('\nEVIDENCE', JSON.stringify(evidence));
    console.log(`OUT_DIR ${OUT_DIR}`);
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed - skipped}  FAIL ${failed}  SKIPPED ${skipped}`);
    process.exitCode = failed ? 1 : 0;
    // Safety net: never hang after the result has been printed.
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  });
