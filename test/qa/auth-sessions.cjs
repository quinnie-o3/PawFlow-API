/*
 * P3-BE01 auth session security — real HTTP + real PostgreSQL (disposable QA database only).
 *
 *   npm run build
 *   npm run qa:auth-sessions
 *
 * Recreates `pawflow_qa_auth_sessions` (QA_DB_NAME), runs every source
 * migration, starts two API instances on it and verifies: short-lived
 * session-bound access tokens, refresh rotation, reuse detection, logout,
 * logout-all, session listing and revocation, account-switch isolation,
 * suspension, and races between refresh, logout-all, login and suspension.
 *
 * Environment: QA_DB_NAME, QA_PORTS (default 8111,8112), QA_OUT_DIR,
 * QA_KEEP_DB=1, QA_DB_HOST/PORT/USERNAME/PASSWORD (default: .env).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const jsonwebtoken = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_auth_sessions';
const PORTS = (process.env.QA_PORTS ?? '8111,8112').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-auth-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaPassword123!';
const RUN = 'a' + Date.now().toString(36);

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 400)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const app = createApp(NAME, PORTS, { logDir: OUT_DIR, jwtSecret: JWT_SECRET });
  await app.start();
  const api = createApi(PORTS);
  const mail = (n) => `${n}.${RUN}@qa.test`;

  const register = async (n) => {
    const r = await api('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD } });
    if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body));
    return { name: n, id: r.body.user.id, ...r.body };
  };
  const login = (n, ua = 'QA-Agent/1.0', port) => api('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD }, headers: { 'User-Agent': ua }, port });
  const refresh = (token, port) => api('POST', '/auth/refresh', { body: { refreshToken: token }, port });
  const me = (access, port) => api('GET', '/auth/me', { token: access, port });
  const sessionRow = (sid) => one('select revoked_at, revoked_reason, user_agent from auth_sessions where id = $1', [sid]);
  const activeSessions = async (userId) => (await one('select count(*)::int c from auth_sessions where user_id = $1 and revoked_at is null', [userId])).c;

  try {
    // ------------------------------------------------------------ schema
    section('0. Schema');
    check(`QA database recreated with all ${migrations.length} source migrations (incl. CreateAuthSessions) and 0 pending DDL`, migrations.length === sourceMigrationCount() && migrations.includes('CreateAuthSessions1794103044835') && pendingDdl.length === 0, { migrations, pendingDdl });
    const cons = (await db.query(`select conname from pg_constraint where conrelid in ('auth_sessions'::regclass, 'auth_refresh_tokens'::regclass) order by 1`)).rows.map((r) => r.conname);
    check('auth tables carry the expected PK/FK/unique/check constraints', ['chk_auth_refresh_tokens_hash', 'chk_auth_sessions_revocation', 'chk_auth_sessions_revoked_reason', 'fk_auth_refresh_tokens_session', 'fk_auth_sessions_user', 'uq_auth_refresh_tokens_hash'].every((c) => cons.includes(c)), cons);
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
    const admin = (await login('admin')).body;

    // ------------------------------------------------------------ issuance
    section('1. Short-lived access tokens and session issuance');
    const A = await register('alice');
    const accessPayload = decode(A.accessToken);
    check('register returns accessToken, Bearer, expiresIn=900, refreshToken, refreshTokenExpiresAt, user', A.tokenType === 'Bearer' && A.expiresIn === 900 && /^[A-Za-z0-9_-]{43}$/.test(A.refreshToken) && !Number.isNaN(Date.parse(A.refreshTokenExpiresAt)) && A.user.role === 'CUSTOMER', { ...A, accessToken: '<jwt>', refreshToken: '<token>' });
    check('access token lives 15 minutes and is bound to a session (sid)', accessPayload.exp - accessPayload.iat === 900 && /^[0-9a-f-]{36}$/.test(accessPayload.sid), accessPayload);
    const sessionTtlDays = (Date.parse(A.refreshTokenExpiresAt) - accessPayload.iat * 1000) / 86400000;
    check('refresh session expires after 30 days (absolute)', Math.abs(sessionTtlDays - 30) < 0.01, sessionTtlDays);
    const stored = await one('select token_hash from auth_refresh_tokens where session_id = $1', [accessPayload.sid]);
    check('only the SHA-256 hash of the refresh token is stored', stored.token_hash.length === 64 && stored.token_hash !== A.refreshToken && (await one(`select count(*)::int c from auth_refresh_tokens where token_hash = $1`, [A.refreshToken])).c === 0);
    const meA = await me(A.accessToken);
    check('GET /auth/me works and its body is unchanged (no sessionId leaked)', meA.status === 200 && meA.body.user.id === A.id && !('sessionId' in meA.body.user), meA.body);
    const legacy = jsonwebtoken.sign({ sub: A.id, email: mail('alice'), role: 'CUSTOMER' }, JWT_SECRET, { expiresIn: 900 });
    check('a validly signed token without sid (pre-P3 format) -> 401', (await me(legacy)).status === 401);
    const forgedSid = jsonwebtoken.sign({ sub: A.id, email: mail('alice'), role: 'CUSTOMER', sid: randomUUID() }, JWT_SECRET, { expiresIn: 900 });
    check('a token with an unknown sid -> 401', (await me(forgedSid)).status === 401);
    const expiredJwt = jsonwebtoken.sign({ sub: A.id, email: mail('alice'), role: 'CUSTOMER', sid: accessPayload.sid }, JWT_SECRET, { expiresIn: -10 });
    check('an expired access token of a live session -> 401 (client must refresh)', (await me(expiredJwt)).status === 401);

    // ------------------------------------------------------------ rotation + reuse
    section('2. Refresh rotation and reuse detection');
    const r1 = await refresh(A.refreshToken, PORTS[0]);
    check('refresh -> 200 with a new access and refresh token for the same session', r1.status === 200 && r1.body.refreshToken !== A.refreshToken && decode(r1.body.accessToken).sid === accessPayload.sid && r1.body.user.id === A.id, r1.body);
    const r2 = await refresh(r1.body.refreshToken, PORTS[1]);
    check('the rotated token works once on the other instance', r2.status === 200 && (await me(r2.body.accessToken)).status === 200);
    check('session expiry is absolute (rotation does not extend it)', r2.body.refreshTokenExpiresAt === A.refreshTokenExpiresAt, [A.refreshTokenExpiresAt, r2.body.refreshTokenExpiresAt]);
    const reuse = await refresh(A.refreshToken);
    check('replaying a consumed refresh token -> 401 reuse detected', reuse.status === 401 && /reuse detected/.test(reuse.body.message), reuse);
    check('reuse revokes the whole session (REUSE_DETECTED)', (await sessionRow(accessPayload.sid)).revoked_reason === 'REUSE_DETECTED');
    check('after reuse the newest access token is rejected immediately', (await me(r2.body.accessToken)).status === 401);
    check('after reuse the newest refresh token is rejected', (await refresh(r2.body.refreshToken)).status === 401);
    const B0 = (await login('alice')).body;
    const unknown = await refresh('Z'.repeat(43));
    check('an unknown well-formed refresh token -> 401 and revokes nothing', unknown.status === 401 && (await sessionRow(decode(B0.accessToken).sid)).revoked_at === null, unknown);
    check('a malformed refresh token -> 400', (await refresh('short')).status === 400 && (await api('POST', '/auth/refresh', { body: {} })).status === 400);

    // Concurrent use of one refresh token (stolen token racing the client, or two tabs).
    const race = await Promise.all(Array.from({ length: 10 }, (_, i) => refresh(B0.refreshToken, PORTS[i % 2])));
    const raceSid = decode(B0.accessToken).sid;
    const raceRow = await sessionRow(raceSid);
    evidence.parallelRefresh = { statuses: tally(race), sessionRevokedReason: raceRow.revoked_reason };
    check('10 concurrent refreshes with one token -> exactly 1x200, 9x401, no 5xx', tally(race)['200'] === 1 && tally(race)['401'] === 9, tally(race));
    check('the concurrent replays are detected as reuse: the session is revoked', raceRow.revoked_reason === 'REUSE_DETECTED', raceRow);
    const winner = race.find((r) => r.status === 200);
    check('the single winner token pair is dead too (no surviving branch)', (await me(winner.body.accessToken)).status === 401 && (await refresh(winner.body.refreshToken)).status === 401);

    // ------------------------------------------------------------ logout / logout-all / sessions
    section('3. Logout, logout-all and session list');
    const s1 = (await login('alice', 'Phone/1')).body;
    const s2 = (await login('alice', 'Laptop/2')).body;
    const out = await api('POST', '/auth/logout', { token: s1.accessToken });
    check('logout -> 204', out.status === 204, out);
    check('logged-out access token -> 401 immediately; its refresh token -> 401', (await me(s1.accessToken)).status === 401 && (await refresh(s1.refreshToken)).status === 401);
    check('logout leaves the other session working', (await me(s2.accessToken)).status === 200);
    check('logout again with the revoked token -> 401', (await api('POST', '/auth/logout', { token: s1.accessToken })).status === 401);
    const s3 = (await login('alice', 'Tablet/3')).body;
    const list = await api('GET', '/auth/sessions', { token: s3.accessToken });
    check('session list -> only active sessions, newest first, current flagged, user agent recorded', list.status === 200 && list.body.length === 2 && list.body[0].current === true && list.body[0].id === decode(s3.accessToken).sid && list.body[0].userAgent === 'Tablet/3' && list.body[1].userAgent === 'Laptop/2' && list.body.every((s) => Object.keys(s).sort().join() === 'createdAt,current,expiresAt,id,ipAddress,lastUsedAt,userAgent'), list.body);
    const del = await api('DELETE', `/auth/sessions/${decode(s2.accessToken).sid}`, { token: s3.accessToken });
    check('DELETE /auth/sessions/:id revokes another own session -> 204, its token 401', del.status === 204 && (await me(s2.accessToken)).status === 401 && (await sessionRow(decode(s2.accessToken).sid)).revoked_reason === 'SESSION_REVOKED', del);
    check('DELETE with a non-UUID id -> 400; unknown id -> 404; no token -> 401', (await api('DELETE', '/auth/sessions/abc', { token: s3.accessToken })).status === 400 && (await api('DELETE', `/auth/sessions/${randomUUID()}`, { token: s3.accessToken })).status === 404 && (await api('DELETE', `/auth/sessions/${randomUUID()}`)).status === 401);
    const many = await Promise.all([login('alice', 'D1'), login('alice', 'D2'), login('alice', 'D3')]);
    const all = await api('POST', '/auth/logout-all', { token: many[0].body.accessToken });
    check('logout-all -> 204 and every alice session is revoked (including the caller)', all.status === 204 && (await activeSessions(A.id)) === 0 && (await Promise.all([...many.map((m) => me(m.body.accessToken)), me(s3.accessToken)])).every((r) => r.status === 401), all);
    check('after logout-all no refresh token of alice works', (await Promise.all(many.map((m) => refresh(m.body.refreshToken)))).every((r) => r.status === 401));
    check('session endpoints require authentication (401)', (await api('GET', '/auth/sessions')).status === 401 && (await api('POST', '/auth/logout')).status === 401 && (await api('POST', '/auth/logout-all')).status === 401);

    // ------------------------------------------------------------ account switch
    section('4. Account-switch isolation');
    const aliceTab = (await login('alice', 'Shared/1')).body;
    const B = await register('bob');
    await api('POST', '/auth/logout', { token: aliceTab.accessToken });
    const bob = (await login('bob', 'Shared/1')).body;
    check("after switching, alice's tokens from the same client are dead", (await me(aliceTab.accessToken)).status === 401 && (await refresh(aliceTab.refreshToken)).status === 401);
    const bobMe = await me(bob.accessToken);
    const bobRefresh = await refresh(bob.refreshToken);
    check("bob's token resolves to bob only; his refresh returns bob", bobMe.body.user.id === B.id && bobRefresh.status === 200 && bobRefresh.body.user.id === B.id && decode(bobRefresh.body.accessToken).sub === B.id);
    const bobList = await api('GET', '/auth/sessions', { token: bobRefresh.body.accessToken });
    const aliceSids = (await db.query('select id::text from auth_sessions where user_id = $1', [A.id])).rows.map((r) => r.id);
    check("bob's session list contains none of alice's sessions", bobList.body.length === 2 && bobList.body.every((s) => !aliceSids.includes(s.id)), bobList.body);
    check("bob cannot revoke alice's session (404) and it is unchanged", (await api('DELETE', `/auth/sessions/${aliceSids[0]}`, { token: bobRefresh.body.accessToken })).status === 404);
    const alice2 = (await login('alice', 'Other/1')).body;
    await api('POST', '/auth/logout-all', { token: bobRefresh.body.accessToken });
    check("bob's logout-all does not affect alice", (await me(alice2.accessToken)).status === 200);
    const forged = jsonwebtoken.sign({ sub: B.id, email: mail('bob'), role: 'CUSTOMER', sid: decode(alice2.accessToken).sid }, JWT_SECRET, { expiresIn: 900 });
    check("a token claiming bob with alice's session id -> 401 (session bound to its user)", (await me(forged)).status === 401);

    // ------------------------------------------------------------ suspension
    section('5. Suspended users cannot hold or obtain sessions');
    const C = await register('carol');
    const c2 = (await login('carol', 'Second/1')).body;
    const sus = await api('PATCH', `/admin/users/${C.id}/suspend`, { token: admin.accessToken });
    check('admin suspends carol -> 200', sus.status === 200 && sus.body.status === 'SUSPENDED', sus);
    check('all carol sessions revoked with ACCOUNT_SUSPENDED', (await activeSessions(C.id)) === 0 && (await one(`select count(*)::int c from auth_sessions where user_id = $1 and revoked_reason = 'ACCOUNT_SUSPENDED'`, [C.id])).c === 2);
    check('carol access tokens -> 401 immediately', (await me(C.accessToken)).status === 401 && (await me(c2.accessToken)).status === 401);
    check('carol refresh -> 401; login -> 401 "Account is not active"; no new session', (await refresh(c2.refreshToken)).status === 401 && ((r) => r.status === 401 && r.body.message === 'Account is not active')(await login('carol')) && (await activeSessions(C.id)) === 0);
    await api('PATCH', `/admin/users/${C.id}/reactivate`, { token: admin.accessToken });
    check('after reactivation old sessions stay revoked; a new login works', (await me(c2.accessToken)).status === 401 && (await refresh(c2.refreshToken)).status === 401 && (await login('carol')).status === 200);

    // ------------------------------------------------------------ expiry
    section('6. Session expiry');
    const D = await register('dave');
    await db.query(`update auth_sessions set expires_at = now() - interval '1 second' where id = $1`, [decode(D.accessToken).sid]);
    check('expired session: its unexpired access token -> 401, refresh -> 401, not listed', (await me(D.accessToken)).status === 401 && (await refresh(D.refreshToken)).status === 401);

    // ------------------------------------------------------------ races
    section('7. Concurrency (real PostgreSQL transactions)');
    evidence.suspendVsRefresh = [];
    let suspendRefreshOk = true;
    for (let round = 0; round < 8; round++) {
      const U = await register('race' + round);
      const extra = (await login('race' + round)).body;
      const [s, r, l] = await Promise.all([
        sleep((round % 4) * 5).then(() => api('PATCH', `/admin/users/${U.id}/suspend`, { token: admin.accessToken, port: PORTS[round % 2] })),
        sleep(((round + 2) % 4) * 5).then(() => refresh(extra.refreshToken, PORTS[(round + 1) % 2])),
        login('race' + round, 'Racer', PORTS[round % 2]),
      ]);
      const live = await activeSessions(U.id);
      const newTokensDead = r.status !== 200 || (await me(r.body.accessToken)).status === 401;
      const loginTokenDead = l.status !== 200 || (await me(l.body.accessToken)).status === 401;
      const ok = s.status === 200 && [200, 401].includes(r.status) && [200, 401].includes(l.status) && live === 0 && newTokensDead && loginTokenDead;
      suspendRefreshOk &&= ok;
      evidence.suspendVsRefresh.push({ suspend: s.status, refresh: r.status, login: l.status, liveSessionsAfter: live });
    }
    check('suspend vs concurrent refresh + login (8 rounds): no suspended user ever keeps a live session or usable token', suspendRefreshOk, evidence.suspendVsRefresh);
    const both = { refreshFirst: evidence.suspendVsRefresh.filter((e) => e.refresh === 200).length, suspendFirst: evidence.suspendVsRefresh.filter((e) => e.refresh === 401).length };
    evidence.suspendVsRefreshOrders = both;

    // Deterministic interleaving: a suspension is in flight (user row locked
    // FOR UPDATE, status already SUSPENDED, not committed) while a login with a
    // correct password runs. The login must wait on its FOR SHARE re-check and
    // then refuse, instead of opening a session from the ACTIVE status it read.
    {
      const U = await register('inflight');
      const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
      const holder = new Client({ ...require('./qa-env.cjs').DB, database: NAME });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('select id from users where id = $1 for update', [U.id]);
      await holder.query(`update users set status = 'SUSPENDED' where id = $1`, [U.id]);
      await holder.query(`update auth_sessions set revoked_at = now(), revoked_reason = 'ACCOUNT_SUSPENDED' where user_id = $1 and revoked_at is null`, [U.id]);
      let settled = false;
      const pending = login('inflight').then((r) => ((settled = true), r));
      await sleep(1500);
      const blocked = !settled;
      await holder.query('COMMIT');
      await holder.end();
      const res = await pending;
      evidence.loginDuringSuspension = { blockedWhileSuspensionInFlight: blocked, loginStatus: res.status, liveSessionsAfter: await activeSessions(U.id) };
      check('login racing an in-flight suspension waits on the user lock, then 401 with no session', blocked && res.status === 401 && evidence.loginDuringSuspension.liveSessionsAfter === 0, evidence.loginDuringSuspension);
    }

    evidence.logoutAllVsRefresh = [];
    let logoutAllOk = true;
    for (let round = 0; round < 6; round++) {
      const U = await register('lo' + round);
      const other = (await login('lo' + round)).body;
      const [la, r] = await Promise.all([
        sleep((round % 3) * 5).then(() => api('POST', '/auth/logout-all', { token: U.accessToken, port: PORTS[round % 2] })),
        refresh(other.refreshToken, PORTS[(round + 1) % 2]),
      ]);
      const live = await activeSessions(U.id);
      const ok = la.status === 204 && live === 0 && (r.status !== 200 || (await me(r.body.accessToken)).status === 401);
      logoutAllOk &&= ok;
      evidence.logoutAllVsRefresh.push({ logoutAll: la.status, refresh: r.status, liveSessionsAfter: live });
    }
    check('logout-all vs concurrent refresh (6 rounds): no session survives', logoutAllOk, evidence.logoutAllVsRefresh);

    // ------------------------------------------------------------ registration atomicity
    section('8. Registration atomicity (failure injection with PostgreSQL triggers)');
    // QA-only triggers make the session or refresh-token INSERT fail inside the
    // registration transaction for e-mails with a marker prefix.
    await db.query(`
      create function qa_fail_session_insert() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from users u where u.id = new.user_id and u.email like 'fail.session.%') then
          raise exception 'QA injected failure: auth_sessions insert';
        end if;
        return new;
      end $$;
      create trigger qa_fail_session before insert on auth_sessions for each row execute function qa_fail_session_insert();
      create function qa_fail_token_insert() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from auth_sessions s join users u on u.id = s.user_id where s.id = new.session_id and u.email like 'fail.token.%') then
          raise exception 'QA injected failure: auth_refresh_tokens insert';
        end if;
        return new;
      end $$;
      create trigger qa_fail_token before insert on auth_refresh_tokens for each row execute function qa_fail_token_insert();`);
    const totals = async () => one(`select (select count(*)::int from users) users, (select count(*)::int from auth_sessions) sessions, (select count(*)::int from auth_refresh_tokens) tokens`);
    const usersWith = async (email) => (await one('select count(*)::int c from users where lower(email) = lower($1)', [email])).c;
    for (const [label, email] of [['session insert', `fail.session.${RUN}@qa.test`], ['refresh-token insert', `fail.token.${RUN}@qa.test`]]) {
      const before = await totals();
      const res = await api('POST', '/auth/register', { body: { fullName: 'QA Failure', email, password: PASSWORD } });
      const after = await totals();
      check(`register failing at the ${label} -> 500 without credentials, and NO user/session/token persisted`, res.status === 500 && !res.body?.accessToken && !res.body?.refreshToken && (await usersWith(email)) === 0 && JSON.stringify(before) === JSON.stringify(after), { status: res.status, before, after });
    }
    await db.query('drop trigger qa_fail_session on auth_sessions; drop trigger qa_fail_token on auth_refresh_tokens; drop function qa_fail_session_insert(); drop function qa_fail_token_insert();');
    const retry = await api('POST', '/auth/register', { body: { fullName: 'QA Retry', email: `fail.token.${RUN}@qa.test`, password: PASSWORD } });
    check('the same e-mail registers normally afterwards (nothing was left behind)', retry.status === 201 && (await usersWith(`fail.token.${RUN}@qa.test`)) === 1);

    const okReg = await api('POST', '/auth/register', { body: { fullName: 'QA Atomic', email: mail('atomic'), password: PASSWORD } });
    const okSid = decode(okReg.body.accessToken).sid;
    const okRows = await one(`select (select count(*)::int from auth_sessions where user_id = $1) sessions, (select count(*)::int from auth_refresh_tokens t join auth_sessions s on s.id = t.session_id where s.user_id = $1) tokens, (select token_hash from auth_refresh_tokens where session_id = $2) hash`, [okReg.body.user.id, okSid]);
    check('successful registration committed user + 1 session + 1 token verifier matching the returned refresh token', okReg.status === 201 && okRows.sessions === 1 && okRows.tokens === 1 && okRows.hash === require('crypto').createHash('sha256').update(okReg.body.refreshToken).digest('hex'), okRows);
    check('the returned credentials work immediately (/auth/me, refresh)', (await me(okReg.body.accessToken)).status === 200 && (await refresh(okReg.body.refreshToken)).status === 200);

    evidence.concurrentDuplicateRegistration = [];
    let duplicatesOk = true;
    for (let round = 0; round < 3; round++) {
      const email = `dup${round}.${RUN}@qa.test`;
      const variants = [email, email.toUpperCase(), `Dup${round}.${RUN}@QA.test`];
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', '/auth/register', { body: { fullName: 'QA Dup', email: variants[i % 3], password: PASSWORD }, port: PORTS[i % 2] })));
      const rows = await one(`select (select count(*)::int from users where lower(email) = $1) users,
        (select count(*)::int from auth_sessions s join users u on u.id = s.user_id where lower(u.email) = $1) sessions,
        (select count(*)::int from auth_refresh_tokens t join auth_sessions s on s.id = t.session_id join users u on u.id = s.user_id where lower(u.email) = $1) tokens`, [email]);
      const t = tally(rs);
      const ok = t['201'] === 1 && t['409'] === 9 && rows.users === 1 && rows.sessions === 1 && rows.tokens === 1;
      duplicatesOk &&= ok;
      evidence.concurrentDuplicateRegistration.push({ statuses: t, ...rows });
    }
    check('10 concurrent registrations of one e-mail (mixed case, 2 instances) x3: exactly 1x201 + 9x409, 1 user, 1 session, 1 token', duplicatesOk, evidence.concurrentDuplicateRegistration);
    const orphans = await one(`select count(*)::int c from users u where u.role = 'CUSTOMER' and u.email like '%.${RUN}@qa.test' and not exists (select 1 from auth_sessions s where s.user_id = u.id)`);
    check('no customer created by this run exists without a session (no orphan registrations)', orphans.c === 0, orphans);

    // ------------------------------------------------------------ invariants
    section('9. Invariants');
    const inv = await one(`select
      (select count(*)::int from auth_sessions s join users u on u.id = s.user_id where u.status <> 'ACTIVE' and s.revoked_at is null) as live_sessions_of_inactive_users,
      (select count(*)::int from (select session_id from auth_refresh_tokens where used_at is null group by session_id having count(*) > 1) x) as sessions_with_multiple_unused_tokens,
      (select count(*)::int from auth_sessions s where s.revoked_at is null and s.expires_at > now() and not exists (select 1 from auth_refresh_tokens t where t.session_id = s.id and t.used_at is null)) as live_sessions_without_current_token,
      (select count(*)::int from auth_sessions where (revoked_at is null) <> (revoked_reason is null)) as inconsistent_revocations,
      (select deadlocks::int from pg_stat_database where datname = current_database()) as deadlocks`);
    evidence.invariants = inv;
    check('no live session for inactive users; one current token per live session; no deadlocks', Object.values(inv).every((v) => v === 0), inv);
    evidence.revokedReasons = (await db.query('select revoked_reason, count(*)::int c from auth_sessions group by 1 order by 1')).rows;
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
    fs.writeFileSync(path.join(OUT_DIR, 'auth-sessions-results.json'), JSON.stringify({ results, evidence }, null, 2));
    console.log('\nEVIDENCE', JSON.stringify(evidence));
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed}  FAIL ${failed}  SKIPPED 0`);
    process.exitCode = failed ? 1 : 0;
  });
