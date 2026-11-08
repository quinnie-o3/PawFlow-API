/*
 * P3-BE02 password change, password reset and e-mail verification —
 * real HTTP + real PostgreSQL (disposable QA databases only).
 *
 *   npm run build
 *   npm run qa:account-recovery
 *
 * 1. Migration rehearsal on `pawflow_qa_account_recovery_mig`: P3-BE01 schema
 *    with legacy users/sessions -> up -> down -> up.
 * 2. Recreates `pawflow_qa_account_recovery` (QA_DB_NAME) with every source
 *    migration, starts two API instances with MAIL_TRANSPORT=file (the
 *    deterministic fake transport: e-mails are JSON files in an outbox) and
 *    verifies change/forgot/reset/verify/resend, enumeration safety, races,
 *    failure injection (PostgreSQL triggers), redaction and invariants.
 *
 * No real e-mail is sent. Environment: QA_DB_NAME, QA_PORTS (default
 * 8121,8122), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_HOST/PORT/USERNAME/PASSWORD.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { createHash } = require('crypto');
const { ROOT, DB, Client, sleep, prepareDatabase, dropDatabase, createApp, createApi, assertQaDatabaseName } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_account_recovery';
const MIG_NAME = `${NAME}_mig`;
const PORTS = (process.env.QA_PORTS ?? '8121,8122').split(',').map(Number);
const SMTP_APP_PORT = Number(process.env.QA_SMTP_APP_PORT ?? 8123);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-recovery-'));
const OUTBOX = path.join(OUT_DIR, 'outbox');
const PASSWORD = 'QaPassword123!';
const NEW_PASSWORD = 'QaNewPassword456!';
const RUN = 'r' + Date.now().toString(36);
const NEW_MIGRATION = 'AddAccountRecovery1794690000000';

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 500)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ------------------------------------------------------------ outbox (fake transport)
function outbox() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8'))).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}
const mails = (to, category) => outbox().filter((m) => m.to === to && m.category === category);
async function waitMail(to, category, count) {
  for (let i = 0; i < 200; i++) {
    const found = mails(to, category);
    if (found.length >= count) return found[count - 1];
    await sleep(50);
  }
  throw new Error(`no ${category} mail #${count} for ${to}`);
}
const tokenOf = (mail) => /#token=([A-Za-z0-9_-]{43})/.exec(mail.text)[1];

// ------------------------------------------------------------ local SMTP protocol stub
// Speaks just enough SMTP for nodemailer (EHLO/MAIL/RCPT/DATA/QUIT, no TLS,
// no auth). It exercises MAIL_TRANSPORT=smtp end to end; it is NOT a real
// delivery test. mode: 'accept' (250), 'reject' (554 after DATA), 'hang'
// (never answers the end of DATA).
function startSmtpStub() {
  const stub = { mode: 'accept', messages: [], port: 0, server: null };
  stub.server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let inData = false;
    let buf = '';
    let body = '';
    sock.on('error', () => undefined);
    sock.write('220 pawflow-qa-stub ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line !== '.') { body += (line.startsWith('..') ? line.slice(1) : line) + '\n'; continue; }
          inData = false;
          if (stub.mode === 'hang') return;
          if (stub.mode === 'reject') { sock.write('554 5.7.1 QA stub rejects this message\r\n'); body = ''; continue; }
          stub.messages.push(body);
          body = '';
          sock.write('250 2.0.0 queued\r\n');
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-pawflow-qa-stub\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        else if (['MAIL', 'RCPT', 'RSET', 'NOOP'].includes(cmd)) sock.write('250 OK\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 end with .\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 not implemented\r\n');
      }
    });
  });
  return new Promise((resolve) => stub.server.listen(0, '127.0.0.1', () => { stub.port = stub.server.address().port; resolve(stub); }));
}
/** Decodes a raw MIME message enough to find headers and the link (quoted-printable or base64 parts). */
function decodeMime(raw) {
  const qp = raw.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const b64 = (raw.match(/^[A-Za-z0-9+/=]{20,}$/gm) ?? []).map((l) => Buffer.from(l, 'base64').toString('utf8')).join('');
  return qp + '\n' + b64;
}
const linkToken = (raw) => /#token=([A-Za-z0-9_-]{43})/.exec(raw)?.[1];

