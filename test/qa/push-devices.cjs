/*
 * P3-BE05 push device lifecycle — real HTTP + real PostgreSQL (disposable QA database only).
 *
 *   npm run build
 *   npm run qa:push-devices
 *
 * Two API instances. The internal P3-BE06 contract (findSendTargets,
 * markInvalid, revokeStale) is exercised through the compiled
 * PushDevicesService with the same (development, JWT_SECRET-derived) keys.
 * No Firebase project or credentials are used: registration storage only.
 * Environment: QA_DB_NAME, QA_PORTS (default 8211,8212), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_push_devices';
const PORTS = (process.env.QA_PORTS ?? '8211,8212').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-push-'));
const OUTBOX = path.join(OUT_DIR, 'outbox');
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaPassword123!';
const RUN = 'p' + Date.now().toString(36);
const NEW_MIGRATION = 'CreatePushDevices1796000000000';
const VIEW_KEYS = 'current,id,lastSeenAt,platform,registeredAt,registrationKind,stale';

const results = [];
const evidence = {};
const seenValues = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 500)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const fid = () => { const v = randomBytes(16).toString('base64url'); seenValues.push(v); return v; };
const legacyToken = () => { const v = `${randomBytes(8).toString('base64url')}:APA91b${randomBytes(110).toString('base64url')}`; seenValues.push(v); return v; };
const sidOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sid;

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  let app = null;
  let ds = null;
  try {
    section('0. Schema, triggers, constraints, migration rehearsal');
    check(`all ${migrations.length} source migrations applied (incl. CreatePushDevices), 0 pending DDL`, migrations.length === sourceMigrationCount() && migrations.includes(NEW_MIGRATION) && pendingDdl.length === 0, { migrations: migrations.slice(-3), pendingDdl });
    ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')] });
    await ds.initialize();
    // Undo newest first, down to and including CreatePushDevices (later migrations are re-applied below).
    const undoCount = migrations.length - migrations.indexOf(NEW_MIGRATION);
    for (let i = 0; i < undoCount; i++) await ds.undoLastMigration({ transaction: 'each' });
    const after = await one(`select to_regclass('push_devices') t, (select count(*)::int from pg_trigger where tgname = 'trg_auth_sessions_revoke_push_devices') trg, (select count(*)::int from pg_constraint where conname = 'uq_auth_sessions_id_user') uq`);
    const again = await ds.runMigrations({ transaction: 'each' });
    const pendingAgain = (await ds.driver.createSchemaBuilder().log()).upQueries.length;
    check('down removes table, both triggers/functions and the auth_sessions unique; up again -> 0 pending DDL', after.t === null && after.trg === 0 && after.uq === 0 && again.length === undoCount && again[0].name === NEW_MIGRATION && pendingAgain === 0, { after, pendingAgain });

    const { PushDevicesService } = require(path.join(ROOT, 'dist', 'push-devices', 'push-devices.service.js'));
    const { NotificationsService } = require(path.join(ROOT, 'dist', 'notifications', 'notifications.service.js'));
    const svc = new PushDevicesService(ds, { get: (k) => ({ JWT_SECRET, NODE_ENV: 'test' })[k] });
    const inbox = new NotificationsService(ds);

    fs.mkdirSync(OUTBOX, { recursive: true });
    app = createApp(NAME, PORTS, { logDir: OUT_DIR, jwtSecret: JWT_SECRET, env: { MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: OUTBOX, MAIL_LINK_BASE_URL: 'http://fe.qa.test' } });
    await app.start();
    const api = createApi(PORTS);
    const statuses = [];
    const call = async (method, url, opts = {}) => { const r = await api(method, url, opts); statuses.push(r.status); return r; };
    const mail = (n) => `${n}.${RUN}@qa.test`;
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    for (const [n, role] of [['alice', 'CUSTOMER'], ['bob', 'CUSTOMER'], ['carol', 'CUSTOMER'], ['owner', 'PROVIDER_OWNER'], ['admin', 'ADMIN']]) {
      ids[n] = (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, $4, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), hash, role])).id;
    }
    const login = async (n, password = PASSWORD, port) => { const r = await call('POST', '/auth/login', { body: { email: mail(n), password }, port }); if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`); return { token: r.body.accessToken, refresh: r.body.refreshToken, sid: sidOf(r.body.accessToken) }; };
    const reg = (s, value, kind = 'FID', platform = 'WEB', port) => call('POST', '/push-devices', { token: s.token, body: { registrationKind: kind, registrationValue: value, platform }, port });
    const activeFor = async (where, params) => (await one(`select count(*)::int c from push_devices where revoked_at is null and ${where}`, params)).c;
    const rowOf = (id) => one(`select id::text, revoked_at, revocation_reason, auth_session_id, user_id::text from push_devices where id = $1`, [id]);
    const admin = await login('admin');

    section('0b. Database-level invariants');
    {
      const s = await login('carol');
      const v = fid();
      const r = await reg(s, v);
      const dev = r.body.device.id;
      const rejects = async (sql, params) => db.query(sql, params).then(() => null, (e) => e.message);
      const row = await one(`select * from push_devices where id = $1`, [dev]);
      const errs = {
        sessionOfAnotherUser: await rejects(`insert into push_devices(user_id, auth_session_id, registration_kind, registration_hash, registration_ciphertext, platform) values ($1, $2, 'FID', $3, 'v1:dev:x', 'WEB')`, [ids.bob, s.sid, 'b'.repeat(64)]),
        secondActiveSameDestination: await rejects(`insert into push_devices(user_id, auth_session_id, registration_kind, registration_hash, registration_ciphertext, platform) values ($1, $2, 'FID', $3, 'v1:dev:x', 'WEB')`, [ids.carol, (await login('carol')).sid, row.registration_hash]),
        secondActiveSameSession: await rejects(`insert into push_devices(user_id, auth_session_id, registration_kind, registration_hash, registration_ciphertext, platform) values ($1, $2, 'FID', $3, 'v1:dev:x', 'WEB')`, [ids.carol, s.sid, 'c'.repeat(64)]),
        changeOwner: await rejects(`update push_devices set user_id = $2 where id = $1`, [dev, ids.bob]),
        badKind: await rejects(`insert into push_devices(user_id, auth_session_id, registration_kind, registration_hash, registration_ciphertext, platform) values ($1, $2, 'APNS', $3, 'v1:dev:x', 'WEB')`, [ids.carol, s.sid, 'd'.repeat(64)]),
        plaintextValue: await rejects(`insert into push_devices(user_id, auth_session_id, registration_kind, registration_hash, registration_ciphertext, platform) values ($1, $2, 'FID', $3, $4, 'WEB')`, [ids.carol, (await login('carol')).sid, 'e'.repeat(64), v]),
      };
      check('DB rejects: session of another user (composite FK), 2nd active row per destination and per session, owner change, unknown kind, plaintext value', Object.values(errs).every((e) => e !== null), errs);
      await db.query(`update push_devices set revoked_at = now(), revocation_reason = 'USER_REVOKED' where id = $1`, [dev]);
      const unrevoke = await rejects(`update push_devices set revoked_at = null, revocation_reason = null where id = $1`, [dev]);
      check('a revoked registration can never become active again (trigger)', /cannot change/.test(unrevoke ?? ''), unrevoke);
      check('stored value is encrypted (v1:<keyId>:…) and never equal to / containing the FID; hash is HMAC hex', row.registration_ciphertext.startsWith('v1:dev:') && !row.registration_ciphertext.includes(v) && /^[0-9a-f]{64}$/.test(row.registration_hash));
    }

    section('1. Authentication and validation');
    {
      const anon = await Promise.all([call('POST', '/push-devices', { body: { registrationKind: 'FID', registrationValue: fid(), platform: 'WEB' } }), call('GET', '/push-devices'), call('DELETE', '/push-devices/1')]);
      check('anonymous POST/GET/DELETE -> 401', anon.every((r) => r.status === 401));
      const a = await login('alice');
      const bad = await Promise.all([
        { registrationKind: 'APNS', registrationValue: fid(), platform: 'WEB' },
        { registrationKind: 'FID', registrationValue: legacyToken(), platform: 'WEB' },
        { registrationKind: 'FCM_TOKEN', registrationValue: fid(), platform: 'WEB' },
        { registrationKind: 'FID', registrationValue: 'x/y', platform: 'WEB' },
        { registrationKind: 'FID', registrationValue: fid(), platform: 'DESKTOP' },
        { registrationKind: 'FID', registrationValue: fid(), platform: 'WEB', userId: ids.bob },
        { registrationKind: 'FID', registrationValue: fid(), platform: 'WEB', sessionId: randomUUID() },
      ].map((body) => call('POST', '/push-devices', { token: a.token, body })));
      check('invalid kind/value/platform, kind-value mismatch, client userId/sessionId -> 400, nothing stored', bad.every((r) => r.status === 400) && (await activeFor('user_id = $1', [ids.alice])) === 0, bad.map((r) => r.status));
      check('DELETE with a non-numeric id -> 400', (await call('DELETE', '/push-devices/abc', { token: a.token })).status === 400);
    }

    section('2. Registration, idempotency, multiple devices, isolation');
    const A1 = await login('alice');
    const A2 = await login('alice');
    const fidA1 = fid();
    const c1 = await reg(A1, fidA1, 'FID', 'WEB', PORTS[0]);
    await sleep(20);
    const c2 = await reg(A1, fidA1, 'FID', 'WEB', PORTS[1]);
    check('first registration -> 200 CREATED; repeating it (other instance) -> REFRESHED, same id, lastSeenAt advanced', c1.status === 200 && c1.body.result === 'CREATED' && c2.body.result === 'REFRESHED' && c2.body.device.id === c1.body.device.id && Date.parse(c2.body.device.lastSeenAt) > Date.parse(c1.body.device.lastSeenAt), [c1.body, c2.body]);
    check('response is the safe projection (no value, no hash, no user/session id)', Object.keys(c1.body.device).sort().join() === VIEW_KEYS && !JSON.stringify(c1.body).includes(fidA1));
    {
      const S = await login('alice');
      const v = fid();
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => reg(S, v, 'FID', 'WEB', PORTS[i % 2])));
      const deviceIds = new Set(rs.map((r) => r.body.device?.id));
      evidence.concurrentSameInstallation = { statuses: tally(rs), results: rs.reduce((m, r) => ((m[r.body.result] = (m[r.body.result] ?? 0) + 1), m), {}), active: await activeFor('auth_session_id = $1', [S.sid]) };
      check('10 concurrent registrations of one installation (2 instances) -> all 200, 1 CREATED + 9 REFRESHED, one row', rs.every((r) => r.status === 200) && deviceIds.size === 1 && evidence.concurrentSameInstallation.results.CREATED === 1 && evidence.concurrentSameInstallation.active === 1, evidence.concurrentSameInstallation);
      await call('POST', '/auth/logout', { token: S.token });
    }
    const fidA2 = fid();
    const d2 = await reg(A2, fidA2, 'FID', 'WEB');
    const listA = await call('GET', '/push-devices', { token: A1.token });
    check('a user may have several devices: list shows both, `current` marks this session only', d2.body.result === 'CREATED' && listA.body.length === 2 && listA.body.filter((d) => d.current).length === 1 && listA.body.find((d) => d.current).id === c1.body.device.id && listA.body.every((d) => Object.keys(d).sort().join() === VIEW_KEYS), listA.body);
    const targetsA = await svc.findSendTargets(ids.alice);
    check('internal findSendTargets: both of alice\'s destinations, decrypted, kind FID', targetsA.length === 2 && new Set(targetsA.map((t) => t.registrationValue)).size === 2 && targetsA.every((t) => [fidA1, fidA2].includes(t.registrationValue) && t.registrationKind === 'FID'));
    const B = await login('bob');
    const fidB = fid();
    const rb = await reg(B, fidB);
    const listB = await call('GET', '/push-devices', { token: B.token });
    const crossDel = await call('DELETE', `/push-devices/${c1.body.device.id}`, { token: B.token });
    const missDel = await call('DELETE', '/push-devices/999999999', { token: B.token });
    check("isolation: bob sees only his device; deleting alice's device -> 404 identical to a missing id; alice's stays active", rb.body.result === 'CREATED' && listB.body.length === 1 && listB.body[0].id === rb.body.device.id && crossDel.status === 404 && JSON.stringify(crossDel.body) === JSON.stringify(missDel.body) && (await rowOf(c1.body.device.id)).revoked_at === null);
    check("findSendTargets(bob) never contains alice's destinations", (await svc.findSendTargets(ids.bob)).every((t) => t.registrationValue === fidB));

    section('3. Rotation and kind change (never two destinations per installation)');
    {
      const S = await login('alice');
      const tok = legacyToken();
      const r1 = await reg(S, tok, 'FCM_TOKEN', 'WEB');
      const newFid = fid();
      const r2 = await reg(S, newFid, 'FID', 'WEB');
      const old = await rowOf(r1.body.device.id);
      check('legacy token then FID from the same session -> ROTATED: token row revoked (ROTATED), one active row', r1.body.result === 'CREATED' && r2.body.result === 'ROTATED' && old.revocation_reason === 'ROTATED' && (await activeFor('auth_session_id = $1', [S.sid])) === 1);
      const r3 = await reg(S, fid(), 'FID', 'WEB');
      check('new FID for the same session -> ROTATED; previous FID revoked', r3.body.result === 'ROTATED' && (await rowOf(r2.body.device.id)).revocation_reason === 'ROTATED' && (await activeFor('auth_session_id = $1', [S.sid])) === 1);
      await call('POST', '/auth/logout', { token: S.token });
    }

    section('4. Revocation by the user');
    {
      const S = await login('alice');
      const r = await reg(S, fid());
      const d1 = await call('DELETE', `/push-devices/${r.body.device.id}`, { token: S.token });
      const d2b = await call('DELETE', `/push-devices/${r.body.device.id}`, { token: S.token });
      check('DELETE own device -> 204, repeated -> 204 (idempotent); USER_REVOKED; not a send target', d1.status === 204 && d2b.status === 204 && (await rowOf(r.body.device.id)).revocation_reason === 'USER_REVOKED' && !(await svc.findSendTargets(ids.alice)).some((t) => t.deviceId === r.body.device.id));
      const again = await reg(S, (await one(`select 1`)) && fid());
      check('the same session can register again after a user revocation (new row)', again.body.result === 'CREATED');
      await call('POST', '/auth/logout', { token: S.token });
    }

    section('5. Session-driven cleanup (logout, logout-all, password change/reset, suspension)');
    {
      const before = await activeFor('auth_session_id = $1', [A2.sid]);
      const lo = await call('POST', '/auth/logout', { token: A1.token });
      const r1 = await rowOf(c1.body.device.id);
      check("logout -> that session's device revoked (SESSION_REVOKED, same transaction); the other session's device stays", lo.status === 204 && r1.revocation_reason === 'SESSION_REVOKED' && before === 1 && (await activeFor('auth_session_id = $1', [A2.sid])) === 1);
      check('logged-out session token cannot register again (401)', (await reg(A1, fidA1)).status === 401);
      const A3 = await login('alice');
      await reg(A3, fid());
      const la = await call('POST', '/auth/logout-all', { token: A3.token });
      check('logout-all -> every device of alice revoked; no send targets', la.status === 204 && (await activeFor('user_id = $1', [ids.alice])) === 0 && (await svc.findSendTargets(ids.alice)).length === 0);

      const P = await login('carol');
      const P2 = await login('carol');
      await reg(P, fid());
      await reg(P2, fid());
      const pc = await call('POST', '/auth/change-password', { token: P.token, body: { currentPassword: PASSWORD, newPassword: 'NewPassword456!' } });
      check('password change -> all carol devices revoked (both sessions)', pc.status === 204 && (await activeFor('user_id = $1', [ids.carol])) === 0 && (await one(`select count(*)::int c from push_devices where user_id = $1 and revocation_reason = 'SESSION_REVOKED'`, [ids.carol])).c >= 2);

      const R = await login('bob');
      await reg(R, fid());
      const fg = await call('POST', '/auth/forgot-password', { body: { email: mail('bob') } });
      const resetToken = await (async () => { for (let i = 0; i < 100; i++) { const m = fs.readdirSync(OUTBOX).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8'))).find((x) => x.to === mail('bob')); if (m) return /#token=([A-Za-z0-9_-]{43})/.exec(m.text)[1]; await sleep(50); } return null; })();
      const rs = await call('POST', '/auth/reset-password', { body: { token: resetToken, newPassword: 'ResetPassword789!' } });
      check('password reset -> all bob devices revoked', fg.status === 202 && rs.status === 204 && (await activeFor('user_id = $1', [ids.bob])) === 0 && (await svc.findSendTargets(ids.bob)).length === 0);

      const O = await login('owner');
      await reg(O, fid(), 'FID', 'ANDROID');
      const sus = await call('PATCH', `/admin/users/${ids.owner}/suspend`, { token: admin.token });
      check('suspension -> devices revoked; no send targets', sus.status === 200 && (await activeFor('user_id = $1', [ids.owner])) === 0 && (await svc.findSendTargets(ids.owner)).length === 0);
      await call('PATCH', `/admin/users/${ids.owner}/reactivate`, { token: admin.token });
      check('reactivation does not resurrect devices (client must register again)', (await activeFor('user_id = $1', [ids.owner])) === 0);
    }

    section('6. Account switching on a shared browser');
    {
      const shared = fid();
      const SA = await login('alice');
      await reg(SA, shared);
      await call('POST', '/auth/logout', { token: SA.token });
      const SB = await login('bob', 'ResetPassword789!');
      const rB = await reg(SB, shared);
      check('A logs out, B logs in on the same browser and registers the same FID -> CREATED for B; A has no association', rB.body.result === 'CREATED' && (await activeFor('user_id = $1', [ids.alice])) === 0 && (await svc.findSendTargets(ids.bob)).some((t) => t.registrationValue === shared));
      check("A's delayed request after logout cannot reclaim (401)", (await reg(SA, shared)).status === 401);

      const shared2 = fid();
      const SA2 = await login('alice');
      const ra = await reg(SA2, shared2);
      const SB2 = await login('bob', 'ResetPassword789!');
      const rb2 = await reg(SB2, shared2);
      const aRow = await rowOf(ra.body.device.id);
      const stale = await reg(SA2, shared2);
      check('B registers an installation still active for A (A never logged out) -> TRANSFERRED; A\'s row revoked (TRANSFERRED)', rb2.body.result === 'TRANSFERRED' && aRow.revocation_reason === 'TRANSFERRED');
      check("A's stale request (A's session still alive) cannot reclaim it -> 409 REGISTRATION_TRANSFERRED; B keeps it", stale.status === 409 && stale.body.code === 'REGISTRATION_TRANSFERRED' && (await svc.findSendTargets(ids.bob)).some((t) => t.registrationValue === shared2) && !(await svc.findSendTargets(ids.alice)).some((t) => t.registrationValue === shared2), stale.body);
      const nA = await inbox.create({ recipientUserId: ids.alice, type: 'SYSTEM_ANNOUNCEMENT', title: 'For alice', body: 'Inbox survives device changes.' });
      await call('POST', '/auth/logout-all', { token: SA2.token });
      const SA3 = await login('alice');
      const inboxA = await call('GET', '/notifications', { token: SA3.token });
      check("A's inbox notifications are untouched by transfers/logouts and stay readable after a new login", inboxA.status === 200 && inboxA.body.items.some((n) => n.id === nA.notification.id));
      check('inbox works without any push registration', (await activeFor('user_id = $1', [ids.alice])) === 0 && (await call('GET', '/notifications/unread-count', { token: SA3.token })).status === 200);
      await call('POST', '/auth/logout-all', { token: SB.token });
    }

    section('7. Races (real transactions, two instances)');
    const rounds = async (label, n, body) => { const out = []; let ok = true; for (let i = 0; i < n; i++) { const r = await body(i); ok &&= r.ok; out.push(r.detail); } evidence[label] = out; return ok; };
    const jitter = (i) => sleep((i % 4) * 4);
    // Password change/reset spend ~0.3-0.8 s in bcrypt before their transaction: odd rounds delay the
    // registration so that BOTH commit orders occur (register first -> revoked by trigger; revoke first -> 401).
    const lateOnOdd = (i) => sleep(i % 2 ? 1500 : (i % 4) * 4);
    const fresh = async (n) => { const id = (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, 'CUSTOMER', 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), hash])).id; return id; };

    check('two accounts registering one installation concurrently (10 each, 2 instances, 4 rounds): never 2 active rows; no 5xx', await rounds('twoAccountsSameFid', 4, async (i) => {
      const u1 = await fresh(`ra${i}`); const u2 = await fresh(`rb${i}`);
      const s1 = await login(`ra${i}`); const s2 = await login(`rb${i}`);
      const v = fid();
      const rs = await Promise.all(Array.from({ length: 20 }, (_, k) => sleep(k % 3).then(() => reg(k % 2 ? s1 : s2, v, 'FID', 'WEB', PORTS[k % 2]))));
      const active = await one(`select count(*)::int c, max(user_id)::text u from push_devices where revoked_at is null and registration_hash = (select registration_hash from push_devices where user_id in ($1, $2) order by id limit 1)`, [u1, u2]);
      return { ok: active.c === 1 && rs.every((r) => [200, 409].includes(r.status)), detail: { statuses: tally(rs), active: active.c, owner: active.u === u1 ? 'first' : 'second' } };
    }), evidence.twoAccountsSameFid);

    const raceSession = async (label, revoke, delayRegister = jitter) => rounds(label, 6, async (i) => {
      const n = `${label}${i}`; const u = await fresh(n); const s = await login(n); const other = await login(n);
      const [r, x] = await Promise.all([delayRegister(i).then(() => reg(s, fid(), 'FID', 'WEB', PORTS[i % 2])), jitter(i + 2).then(() => revoke(s, other, u, i))]);
      const live = await activeFor('user_id = $1', [u]);
      return { ok: [200, 401].includes(r.status) && x && live === 0, detail: { register: r.status, revoke: x, activeAfter: live } };
    });
    check('registration racing logout (6 rounds): never an active device for the revoked session', await raceSession('rlo', async (s) => (await call('POST', '/auth/logout', { token: s.token, port: PORTS[1] })).status === 204), evidence.rlo);
    check('registration racing logout-all (6 rounds): no active device survives', await raceSession('rla', async (s, other) => (await call('POST', '/auth/logout-all', { token: other.token, port: PORTS[1] })).status === 204), evidence.rla);
    check('registration racing password change (6 rounds): no active device survives', await raceSession('rpc', async (s, other) => (await call('POST', '/auth/change-password', { token: other.token, body: { currentPassword: PASSWORD, newPassword: 'Changed123456!' }, port: PORTS[1] })).status === 204, lateOnOdd), evidence.rpc);
    check('registration racing suspension (6 rounds): no active device for the suspended user', await raceSession('rsu', async (s, other, u) => (await call('PATCH', `/admin/users/${u}/suspend`, { token: admin.token, port: PORTS[1] })).status === 200), evidence.rsu);
    check('password change race exercised both commit orders (200 then revoked, and 401)', new Set(evidence.rpc.map((e) => e.register)).size === 2, evidence.rpc);
    check('registration racing password reset (6 rounds): no active device survives', await rounds('rrs', 6, async (i) => {
      const n = `rrs${i}`; const u = await fresh(n); const s = await login(n);
      await call('POST', '/auth/forgot-password', { body: { email: mail(n) } });
      let token = null; for (let k = 0; k < 100 && !token; k++) { const m = fs.readdirSync(OUTBOX).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8'))).find((x) => x.to === mail(n)); token = m ? /#token=([A-Za-z0-9_-]{43})/.exec(m.text)[1] : null; if (!token) await sleep(50); }
      const [r, x] = await Promise.all([lateOnOdd(i).then(() => reg(s, fid(), 'FID', 'WEB', PORTS[i % 2])), jitter(i + 1).then(() => call('POST', '/auth/reset-password', { body: { token, newPassword: 'Reset123456!' }, port: PORTS[1] }))]);
      const live = await activeFor('user_id = $1', [u]);
      return { ok: x.status === 204 && [200, 401].includes(r.status) && live === 0, detail: { register: r.status, reset: x.status, activeAfter: live } };
    }), evidence.rrs);

    check('password reset race exercised both commit orders', new Set(evidence.rrs.map((e) => e.register)).size === 2, evidence.rrs);

    section('8. Invalid / stale destinations (internal API for P3-BE06)');
    {
      const u = await fresh('inv'); const s = await login('inv');
      const r1 = await reg(s, fid());
      const attemptedAt = new Date();
      await sleep(30);
      const [rot, inv] = await Promise.all([reg(s, fid()), svc.markInvalid(r1.body.device.id, attemptedAt)]);
      check('rotation racing invalidation of the OLD id: the new registration stays active', rot.body.result === 'ROTATED' && (await rowOf(rot.body.device.id)).revoked_at === null && (await activeFor('user_id = $1', [u])) === 1, { rot: rot.body.result, inv });
      const cur = rot.body.device.id;
      const sentAt = new Date(Date.now() - 1000);
      await reg(s, (await svc.findSendTargets(u))[0].registrationValue); // client refreshed after the send attempt
      const late = await svc.markInvalid(cur, sentAt);
      check('a delivery failure observed for a send attempted BEFORE the latest refresh does not revoke it', late.revoked === false && (await rowOf(cur)).revoked_at === null);
      const now = await svc.markInvalid(cur, new Date());
      const twice = await svc.markInvalid(cur, new Date());
      check('UNREGISTERED for the current registration -> revoked INVALID_REGISTRATION; idempotent; other users unaffected', now.revoked && !twice.revoked && (await rowOf(cur)).revocation_reason === 'INVALID_REGISTRATION' && (await svc.findSendTargets(ids.bob)).length >= 0);
      const s2 = await login('inv');
      const r2 = await reg(s2, fid());
      await db.query(`alter table push_devices disable trigger trg_push_devices_guard_update`);
      await db.query(`update push_devices set registered_at = now() - interval '40 days', last_seen_at = now() - interval '40 days' where id = $1`, [r2.body.device.id]);
      await db.query(`alter table push_devices enable trigger trg_push_devices_guard_update`);
      const staleList = await call('GET', '/push-devices', { token: s2.token });
      check('stale policy (30 days): a device not seen for 40 days is flagged stale and excluded from send targets', staleList.body[0]?.stale === true && !(await svc.findSendTargets(u)).some((t) => t.deviceId === r2.body.device.id));
      const n = await svc.revokeStale();
      check('revokeStale() revokes it (STALE); a fresh registration of that session brings it back as a new row', n >= 1 && (await rowOf(r2.body.device.id)).revocation_reason === 'STALE' && (await reg(s2, fid())).body.result === 'CREATED');
    }

    section('9. Invariants, privacy, logs');
    const inv = await one(`select
      (select count(*)::int from (select 1 from push_devices where revoked_at is null group by registration_kind, registration_hash having count(*) > 1) x) multi_active_destination,
      (select count(*)::int from (select 1 from push_devices where revoked_at is null group by auth_session_id having count(*) > 1) x) multi_active_session,
      (select count(*)::int from push_devices d join auth_sessions s on s.id = d.auth_session_id where d.revoked_at is null and s.revoked_at is not null) active_on_revoked_session,
      (select count(*)::int from push_devices d join users u on u.id = d.user_id where d.revoked_at is null and u.status <> 'ACTIVE') active_of_inactive_users,
      (select count(*)::int from push_devices d join auth_sessions s on s.id = d.auth_session_id where s.user_id <> d.user_id) owner_mismatch,
      (select deadlocks::int from pg_stat_database where datname = current_database()) deadlocks`);
    evidence.invariants = inv;
    check('<=1 active row per destination and per session; none on revoked sessions or inactive users; owner = session owner; 0 deadlocks', Object.values(inv).every((v) => v === 0), inv);
    check('no HTTP 500 in any response', !statuses.includes(500), tally(statuses.map((s) => ({ status: s }))));
    const stored = (await db.query('select registration_ciphertext c from push_devices')).rows.map((r) => r.c).join('\n');
    check(`no registration value (${seenValues.length} generated) is stored in clear text`, seenValues.every((v) => !stored.includes(v)));
    const logs = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(`app-${NAME}-`)).map((f) => fs.readFileSync(path.join(OUT_DIR, f), 'utf8')).join('\n');
    check('application logs contain no FID / token values and no JWT secret; lifecycle logged with reg#<hash prefix>', seenValues.every((v) => !logs.includes(v)) && !logs.includes(JWT_SECRET) && /Push device (created|refreshed|transferred) \(device \d+, FID, WEB, reg#[0-9a-f]{8}\)/.test(logs));
  } finally {
    if (app) await app.stop();
    if (ds?.isInitialized) await ds.destroy();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }
}

main()
  .catch((error) => check('harness completed without errors', false, error.stack))
  .finally(() => {
    const failed = results.filter((r) => !r.pass).length;
    fs.writeFileSync(path.join(OUT_DIR, 'push-devices-results.json'), JSON.stringify({ results, evidence }, null, 2));
    console.log('\nEVIDENCE', JSON.stringify(evidence));
    console.log(`OUT_DIR ${OUT_DIR}`);
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed}  FAIL ${failed}  SKIPPED 0`);
    process.exitCode = failed ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  });