// ------------------------------------------------------------ migration rehearsal
async function migrationRehearsal() {
  section('0. Migration rehearsal (P3-BE01 schema with data -> up -> down -> up)');
  assertQaDatabaseName(MIG_NAME);
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${MIG_NAME}`);
  await admin.query(`CREATE DATABASE ${MIG_NAME}`);
  await admin.end();
  const migrationsDir = path.join(ROOT, 'dist', 'database', 'migrations');
  const all = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.js')).sort();
  const dataSource = (files) => new DataSource({
    type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: MIG_NAME,
    synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')],
    migrations: files.map((f) => path.join(migrationsDir, f)),
  });
  const db = new Client({ ...DB, database: MIG_NAME });
  await db.connect();
  try {
    check('rehearsal connects to the disposable database only', (await db.query('select current_database() d')).rows[0].d === MIG_NAME);
    const before = dataSource(all.filter((f) => !f.startsWith('1794690000000')));
    await before.initialize();
    const p1 = await before.runMigrations({ transaction: 'each' });
    await before.destroy();
    check('P3-BE01 state: 10 migrations applied', p1.length === 10, p1.map((m) => m.name));

    // Legacy data written before P3-BE02 exists.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const legacy = (await db.query(`insert into users(full_name, email, password_hash, role, status) values
      ('Legacy A', 'legacy.a@qa.test', $1, 'CUSTOMER', 'ACTIVE'), ('Legacy B', 'legacy.b@qa.test', $1, 'PROVIDER_OWNER', 'SUSPENDED') returning id`, [hash])).rows.map((r) => r.id);
    await db.query(`insert into auth_sessions(id, user_id, expires_at) values ('11111111-1111-4111-8111-111111111111', $1, now() + interval '1 day')`, [legacy[0]]);
    await db.query(`insert into auth_sessions(id, user_id, expires_at, revoked_at, revoked_reason) values ('22222222-2222-4222-8222-222222222222', $1, now() + interval '1 day', now(), 'LOGOUT')`, [legacy[0]]);
    const snapshot = async () => (await db.query(`select (select json_agg(u order by id) from (select id, email, password_hash, role, status, created_at from users) u) users,
      (select json_agg(s order by id) from (select id, user_id, expires_at, revoked_at, revoked_reason from auth_sessions) s) sessions`)).rows[0];
    const beforeData = await snapshot();

    const full = dataSource(all);
    await full.initialize();
    const up = await full.runMigrations({ transaction: 'each' });
    const pending = (await full.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
    check('up: only AddAccountRecovery runs; entities match the schema (0 pending DDL)', up.length === 1 && up[0].name === NEW_MIGRATION && pending.length === 0, { up: up.map((m) => m.name), pending });
    check('up: existing users, passwords, statuses and sessions are unchanged', JSON.stringify(await snapshot()) === JSON.stringify(beforeData));
    const legacyState = (await db.query('select count(*)::int c, count(email_verified_at)::int verified from users')).rows[0];
    check('up: existing users are NOT backfilled (email_verified_at NULL) and no session was revoked', legacyState.c === 2 && legacyState.verified === 0 && (await db.query(`select count(*)::int c from auth_sessions where revoked_at is null`)).rows[0].c === 1, legacyState);
    const idx = (await db.query(`select indexdef from pg_indexes where indexname = 'uq_auth_user_tokens_active'`)).rows[0]?.indexdef ?? '';
    check('up: partial unique index (user_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL', /UNIQUE/.test(idx) && /user_id, purpose/.test(idx) && /consumed_at IS NULL/.test(idx) && /revoked_at IS NULL/.test(idx), idx);

    // Data written by P3-BE02 before a rollback.
    await db.query(`update auth_sessions set revoked_at = now(), revoked_reason = 'PASSWORD_RESET' where id = '11111111-1111-4111-8111-111111111111'`);
    await db.query(`update users set email_verified_at = now() where id = $1`, [legacy[0]]);
    await db.query(`insert into auth_user_tokens(user_id, purpose, token_hash, expires_at) values ($1, 'PASSWORD_RESET', $2, now() + interval '30 minutes')`, [legacy[0], sha256('x')]);
    await full.undoLastMigration({ transaction: 'each' });
    const afterDown = (await db.query(`select
      (select count(*)::int from information_schema.tables where table_name = 'auth_user_tokens') token_table,
      (select count(*)::int from information_schema.columns where table_name = 'users' and column_name = 'email_verified_at') verified_column,
      (select revoked_reason from auth_sessions where id = '11111111-1111-4111-8111-111111111111') mapped_reason,
      (select count(*)::int from users) users`)).rows[0];
    check('down: drops token table and column, maps PASSWORD_* revoke reasons to LOGOUT_ALL, keeps users', afterDown.token_table === 0 && afterDown.verified_column === 0 && afterDown.mapped_reason === 'LOGOUT_ALL' && afterDown.users === 2, afterDown);
    const oldCheck = await db.query(`update auth_sessions set revoked_reason = 'PASSWORD_CHANGED' where id = '22222222-2222-4222-8222-222222222222'`).then(() => 'accepted', (e) => e.message);
    check('down: the P3-BE01 revoke-reason CHECK is restored (PASSWORD_CHANGED rejected)', /chk_auth_sessions_revoked_reason/.test(oldCheck), oldCheck);
    const again = await full.runMigrations({ transaction: 'each' });
    const pendingAgain = (await full.driver.createSchemaBuilder().log()).upQueries.length;
    await full.destroy();
    check('up again after down: succeeds with 0 pending DDL', again.length === 1 && pendingAgain === 0, { again: again.map((m) => m.name), pendingAgain });
  } finally {
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(MIG_NAME);
  }
}

async function main() {
  await migrationRehearsal();

  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  fs.mkdirSync(OUTBOX, { recursive: true });
  Object.assign(process.env, { MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: OUTBOX, MAIL_FROM: 'PawFlow QA <qa@pawflow.test>', MAIL_LINK_BASE_URL: 'http://fe.qa.test' });
  const app = createApp(NAME, PORTS, { logDir: OUT_DIR });
  await app.start();
  const api = createApi(PORTS);
  const mail = (n) => `${n}.${RUN}@qa.test`;

  const register = async (n) => {
    const r = await api('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD } });
    if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body));
    return { name: n, email: mail(n), id: r.body.user.id, ...r.body };
  };
  const login = (n, password = PASSWORD, port) => api('POST', '/auth/login', { body: { email: mail(n), password }, port });
  const refresh = (token, port) => api('POST', '/auth/refresh', { body: { refreshToken: token }, port });
  const me = (access, port) => api('GET', '/auth/me', { token: access, port });
  const change = (access, currentPassword, newPassword, port) => api('POST', '/auth/change-password', { token: access, body: { currentPassword, newPassword }, port });
  const forgot = (email, port) => api('POST', '/auth/forgot-password', { body: { email }, port });
  const reset = (token, newPassword, port) => api('POST', '/auth/reset-password', { body: { token, newPassword }, port });
  const verify = (token, port) => api('POST', '/auth/verify-email', { body: { token }, port });
  const resend = (access, port) => api('POST', '/auth/verify-email/resend', { token: access, port });
  const liveSessions = async (userId) => (await one('select count(*)::int c from auth_sessions where user_id = $1 and revoked_at is null', [userId])).c;
  const passwordHash = async (userId) => (await one('select password_hash from users where id = $1', [userId])).password_hash;
  const tokenRow = async (raw) => one('select purpose, consumed_at, revoked_at, expires_at from auth_user_tokens where token_hash = $1', [sha256(raw)]);
  const resetTokenFor = async (n) => {
    const count = mails(mail(n), 'PASSWORD_RESET').length;
    const r = await forgot(mail(n));
    if (r.status !== 202) throw new Error('forgot ' + JSON.stringify(r));
    return tokenOf(await waitMail(mail(n), 'PASSWORD_RESET', count + 1));
  };
  const skipCooldown = (userId) => db.query(`update auth_user_tokens set created_at = created_at - interval '2 minutes' where user_id = $1 and consumed_at is null and revoked_at is null`, [userId]);
  const seenTokens = [];

  try {
    // ------------------------------------------------------------ schema
    section('1. Schema on a fresh QA database');
    check('all 11 source migrations applied, last = AddAccountRecovery, 0 pending DDL', migrations.length === 11 && migrations.at(-1) === NEW_MIGRATION && pendingDdl.length === 0, { migrations, pendingDdl });
    const cons = (await db.query(`select conname from pg_constraint where conrelid = 'auth_user_tokens'::regclass order by 1`)).rows.map((r) => r.conname);
    check('auth_user_tokens constraints: PK, FK -> users CASCADE, unique hash, purpose/hash/expiry/final-state CHECKs', ['chk_auth_user_tokens_expiry', 'chk_auth_user_tokens_final_state', 'chk_auth_user_tokens_hash', 'chk_auth_user_tokens_purpose', 'fk_auth_user_tokens_user', 'uq_auth_user_tokens_hash'].every((c) => cons.includes(c)), cons);
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
    // An account created "before P3-BE02": plain INSERT, email_verified_at NULL.
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Legacy', $1, $2, 'CUSTOMER', 'ACTIVE')`, [mail('legacy'), await bcrypt.hash(PASSWORD, 10)]);
    const admin = (await login('admin')).body;
    const dbRejects = async (sql, params) => db.query(sql, params).then(() => false, () => true);
    const anyUser = (await one(`select id from users where email = $1`, [mail('legacy')])).id;
    check('DB rejects a raw (non-hex) token, an unknown purpose, expiry <= creation, consumed+revoked', await dbRejects(`insert into auth_user_tokens(user_id, purpose, token_hash, expires_at) values ($1, 'PASSWORD_RESET', 'plain-token', now() + interval '1 hour')`, [anyUser])
      && await dbRejects(`insert into auth_user_tokens(user_id, purpose, token_hash, expires_at) values ($1, 'LOGIN', $2, now() + interval '1 hour')`, [anyUser, sha256('a')])
      && await dbRejects(`insert into auth_user_tokens(user_id, purpose, token_hash, created_at, expires_at) values ($1, 'PASSWORD_RESET', $2, now(), now())`, [anyUser, sha256('b')])
      && await dbRejects(`insert into auth_user_tokens(user_id, purpose, token_hash, expires_at, consumed_at, revoked_at) values ($1, 'PASSWORD_RESET', $2, now() + interval '1 hour', now(), now())`, [anyUser, sha256('c')]));
    await db.query(`insert into auth_user_tokens(user_id, purpose, token_hash, expires_at) values ($1, 'PASSWORD_RESET', $2, now() + interval '1 hour')`, [anyUser, sha256('d')]);
    check('DB rejects a second usable token of the same purpose for a user (partial unique index)', await dbRejects(`insert into auth_user_tokens(user_id, purpose, token_hash, expires_at) values ($1, 'PASSWORD_RESET', $2, now() + interval '1 hour')`, [anyUser, sha256('e')]));
    await db.query(`delete from auth_user_tokens where user_id = $1`, [anyUser]);

    // ------------------------------------------------------------ existing accounts
    section('2. Accounts created before P3-BE02');
    const legacyLogin = await login('legacy');
    const legacyMe = await me(legacyLogin.body.accessToken);
    check('legacy (unverified) account logs in normally; /auth/me reports emailVerified=false', legacyLogin.status === 200 && legacyLogin.body.user.emailVerified === false && legacyMe.status === 200 && legacyMe.body.user.emailVerified === false && legacyMe.body.user.emailVerifiedAt === null && !('sessionId' in legacyMe.body.user), legacyMe.body);
    check('legacy account can use protected endpoints (no verification guard): GET /users/me, GET /bookings/mine', (await api('GET', '/users/me', { token: legacyLogin.body.accessToken })).status === 200 && (await api('GET', '/bookings/mine', { token: legacyLogin.body.accessToken })).status === 200);
    const legacyResend = await resend(legacyLogin.body.accessToken);
    const legacyMail = await waitMail(mail('legacy'), 'EMAIL_VERIFICATION', 1);
    const legacyVerify = await verify(tokenOf(legacyMail));
    seenTokens.push(tokenOf(legacyMail));
    check('legacy account can opt in: resend -> 202, verify -> 200, /auth/me -> emailVerified=true', legacyResend.status === 202 && legacyVerify.status === 200 && (await me(legacyLogin.body.accessToken)).body.user.emailVerified === true, { legacyResend, legacyVerify });

    // ------------------------------------------------------------ change password
    section('3. Change password');
    const A = await register('alice');
    const A2 = (await login('alice')).body;
    const B = await register('bob');
    check('change-password without a token -> 401', (await api('POST', '/auth/change-password', { body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status === 401);
    const wrong = await change(A.accessToken, 'WrongPassword1', NEW_PASSWORD);
    check('incorrect current password -> 400 "Current password is incorrect", sessions intact', wrong.status === 400 && wrong.body.message === 'Current password is incorrect' && (await liveSessions(A.id)) === 2, wrong.body);
    const same = await change(A.accessToken, PASSWORD, PASSWORD);
    check('reusing the current password -> 400', same.status === 400 && /different/.test(same.body.message), same.body);
    const weak = await change(A.accessToken, PASSWORD, 'short');
    const extra = await api('POST', '/auth/change-password', { token: A.accessToken, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: B.id } });
    check('invalid new password -> 400; extra field (e.g. userId) -> 400', weak.status === 400 && extra.status === 400, { weak: weak.body, extra: extra.body });
    const hashBefore = await passwordHash(A.id);
    const okChange = await change(A.accessToken, PASSWORD, NEW_PASSWORD);
    check('correct current password -> 204', okChange.status === 204, okChange);
    check('all alice sessions revoked with PASSWORD_CHANGED (including the current one)', (await liveSessions(A.id)) === 0 && (await one(`select count(*)::int c from auth_sessions where user_id = $1 and revoked_reason = 'PASSWORD_CHANGED'`, [A.id])).c === 2);
    check('old access tokens -> 401 immediately; old refresh tokens -> 401', (await me(A.accessToken)).status === 401 && (await me(A2.accessToken)).status === 401 && (await refresh(A.refreshToken)).status === 401 && (await refresh(A2.refreshToken)).status === 401);
    const newHash = await passwordHash(A.id);
    check('stored hash replaced by a bcrypt hash of the new password (no plaintext)', newHash !== hashBefore && newHash.startsWith('$2') && (await bcrypt.compare(NEW_PASSWORD, newHash)) && !newHash.includes(NEW_PASSWORD));
    check('old password -> 401; new password -> 200', (await login('alice')).status === 401 && (await login('alice', NEW_PASSWORD)).status === 200);
    check("bob's session and password are untouched (cross-account isolation)", (await me(B.accessToken)).status === 200 && (await login('bob')).status === 200);
    const C = await register('carol');
    await api('PATCH', `/admin/users/${C.id}/suspend`, { token: admin.accessToken });
    check('suspended account: change-password -> 401 (session already revoked), password unchanged', (await change(C.accessToken, PASSWORD, NEW_PASSWORD)).status === 401 && (await bcrypt.compare(PASSWORD, await passwordHash(C.id))));

    // ------------------------------------------------------------ forgot password
    section('4. Forgot password (enumeration safety)');
    const D = await register('dave');
    const variants = [
      ['active account', mail('dave')],
      ['active account, other case + spaces', `  ${mail('dave').toUpperCase()} `],
      ['unknown address', mail('nobody')],
      ['suspended account', mail('carol')],
    ];
    const responses = [];
    for (const [label, email] of variants) responses.push([label, await forgot(email)]);
    const signature = (r) => JSON.stringify({ status: r.status, body: r.body, type: r.headers.get('content-type') });
    check('identical status, body and content-type for active / unknown / suspended addresses', responses.every(([, r]) => r.status === 202 && signature(r) === signature(responses[0][1])), responses.map(([l, r]) => [l, r.status, r.body]));
    check('response never contains a token, a hash or account data', responses.every(([, r]) => Object.keys(r.body).join() === 'message'));
    // Checked before waiting for any e-mail: the token is committed before the 202.
    const committedAtResponse = (await one(`select count(*)::int c from auth_user_tokens where user_id = $1 and purpose = 'PASSWORD_RESET' and consumed_at is null and revoked_at is null`, [D.id])).c;
    check('durable acceptance: the reset token is already committed when the 202 is returned', committedAtResponse === 1, committedAtResponse);
    const daveMail = await waitMail(mail('dave'), 'PASSWORD_RESET', 1);
    await sleep(500);
    check('exactly one reset e-mail (to the stored address); none for unknown or suspended addresses (cooldown absorbed the repeat)', mails(mail('dave'), 'PASSWORD_RESET').length === 1 && mails(mail('carol'), 'PASSWORD_RESET').length === 0 && outbox().every((m) => m.to !== mail('nobody')) && daveMail.from === 'PawFlow QA <qa@pawflow.test>');
    const daveToken = tokenOf(daveMail);
    seenTokens.push(daveToken);
    const daveRow = await tokenRow(daveToken);
    const ttlMinutes = (await one(`select extract(epoch from expires_at - created_at)::int / 60 m from auth_user_tokens where token_hash = $1`, [sha256(daveToken)])).m;
    check('link = FRONTEND_URL/reset-password#token=<43 chars>; only its SHA-256 is stored; 30-minute lifetime', daveMail.text.includes(`http://fe.qa.test/reset-password#token=${daveToken}`) && daveRow?.purpose === 'PASSWORD_RESET' && ttlMinutes === 30 && (await one(`select count(*)::int c from auth_user_tokens where token_hash = $1`, [daveToken])).c === 0, { ttlMinutes });
    await skipCooldown(D.id);
    await forgot(mail('dave'));
    const daveMail2 = await waitMail(mail('dave'), 'PASSWORD_RESET', 2);
    const daveToken2 = tokenOf(daveMail2);
    seenTokens.push(daveToken2);
    check('a new request after the cooldown supersedes the previous link (old revoked, new usable)', (await tokenRow(daveToken)).revoked_at !== null && (await tokenRow(daveToken2)).revoked_at === null);
    check('malformed e-mail -> 400 (validation only)', (await forgot('not-an-email')).status === 400 && (await api('POST', '/auth/forgot-password', { body: {} })).status === 400);

    // Timing: an eligible address commits a token in the request; every
    // response is padded to AUTH_RECOVERY_MIN_RESPONSE_MS (default 250 ms).
    // Each 'existing' sample is a fresh account, so it really issues a token.
    for (let i = 0; i < 16; i++) await register(`timing${i}`);
    const timings = { existing: [], unknown: [] };
    for (let i = 0; i < 16; i++) {
      for (const [kind, email] of [['existing', mail(`timing${i}`)], ['unknown', `ghost${i}.${RUN}@qa.test`]]) {
        const t = process.hrtime.bigint();
        await forgot(email, PORTS[0]);
        timings[kind].push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
    evidence.forgotTimingMs = { existingMedian: +median(timings.existing).toFixed(2), unknownMedian: +median(timings.unknown).toFixed(2), min: +Math.min(...timings.existing, ...timings.unknown).toFixed(2) };
    check('every forgot-password response takes >= the 250 ms floor', evidence.forgotTimingMs.min >= 245, evidence.forgotTimingMs);
    check('no timing oracle: median latency existing (token committed) vs unknown differs by < 15 ms', Math.abs(evidence.forgotTimingMs.existingMedian - evidence.forgotTimingMs.unknownMedian) < 15, evidence.forgotTimingMs);
    check('each timed eligible request committed its token (16 accounts)', (await one(`select count(distinct t.user_id)::int c from auth_user_tokens t join users u on u.id = t.user_id where u.email like 'timing%' and t.purpose = 'PASSWORD_RESET'`)).c === 16);

    // ------------------------------------------------------------ reset password
    section('5. Reset password');
    const D1 = (await login('dave')).body;
    const D2 = (await login('dave')).body;
    check('reset with the superseded first link -> 400', (await reset(daveToken, NEW_PASSWORD)).status === 400);
    const malformed = await reset('short', NEW_PASSWORD);
    const weakReset = await reset(daveToken2, 'short');
    check('malformed token -> 400; weak new password -> 400 (token not consumed)', malformed.status === 400 && weakReset.status === 400 && (await tokenRow(daveToken2)).consumed_at === null);
    const okReset = await reset(daveToken2, NEW_PASSWORD);
    check('valid token -> 204 with an empty body (no auto-login)', okReset.status === 204 && okReset.body === null && (await liveSessions(D.id)) === 0, okReset);
    check('all sessions revoked with PASSWORD_RESET; old tokens -> 401', (await one(`select count(*)::int c from auth_sessions where user_id = $1 and revoked_reason = 'PASSWORD_RESET'`, [D.id])).c === 3 && (await me(D1.accessToken)).status === 401 && (await refresh(D2.refreshToken)).status === 401);
    check('token consumed exactly once; e-mail marked verified by the reset', (await tokenRow(daveToken2)).consumed_at !== null && (await one('select email_verified_at from users where id = $1', [D.id])).email_verified_at !== null);
    check('old password -> 401; new password -> 200', (await login('dave')).status === 401 && (await login('dave', NEW_PASSWORD)).status === 200);
    const replay = await reset(daveToken2, 'AnotherPassword789');
    check('replay of the consumed token -> 400 and the password stays the reset one', replay.status === 400 && replay.body.message === 'Invalid or expired password reset token' && (await login('dave', NEW_PASSWORD)).status === 200, replay.body);
    const E = await register('erin');
    const erinToken = await resetTokenFor('erin');
    seenTokens.push(erinToken);
    await db.query(`update auth_user_tokens set created_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' where token_hash = $1`, [sha256(erinToken)]);
    check('expired token -> 400 with the same message; password unchanged', ((r) => r.status === 400 && r.body.message === 'Invalid or expired password reset token')(await reset(erinToken, NEW_PASSWORD)) && (await login('erin')).status === 200);
    await skipCooldown(E.id);
    const erinToken2 = await resetTokenFor('erin');
    seenTokens.push(erinToken2);
    await api('PATCH', `/admin/users/${E.id}/suspend`, { token: admin.accessToken });
    check('account suspended after the link was issued -> 400, token not consumed, password unchanged', (await reset(erinToken2, NEW_PASSWORD)).status === 400 && (await tokenRow(erinToken2)).consumed_at === null && (await bcrypt.compare(PASSWORD, await passwordHash(E.id))));
    check('unknown well-formed token -> 400 (same message)', ((r) => r.status === 400 && r.body.message === 'Invalid or expired password reset token')(await reset('Q'.repeat(43), NEW_PASSWORD)));

    // ------------------------------------------------------------ verification
    section('6. E-mail verification lifecycle');
    const F = await register('frank');
    check('registration response: user.emailVerified=false (additive field)', F.user.emailVerified === false && F.user.emailVerifiedAt === null);
    const frankMail = await waitMail(mail('frank'), 'EMAIL_VERIFICATION', 1);
    const frankToken = tokenOf(frankMail);
    seenTokens.push(frankToken);
    check('verification e-mail sent after registration; link = /verify-email#token=…; 24-hour lifetime; hash only', frankMail.text.includes(`http://fe.qa.test/verify-email#token=${frankToken}`) && (await one(`select extract(epoch from expires_at - created_at)::int / 3600 h from auth_user_tokens where token_hash = $1`, [sha256(frankToken)])).h === 24);
    const tooSoon = await resend(F.accessToken);
    check('resend within the cooldown -> 429 with retryAfterSeconds', tooSoon.status === 429 && tooSoon.body.retryAfterSeconds > 0 && tooSoon.body.retryAfterSeconds <= 60, tooSoon.body);
    await skipCooldown(F.id);
    const resent = await resend(F.accessToken);
    const frankToken2 = tokenOf(await waitMail(mail('frank'), 'EMAIL_VERIFICATION', 2));
    seenTokens.push(frankToken2);
    check('resend -> 202 { message, expiresAt }; the previous link is revoked', resent.status === 202 && Object.keys(resent.body).sort().join() === 'expiresAt,message' && (await tokenRow(frankToken)).revoked_at !== null, resent.body);
    check('old link -> 400', (await verify(frankToken)).status === 400);
    const ok = await verify(frankToken2);
    check('verify -> 200 { emailVerified: true, emailVerifiedAt }', ok.status === 200 && ok.body.emailVerified === true && !Number.isNaN(Date.parse(ok.body.emailVerifiedAt)) && Object.keys(ok.body).sort().join() === 'emailVerified,emailVerifiedAt', ok.body);
    check('/auth/me -> emailVerified=true; the session is untouched', ((r) => r.status === 200 && r.body.user.emailVerified === true)(await me(F.accessToken)));
    check('replay -> 400 and the verification time is unchanged', (await verify(frankToken2)).status === 400 && (await one('select email_verified_at from users where id = $1', [F.id])).email_verified_at.toISOString() === ok.body.emailVerifiedAt);
    check('resend after verification -> 409', (await resend(F.accessToken)).status === 409);
    check('malformed token -> 400; resend without a token -> 401', (await verify('abc')).status === 400 && (await api('POST', '/auth/verify-email/resend')).status === 401);
    const G = await register('gina');
    const ginaToken = tokenOf(await waitMail(mail('gina'), 'EMAIL_VERIFICATION', 1));
    seenTokens.push(ginaToken);
    await api('PATCH', `/admin/users/${G.id}/suspend`, { token: admin.accessToken });
    check('suspended account: verify -> 400, token not consumed, still unverified', (await verify(ginaToken)).status === 400 && (await tokenRow(ginaToken)).consumed_at === null && (await one('select email_verified_at from users where id = $1', [G.id])).email_verified_at === null);
    check('a reset token is not accepted as a verification token', (await verify(erinToken2)).status === 400);

    // ------------------------------------------------------------ concurrency
    section('6b. Suspension revokes outstanding links (no reactivation of old links)');
    {
      const S = await register('susp');
      const verifyLink = tokenOf(await waitMail(mail('susp'), 'EMAIL_VERIFICATION', 1));
      const resetLink = await resetTokenFor('susp');
      seenTokens.push(verifyLink, resetLink);
      const sus = await api('PATCH', `/admin/users/${S.id}/suspend`, { token: admin.accessToken });
      const rows = (await db.query(`select purpose, revoked_at, consumed_at from auth_user_tokens where user_id = $1 order by purpose`, [S.id])).rows;
      const sessionRevokedAt = (await one(`select max(revoked_at) t from auth_sessions where user_id = $1 and revoked_reason = 'ACCOUNT_SUSPENDED'`, [S.id])).t;
      check('suspension revokes the reset AND verification links in the same transaction as the sessions', sus.status === 200 && rows.length === 2 && rows.every((r) => r.revoked_at !== null && r.consumed_at === null && r.revoked_at.getTime() === sessionRevokedAt.getTime()), { rows, sessionRevokedAt });
      const re = await api('PATCH', `/admin/users/${S.id}/reactivate`, { token: admin.accessToken });
      const oldReset = await reset(resetLink, NEW_PASSWORD);
      const oldVerify = await verify(verifyLink);
      check('suspended -> reactivated: old reset link -> 400, old verification link -> 400; password and verification unchanged', re.status === 200 && oldReset.status === 400 && oldVerify.status === 400 && (await login('susp')).status === 200 && (await one('select email_verified_at from users where id = $1', [S.id])).email_verified_at === null, { re: re.status, oldReset: oldReset.status, oldVerify: oldVerify.status });
      const freshReset = await resetTokenFor('susp');
      seenTokens.push(freshReset);
      check('after reactivation a newly requested link works (no cooldown from revoked links)', (await reset(freshReset, NEW_PASSWORD)).status === 204);
    }
    {
      // Race: suspension vs forgot-password. Whatever the commit order, the
      // suspended user must end with no usable link.
      const out = [];
      let ok = true;
      for (let round = 0; round < 6; round++) {
        const U = await register(`sf${round}`);
        const [sres, fres] = await Promise.all([
          sleep((round % 3) * 4).then(() => api('PATCH', `/admin/users/${U.id}/suspend`, { token: admin.accessToken, port: PORTS[round % 2] })),
          forgot(mail(`sf${round}`), PORTS[(round + 1) % 2]),
        ]);
        const counts = await one(`select count(*) filter (where purpose = 'PASSWORD_RESET')::int issued,
          count(*) filter (where consumed_at is null and revoked_at is null)::int usable from auth_user_tokens where user_id = $1`, [U.id]);
        ok &&= sres.status === 200 && fres.status === 202 && counts.usable === 0;
        out.push({ suspend: sres.status, forgot: fres.status, resetLinksIssued: counts.issued, usableAfter: counts.usable });
      }
      evidence.suspendVsForgot = out;
      check('suspension vs concurrent forgot-password (6 rounds): never a usable link for the suspended user', ok, out);
    }

    section('7. Concurrency (real PostgreSQL transactions, two API instances)');
    {
      const U = await register('race-reset');
      const token = await resetTokenFor('race-reset');
      seenTokens.push(token);
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => reset(token, `RacePassword${i}!`, PORTS[i % 2])));
      const t = tally(rs);
      const winner = rs.findIndex((r) => r.status === 204);
      const logins = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', '/auth/login', { body: { email: mail('race-reset'), password: `RacePassword${i}!` } })));
      evidence.parallelReset = { statuses: t, winner };
      check('10 concurrent resets with one token -> exactly 1x204 + 9x400, no 5xx', t['204'] === 1 && t['400'] === 9, t);
      check("only the winner's password works afterwards; token consumed once", logins.filter((r) => r.status === 200).length === 1 && logins[winner].status === 200 && (await tokenRow(token)).consumed_at !== null && (await one(`select count(*)::int c from auth_user_tokens where user_id = $1 and consumed_at is not null`, [U.id])).c === 1);
    }

    const rounds = async (label, n, body) => {
      const out = [];
      let ok = true;
      for (let round = 0; round < n; round++) {
        const r = await body(round);
        ok &&= r.ok;
        out.push(r.detail);
      }
      evidence[label] = out;
      return ok;
    };
    const jitter = (round) => sleep((round % 4) * 5);
    // change-password runs 3 bcrypt operations before its transaction; odd
    // rounds delay the competing request so both commit orders are exercised.
    const late = (round) => sleep(round % 2 ? 900 : (round % 4) * 5);

    check('reset vs refresh (6 rounds): no session survives; refreshed tokens are dead', await rounds('resetVsRefresh', 6, async (round) => {
      const n = `rr${round}`;
      const U = await register(n);
      const token = await resetTokenFor(n);
      const [x, r] = await Promise.all([jitter(round).then(() => reset(token, NEW_PASSWORD, PORTS[round % 2])), jitter(round + 2).then(() => refresh(U.refreshToken, PORTS[(round + 1) % 2]))]);
      const live = await liveSessions(U.id);
      const dead = r.status !== 200 || (await me(r.body.accessToken)).status === 401;
      return { ok: x.status === 204 && [200, 401].includes(r.status) && live === 0 && dead, detail: { reset: x.status, refresh: r.status, live } };
    }), evidence.resetVsRefresh);

    check('reset vs login with the OLD password (6 rounds): no session survives', await rounds('resetVsOldLogin', 6, async (round) => {
      const n = `rl${round}`;
      const U = await register(n);
      await api('POST', '/auth/logout', { token: U.accessToken });
      const token = await resetTokenFor(n);
      const [x, l] = await Promise.all([jitter(round).then(() => reset(token, NEW_PASSWORD, PORTS[round % 2])), jitter(round + 1).then(() => login(n, PASSWORD, PORTS[(round + 1) % 2]))]);
      const live = await liveSessions(U.id);
      const dead = l.status !== 200 || (await me(l.body.accessToken)).status === 401;
      return { ok: x.status === 204 && [200, 401].includes(l.status) && live === 0 && dead && (await login(n)).status === 401, detail: { reset: x.status, login: l.status, live } };
    }), evidence.resetVsOldLogin);

    check('reset vs change-password (6 rounds): exactly one succeeds, its password wins, no session survives', await rounds('resetVsChange', 6, async (round) => {
      const n = `rc${round}`;
      const U = await register(n);
      const token = await resetTokenFor(n);
      const [x, c] = await Promise.all([late(round).then(() => reset(token, 'ResetWins111!', PORTS[round % 2])), jitter(round + 2).then(() => change(U.accessToken, PASSWORD, 'ChangeWins222!', PORTS[(round + 1) % 2]))]);
      const winners = [x.status === 204, c.status === 204].filter(Boolean).length;
      const expected = x.status === 204 ? 'ResetWins111!' : 'ChangeWins222!';
      const live = await liveSessions(U.id);
      return { ok: winners === 1 && live === 0 && (await login(n, expected)).status === 200 && (await liveSessions(U.id)) === 1, detail: { reset: x.status, change: c.status, live } };
    }), evidence.resetVsChange);
    check('reset vs change-password exercised both commit orders', evidence.resetVsChange.some((e) => e.reset === 204) && evidence.resetVsChange.some((e) => e.change === 204), evidence.resetVsChange);

    check('reset vs logout-all (6 rounds): both safe, no session survives', await rounds('resetVsLogoutAll', 6, async (round) => {
      const n = `ra${round}`;
      const U = await register(n);
      const other = (await login(n)).body;
      const token = await resetTokenFor(n);
      const [x, la] = await Promise.all([jitter(round).then(() => reset(token, NEW_PASSWORD, PORTS[round % 2])), jitter(round + 1).then(() => api('POST', '/auth/logout-all', { token: U.accessToken, port: PORTS[(round + 1) % 2] }))]);
      const live = await liveSessions(U.id);
      return { ok: x.status === 204 && [204, 401].includes(la.status) && live === 0 && (await me(other.accessToken)).status === 401, detail: { reset: x.status, logoutAll: la.status, live } };
    }), evidence.resetVsLogoutAll);

    check('change-password vs refresh (6 rounds): no session survives', await rounds('changeVsRefresh', 6, async (round) => {
      const n = `cr${round}`;
      const U = await register(n);
      const other = (await login(n)).body;
      const [c, r] = await Promise.all([jitter(round).then(() => change(U.accessToken, PASSWORD, NEW_PASSWORD, PORTS[round % 2])), late(round).then(() => refresh(other.refreshToken, PORTS[(round + 1) % 2]))]);
      const live = await liveSessions(U.id);
      const dead = r.status !== 200 || (await me(r.body.accessToken)).status === 401;
      return { ok: c.status === 204 && [200, 401].includes(r.status) && live === 0 && dead, detail: { change: c.status, refresh: r.status, live } };
    }), evidence.changeVsRefresh);

    check('change-password vs login with the OLD password (6 rounds): no session survives, old password dead', await rounds('changeVsOldLogin', 6, async (round) => {
      const n = `co${round}`;
      const U = await register(n);
      const [c, l] = await Promise.all([jitter(round).then(() => change(U.accessToken, PASSWORD, NEW_PASSWORD, PORTS[round % 2])), late(round).then(() => login(n, PASSWORD, PORTS[(round + 1) % 2]))]);
      const live = await liveSessions(U.id);
      const dead = l.status !== 200 || (await me(l.body.accessToken)).status === 401;
      return { ok: c.status === 204 && [200, 401].includes(l.status) && live === 0 && dead && (await login(n)).status === 401, detail: { change: c.status, login: l.status, live } };
    }), evidence.changeVsOldLogin);
    check('change vs old-password login exercised both orders (login first -> revoked, change first -> 401)', evidence.changeVsOldLogin.some((e) => e.login === 200) && evidence.changeVsOldLogin.some((e) => e.login === 401), evidence.changeVsOldLogin);

    // Deterministic interleaving: a password change is in flight (user row
    // locked FOR UPDATE, new hash written, sessions revoked, not committed)
    // while a login with the OLD password runs. Its bcrypt check passes
    // against the committed old hash; it must then wait on the user lock and
    // refuse (hash re-check) instead of opening a session.
    {
      const U = await register('inflight');
      const holder = new Client({ ...DB, database: NAME });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('select id from users where id = $1 for update', [U.id]);
      await holder.query('update users set password_hash = $2 where id = $1', [U.id, await bcrypt.hash(NEW_PASSWORD, 10)]);
      await holder.query(`update auth_sessions set revoked_at = now(), revoked_reason = 'PASSWORD_CHANGED' where user_id = $1 and revoked_at is null`, [U.id]);
      let settled = false;
      const pending = login('inflight').then((r) => ((settled = true), r));
      await sleep(1500);
      const blocked = !settled;
      await holder.query('COMMIT');
      await holder.end();
      const res = await pending;
      evidence.oldPasswordLoginDuringChange = { blockedWhileChangeInFlight: blocked, loginStatus: res.status, liveSessionsAfter: await liveSessions(U.id) };
      check('login with the old password racing an in-flight password change waits on the user lock, then 401 with no session', blocked && res.status === 401 && evidence.oldPasswordLoginDuringChange.liveSessionsAfter === 0, evidence.oldPasswordLoginDuringChange);
    }

    {
      await register('race-verify');
      const token = tokenOf(await waitMail(mail('race-verify'), 'EMAIL_VERIFICATION', 1));
      seenTokens.push(token);
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => verify(token, PORTS[i % 2])));
      evidence.parallelVerify = tally(rs);
      check('10 concurrent verifications with one token -> exactly 1x200 + 9x400', evidence.parallelVerify['200'] === 1 && evidence.parallelVerify['400'] === 9, evidence.parallelVerify);
    }
    {
      const U = await register('race-forgot');
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => forgot(mail('race-forgot'), PORTS[i % 2])));
      await waitMail(mail('race-forgot'), 'PASSWORD_RESET', 1);
      await sleep(800);
      const rows = (await one(`select count(*)::int c, count(*) filter (where consumed_at is null and revoked_at is null)::int usable from auth_user_tokens where user_id = $1 and purpose = 'PASSWORD_RESET'`, [U.id]));
      evidence.parallelForgot = { statuses: tally(rs), tokens: rows, mails: mails(mail('race-forgot'), 'PASSWORD_RESET').length };
      check('10 concurrent forgot-password requests -> 10x202, exactly 1 token and 1 e-mail (per-user lock + cooldown)', tally(rs)['202'] === 10 && rows.c === 1 && rows.usable === 1 && evidence.parallelForgot.mails === 1, evidence.parallelForgot);
    }

    // ------------------------------------------------------------ failure injection
    section('8. Rollback under injected failures (PostgreSQL triggers)');
    await db.query(`
      create function qa_fail_reset_sessions() returns trigger language plpgsql as $$
      begin
        if new.revoked_reason = 'PASSWORD_RESET' and exists (select 1 from users u where u.id = new.user_id and u.email like 'fail.reset.%') then
          raise exception 'QA injected failure: session revocation during reset';
        end if;
        return new;
      end $$;
      create trigger qa_fail_reset before update on auth_sessions for each row execute function qa_fail_reset_sessions();
      create function qa_fail_change_tokens() returns trigger language plpgsql as $$
      begin
        if new.revoked_at is not null and exists (select 1 from users u where u.id = new.user_id and u.email like 'fail.change.%') then
          raise exception 'QA injected failure: token revocation during password change';
        end if;
        return new;
      end $$;
      create trigger qa_fail_change before update on auth_user_tokens for each row execute function qa_fail_change_tokens();
      create function qa_fail_verify_user() returns trigger language plpgsql as $$
      begin
        if old.email like 'fail.verify.%' and new.email_verified_at is not null and old.email_verified_at is null then
          raise exception 'QA injected failure: user update during verification';
        end if;
        return new;
      end $$;
      create trigger qa_fail_verify before update on users for each row execute function qa_fail_verify_user();`);
    const leaks = (r) => JSON.stringify(r.body ?? '').match(/[A-Za-z0-9_-]{43}|[0-9a-f]{64}|\$2[aby]\$/);
    {
      const n = 'fail.reset';
      const email = `${n}.${RUN}@qa.test`;
      const r = await api('POST', '/auth/register', { body: { fullName: 'QA Fail', email, password: PASSWORD } });
      const uid = r.body.user.id;
      await forgot(email);
      const token = tokenOf(await waitMail(email, 'PASSWORD_RESET', 1));
      seenTokens.push(token);
      const hash = await passwordHash(uid);
      const res = await reset(token, NEW_PASSWORD);
      check('reset failing at session revocation -> 500; password, token and sessions all unchanged', res.status === 500 && !leaks(res) && (await passwordHash(uid)) === hash && (await tokenRow(token)).consumed_at === null && (await liveSessions(uid)) === 1, { status: res.status, body: res.body });
      await db.query('drop trigger qa_fail_reset on auth_sessions; drop function qa_fail_reset_sessions();');
      check('after the fault is removed the same token works once', (await reset(token, NEW_PASSWORD)).status === 204 && (await liveSessions(uid)) === 0);
    }
    {
      const email = `fail.change.${RUN}@qa.test`;
      const r = await api('POST', '/auth/register', { body: { fullName: 'QA Fail', email, password: PASSWORD } });
      const uid = r.body.user.id;
      await forgot(email);
      const token = tokenOf(await waitMail(email, 'PASSWORD_RESET', 1));
      seenTokens.push(token);
      const hash = await passwordHash(uid);
      const res = await change(r.body.accessToken, PASSWORD, NEW_PASSWORD);
      check('change-password failing at reset-link revocation -> 500; password and sessions unchanged', res.status === 500 && !leaks(res) && (await passwordHash(uid)) === hash && (await liveSessions(uid)) === 1 && (await me(r.body.accessToken)).status === 200, { status: res.status });
      await db.query('drop trigger qa_fail_change on auth_user_tokens; drop function qa_fail_change_tokens();');
    }
    {
      const email = `fail.verify.${RUN}@qa.test`;
      await api('POST', '/auth/register', { body: { fullName: 'QA Fail', email, password: PASSWORD } });
      const token = tokenOf(await waitMail(email, 'EMAIL_VERIFICATION', 1));
      seenTokens.push(token);
      const res = await verify(token);
      check('verification failing at the user update -> 500; token not consumed, still unverified', res.status === 500 && !leaks(res) && (await tokenRow(token)).consumed_at === null && (await one('select email_verified_at from users where lower(email) = $1', [email])).email_verified_at === null, { status: res.status });
      await db.query('drop trigger qa_fail_verify on users; drop function qa_fail_verify_user();');
      check('after the fault is removed the same verification token works once', (await verify(token)).status === 200 && (await verify(token)).status === 400);
    }

    // ------------------------------------------------------------ invariants + redaction
    section('8b. MAIL_TRANSPORT=smtp against a local protocol stub (NOT real delivery)');
    {
      const stub = await startSmtpStub();
      const saved = { ...process.env };
      Object.assign(process.env, { MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(stub.port), SMTP_SECURE: 'false', MAIL_FROM: 'PawFlow QA <qa@pawflow.test>', MAIL_LINK_BASE_URL: 'http://fe.qa.test' });
      delete process.env.MAIL_OUTBOX_DIR;
      const smtpApp = createApp(NAME, [SMTP_APP_PORT], { logDir: OUT_DIR });
      const startSmtpApp = async () => { process.env = { ...saved, MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(stub.port), SMTP_SECURE: 'false', MAIL_OUTBOX_DIR: '' }; try { await smtpApp.start(); } finally { process.env = saved; } };
      process.env = saved;
      await startSmtpApp();
      const via = (method, url, opts = {}) => api(method, url, { ...opts, port: SMTP_APP_PORT });
      const waitStub = async (n) => { for (let i = 0; i < 200 && stub.messages.length < n; i++) await sleep(50); return stub.messages[n - 1] ?? ''; };
      const resetRows = async (userId) => (await db.query(`select revoked_at, consumed_at from auth_user_tokens where user_id = $1 and purpose = 'PASSWORD_RESET' order by id`, [userId])).rows;
      try {
        // accept
        const reg = await via('POST', '/auth/register', { body: { fullName: 'QA Smtp', email: mail('smtp1'), password: PASSWORD } });
        const verificationRaw = decodeMime(await waitStub(1));
        await via('POST', '/auth/forgot-password', { body: { email: mail('smtp1') } });
        const resetRaw = decodeMime(await waitStub(2));
        const smtpToken = linkToken(resetRaw);
        if (smtpToken) seenTokens.push(smtpToken);
        const toLine = new RegExp(`^To: ${mail('smtp1').replace(/\./g, '\\.')}`, 'm');
        check('smtp/accept: verification and reset e-mails reach the SMTP server with From/To/Subject and a fragment link', reg.status === 201 && /^From: PawFlow QA <qa@pawflow\.test>/m.test(resetRaw) && toLine.test(resetRaw) && /^Subject: Reset your PawFlow password/m.test(resetRaw) && /Subject: Verify your PawFlow e-mail address/.test(verificationRaw) && resetRaw.includes('http://fe.qa.test/reset-password#token=') && !!smtpToken, resetRaw.slice(0, 800));
        check('smtp/accept: the token from the SMTP message resets the password', !!smtpToken && (await via('POST', '/auth/reset-password', { body: { token: smtpToken, newPassword: NEW_PASSWORD } })).status === 204);

        // reject -> link revoked, immediate retry works
        const r2 = await via('POST', '/auth/register', { body: { fullName: 'QA Smtp', email: mail('smtp2'), password: PASSWORD } });
        await waitStub(3);
        stub.mode = 'reject';
        const rejected = await via('POST', '/auth/forgot-password', { body: { email: mail('smtp2') } });
        let rows = [];
        for (let i = 0; i < 100; i++) { rows = await resetRows(r2.body.user.id); if (rows[0]?.revoked_at) break; await sleep(50); }
        check('smtp/reject: still 202; the committed link is revoked once the server rejects the message', rejected.status === 202 && rows.length === 1 && rows[0].revoked_at !== null, rows);
        stub.mode = 'accept';
        const before = stub.messages.length;
        const retry = await via('POST', '/auth/forgot-password', { body: { email: mail('smtp2') } });
        const retryToken = linkToken(decodeMime(await waitStub(before + 1)));
        if (retryToken) seenTokens.push(retryToken);
        check('smtp/reject: an immediate retry (inside the 60 s cooldown) issues and sends a new working link', retry.status === 202 && !!retryToken && (await via('POST', '/auth/reset-password', { body: { token: retryToken, newPassword: NEW_PASSWORD } })).status === 204);

        // hang + hard kill: the documented crash window
        const r3 = await via('POST', '/auth/register', { body: { fullName: 'QA Smtp', email: mail('smtp3'), password: PASSWORD } });
        await waitStub(stub.messages.length + 1);
        stub.mode = 'hang';
        const hung = await via('POST', '/auth/forgot-password', { body: { email: mail('smtp3') } });
        await sleep(500);
        await smtpApp.stop(); // hard kill (TerminateProcess) while the SMTP exchange is in flight
        const afterKill = await resetRows(r3.body.user.id);
        check('crash after 202: the accepted request is durable (token committed and usable), only its e-mail is lost', hung.status === 202 && afterKill.length === 1 && afterKill[0].revoked_at === null, afterKill);
        stub.mode = 'accept';
        await startSmtpApp();
        const sentBefore = stub.messages.length;
        const blocked = await via('POST', '/auth/forgot-password', { body: { email: mail('smtp3') } });
        await sleep(800);
        const blockedSent = stub.messages.length - sentBefore;
        await skipCooldown(r3.body.user.id);
        await via('POST', '/auth/forgot-password', { body: { email: mail('smtp3') } });
        const recToken = linkToken(decodeMime(await waitStub(sentBefore + 1)));
        if (recToken) seenTokens.push(recToken);
        evidence.crashWindow = { retryWithinCooldownSentMails: blockedSent, recoveredAfterCooldown: !!recToken };
        check('crash window (documented limit): a retry within the cooldown sends nothing; after the cooldown a new link works', blocked.status === 202 && blockedSent === 0 && !!recToken && (await via('POST', '/auth/reset-password', { body: { token: recToken, newPassword: NEW_PASSWORD } })).status === 204, evidence.crashWindow);
      } finally {
        await smtpApp.stop();
        await new Promise((resolve) => stub.server.close(resolve));
      }
    }

    section('9. Invariants and secret redaction');
    const inv = await one(`select
      (select count(*)::int from auth_sessions s join users u on u.id = s.user_id where u.status <> 'ACTIVE' and s.revoked_at is null) as live_sessions_of_inactive_users,
      (select count(*)::int from (select user_id, purpose from auth_user_tokens where consumed_at is null and revoked_at is null group by 1, 2 having count(*) > 1) x) as multiple_usable_tokens,
      (select count(*)::int from auth_user_tokens where consumed_at is not null and revoked_at is not null) as consumed_and_revoked,
      (select count(*)::int from auth_user_tokens t join users u on u.id = t.user_id where u.status <> 'ACTIVE' and t.consumed_at is null and t.revoked_at is null) as usable_links_of_inactive_users,
      (select count(*)::int from auth_sessions where (revoked_at is null) <> (revoked_reason is null)) as inconsistent_revocations,
      (select deadlocks::int from pg_stat_database where datname = current_database()) as deadlocks`);
    evidence.invariants = inv;
    check('no live session or usable link of inactive users; <= 1 usable token per user+purpose; consistent states; 0 deadlocks', Object.values(inv).every((v) => v === 0), inv);
    const allTokens = [...new Set([...seenTokens, ...outbox().map(tokenOf)])];
    const stored = (await db.query('select token_hash from auth_user_tokens')).rows.map((r) => r.token_hash);
    check(`no raw token (${allTokens.length} seen) is stored in auth_user_tokens; every e-mailed token is stored as its SHA-256`, allTokens.every((t) => !stored.includes(t) && stored.includes(sha256(t))));
    const logs = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(`app-${NAME}-`)).map((f) => fs.readFileSync(path.join(OUT_DIR, f), 'utf8')).join('\n');
    const leaked = allTokens.filter((t) => logs.includes(t));
    evidence.logLines = logs.split('\n').filter((l) => /Mail|issuance/.test(l)).length;
    check('application logs contain no token, no password and no full recipient address', leaked.length === 0 && !logs.includes(PASSWORD) && !logs.includes(NEW_PASSWORD) && !logs.includes(mail('dave')) && !logs.includes(mail('smtp2')), { leaked: leaked.length });
    check('delivery outcomes are observable in the logs (masked): accepted via file/smtp, failed via smtp with the server reply', /Mail PASSWORD_RESET to d\*\*\*@qa\.test via file accepted/.test(logs) && /Mail PASSWORD_RESET to s\*\*\*@qa\.test via smtp accepted/.test(logs) && /Mail PASSWORD_RESET to s\*\*\*@qa\.test via smtp failed \(.*554/.test(logs), logs.split('\n').filter((l) => /via smtp/.test(l)).slice(0, 6));
    evidence.revokedReasons = (await db.query('select revoked_reason, count(*)::int c from auth_sessions group by 1 order by 1')).rows;
    evidence.outboxMessages = outbox().length;
  } finally {
    await app.stop();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }
}

main()
  .catch((error) => check('harness completed without errors', false, error.stack))
  .finally(() => {
    const failed = results.filter((r) => !r.pass).length;
    fs.writeFileSync(path.join(OUT_DIR, 'account-recovery-results.json'), JSON.stringify({ results, evidence }, null, 2));
    console.log('\nEVIDENCE', JSON.stringify(evidence));
    console.log(`OUT_DIR ${OUT_DIR}`);
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed}  FAIL ${failed}  SKIPPED 0`);
    process.exitCode = failed ? 1 : 0;
  });
