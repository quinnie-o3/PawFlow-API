/*
 * P3-BE10 admin audit atomicity: real HTTP + real PostgreSQL on a
 * disposable QA database only (pawflow_qa_*). Two API instances.
 *
 *   npm run build
 *   npm run qa:admin-audit-atomicity
 *
 * Every one of the 19 audited admin actions (ADMIN_ACTIVITY_ACTIONS) goes
 * through the same protocol, each step asserted on the HTTP response AND on
 * PostgreSQL (business row + admin_activity_logs):
 *   a. non-admin and anonymous callers -> 403 / 401: state unchanged, no row;
 *   b. FAULT: a QA-only trigger makes the audit INSERT fail inside the
 *      admin transaction (after the business write) -> 500 with the generic
 *      body; business state rolled back (incl. revoked sessions for
 *      USER_SUSPENDED: the user's token still works); no row;
 *   c. success -> exactly one row: authenticated actor, action, target,
 *      metadata.requestId = the response X-Request-ID; state changed;
 *   d. repeat -> 409 (or 200 with no row for an unchanged UPDATE): no row;
 *   e. RACE: 6 identical requests on a fresh target, split over both
 *      instances and two admins -> exactly one success (the rest 409, or
 *      200 no-ops for UPDATE), exactly one row, carrying the winner's
 *      requestId and actor.
 * Outcome sets do not depend on scheduling, so no sleeps or ordering
 * assumptions are needed. Triggers are created and dropped by this run in
 * its own QA database.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_admin_audit), QA_PORTS
 * (default 8351,8352), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, prepareDatabase, dropDatabase, createApp, createApi } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_admin_audit';
const PORTS = (process.env.QA_PORTS ?? '8351,8352').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-admin-audit-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaAdminAudit123!';
const RUN = 'aa' + Date.now().toString(36);
const RACERS = 6;

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 1200)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const apps = [];
  const api = createApi(PORTS);
  const call = async (method, url, opts = {}) => {
    const r = await api(method, url, opts);
    return { ...r, requestId: r.headers.get('x-request-id') };
  };
  const mail = (n) => `${n}.${RUN}@qa.test`;
  let seq = 0;
  const uniq = (p) => `${p} ${RUN} ${++seq}`;

  try {
    section('0. Schema');
    check('17 migrations applied, 0 pending DDL', migrations.length === 17 && pendingDdl.length === 0, { count: migrations.length, pendingDdl });

    // ------------------------------------------------------------- seed
    const hash = await bcrypt.hash(PASSWORD, 10);
    const newUser = async (n, role, status = 'ACTIVE') => (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, $4, $5) returning id::text id`, [`QA ${n}`, mail(n), hash, role, status])).id;
    const ids = { admin: await newUser('admin', 'ADMIN'), admin2: await newUser('admin2', 'ADMIN'), cust: await newUser('cust', 'CUSTOMER') };
    const petType = (await one(`insert into pet_types(name) values ($1) returning id::text id`, [uniq('Cat')])).id;
    const category = (await one(`insert into service_categories(name) values ($1) returning id::text id`, [uniq('Spa')])).id;
    const pet = (await one(`insert into pets(owner_id, pet_type_id, name) values ($1, $2, 'QA pet') returning id::text id`, [ids.cust, petType])).id;

    const newProvider = async (status) => {
      const owner = await newUser(`owner${++seq}`, 'PROVIDER_OWNER');
      return (await one(`insert into providers(owner_id, business_name, address, approval_status) values ($1, $2, 'QA road', $3) returning id::text id`, [owner, uniq('QA Audit'), status])).id;
    };
    // A completed booking of a fresh approved provider, for reviews and complaints.
    const newCompletedBooking = async () => {
      const provider = await newProvider('APPROVED');
      const service = (await one(`insert into services(provider_id, category_id, name, price, duration_minutes) values ($1, $2, 'Bath', 50000, 30) returning id::text id`, [provider, category])).id;
      const slot = (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity, booked_count) values ($1, $2, current_date - 1, '08:00', '09:00', 10, 1) returning id::text id`, [provider, service])).id;
      const booking = (await one(`insert into bookings(customer_id, pet_id, provider_id, service_id, slot_id, status, booked_price) values ($1, $2, $3, $4, $5, 'COMPLETED', 50000) returning id::text id`, [ids.cust, pet, provider, service, slot])).id;
      await db.query(`insert into booking_status_logs(booking_id, old_status, new_status) values ($1, null, 'COMPLETED')`, [booking]);
      return { provider, booking };
    };
    const newReview = async (visible) => {
      const { provider, booking } = await newCompletedBooking();
      const review = (await one(`insert into reviews(booking_id, rating, comment, is_visible) values ($1, 4, 'QA review', $2) returning id::text id`, [booking, visible])).id;
      await db.query(`update providers set rating_count = $2, rating_avg = $3 where id = $1`, [provider, visible ? 1 : 0, visible ? '4.00' : '0.00']);
      return review;
    };
    const newComplaint = async (status) => {
      const { booking } = await newCompletedBooking();
      return (await one(`insert into complaints(booking_id, created_by, reason, status) values ($1, $2, 'QA complaint', $3) returning id::text id`, [booking, ids.cust, status])).id;
    };
    const newMaster = async (table, status) => (await one(`insert into ${table}(name, status) values ($1, $2) returning id::text id`, [uniq(table), status])).id;
    // A customer with a live session (USER_* actions must revoke/keep it correctly).
    const sessionTokens = {};
    const newUserWithSession = async (status) => {
      const n = `target${++seq}`;
      const id = await newUser(n, 'CUSTOMER');
      const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`);
      sessionTokens[id] = r.body.accessToken;
      if (status === 'SUSPENDED') await db.query(`update users set status = 'SUSPENDED' where id = $1`, [id]);
      return id;
    };

    const providerState = async (id) => one(`select approval_status s from providers where id = $1`, [id]);
    const reviewState = async (id) => one(`select r.is_visible v, p.rating_count c, p.rating_avg a from reviews r join bookings b on b.id = r.booking_id join providers p on p.id = b.provider_id where r.id = $1`, [id]);
    const complaintState = async (id) => one(`select status s, admin_note n, resolved_by::text rb, resolved_at is not null ra from complaints where id = $1`, [id]);
    const masterState = (table) => async (id) => one(`select name, status s from ${table} where id = $1`, [id]);
    const userState = async (id) => one(`select u.status s, (select count(*)::int from auth_sessions a where a.user_id = u.id and a.revoked_at is null) live from users u where u.id = $1`, [id]);

    const providerAction = (action, from, to, verb) => ({ action, targetType: 'PROVIDER', setup: () => newProvider(from), request: (id) => ['PATCH', `/admin/providers/${id}/${verb}`, undefined], state: providerState, changed: (s) => s.s === to });
    const masterActions = (prefix, table, route, targetType) => [
      { action: `${prefix}_CREATED`, targetType, create: true, setup: async () => uniq(`${table} new`), request: (name) => ['POST', `/admin/${route}`, { name }], state: async (name) => one(`select count(*)::int n, min(id)::text id, min(status) s from ${table} where name = $1`, [name]), changed: (s) => s.n === 1 && s.s === 'ACTIVE', unchanged: (s) => s.n === 0, repeatStatus: 409 },
      { action: `${prefix}_UPDATED`, targetType, setup: () => newMaster(table, 'ACTIVE'), request: (id) => ['PATCH', `/admin/${route}/${id}`, { name: `renamed ${table} ${id} ${RUN}` }], state: masterState(table), changed: (s) => s.name.startsWith('renamed '), repeatStatus: 200 },
      { action: `${prefix}_ACTIVATED`, targetType, setup: () => newMaster(table, 'INACTIVE'), request: (id) => ['PATCH', `/admin/${route}/${id}/activate`, undefined], state: masterState(table), changed: (s) => s.s === 'ACTIVE' },
      { action: `${prefix}_DEACTIVATED`, targetType, setup: () => newMaster(table, 'ACTIVE'), request: (id) => ['PATCH', `/admin/${route}/${id}/deactivate`, undefined], state: masterState(table), changed: (s) => s.s === 'INACTIVE' },
    ];
    const ACTIONS = [
      providerAction('PROVIDER_APPROVED', 'PENDING', 'APPROVED', 'approve'),
      providerAction('PROVIDER_REJECTED', 'PENDING', 'REJECTED', 'reject'),
      providerAction('PROVIDER_SUSPENDED', 'APPROVED', 'SUSPENDED', 'suspend'),
      providerAction('PROVIDER_REACTIVATED', 'SUSPENDED', 'APPROVED', 'reactivate'),
      { action: 'REVIEW_HIDDEN', targetType: 'REVIEW', setup: () => newReview(true), request: (id) => ['PATCH', `/admin/reviews/${id}/hide`, undefined], state: reviewState, changed: (s) => s.v === false && s.c === 0 },
      { action: 'REVIEW_RESTORED', targetType: 'REVIEW', setup: () => newReview(false), request: (id) => ['PATCH', `/admin/reviews/${id}/restore`, undefined], state: reviewState, changed: (s) => s.v === true && s.c === 1 },
      { action: 'COMPLAINT_MARKED_IN_REVIEW', targetType: 'COMPLAINT', setup: () => newComplaint('OPEN'), request: (id) => ['PATCH', `/admin/complaints/${id}/review`, {}], state: complaintState, changed: (s) => s.s === 'IN_REVIEW' },
      { action: 'COMPLAINT_RESOLVED', targetType: 'COMPLAINT', setup: () => newComplaint('IN_REVIEW'), request: (id) => ['PATCH', `/admin/complaints/${id}/resolve`, { adminNote: 'Refunded' }], state: complaintState, changed: (s) => s.s === 'RESOLVED' && s.n === 'Refunded' && s.ra },
      { action: 'COMPLAINT_REJECTED', targetType: 'COMPLAINT', setup: () => newComplaint('IN_REVIEW'), request: (id) => ['PATCH', `/admin/complaints/${id}/reject`, { adminNote: 'Unfounded' }], state: complaintState, changed: (s) => s.s === 'REJECTED' && s.ra },
      ...masterActions('SERVICE_CATEGORY', 'service_categories', 'service-categories', 'SERVICE_CATEGORY'),
      ...masterActions('PET_TYPE', 'pet_types', 'pet-types', 'PET_TYPE'),
      { action: 'USER_SUSPENDED', targetType: 'USER', setup: () => newUserWithSession('ACTIVE'), request: (id) => ['PATCH', `/admin/users/${id}/suspend`, undefined], state: userState, changed: (s) => s.s === 'SUSPENDED' && s.live === 0 },
      { action: 'USER_REACTIVATED', targetType: 'USER', setup: () => newUserWithSession('SUSPENDED'), request: (id) => ['PATCH', `/admin/users/${id}/reactivate`, undefined], state: userState, changed: (s) => s.s === 'ACTIVE' },
    ];
    const expected = require(path.join(ROOT, 'dist', 'admin', 'admin-activity-log.constants.js')).ADMIN_ACTIVITY_ACTIONS;

    for (const port of PORTS) { const app = createApp(NAME, [port], { logDir: OUT_DIR, jwtSecret: JWT_SECRET }); await app.start(); apps.push(app); }
    const login = async (id) => {
      const email = (await one(`select email from users where id = $1`, [id])).email;
      const r = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login ${id}: ${r.status}`);
      return r.body.accessToken;
    };
    const T = { admin: await login(ids.admin), admin2: await login(ids.admin2), cust: await login(ids.cust) };
    check(`the protocol covers all ${expected.length} audited actions`, expected.length === ACTIONS.length && expected.every((a) => ACTIONS.some((x) => x.action === a)), { expected, covered: ACTIONS.map((a) => a.action) });

    const rowsFor = async (spec, target) => (await db.query(
      spec.create
        ? `select l.id::text id, l.admin_user_id::text admin, l.action, l.target_type tt, l.target_id::text target, l.metadata from admin_activity_logs l where l.action = $1 and l.target_id in (select id from ${spec.action.startsWith('PET') ? 'pet_types' : 'service_categories'} where name = $2) order by l.id`
        : `select l.id::text id, l.admin_user_id::text admin, l.action, l.target_type tt, l.target_id::text target, l.metadata from admin_activity_logs l where l.action = $1 and l.target_id = $2 order by l.id`,
      [spec.action, target],
    )).rows;
    const totalRows = async () => (await one(`select count(*)::int c from admin_activity_logs`)).c;
    const send = (spec, target, token, extra = {}) => { const [m, u, body] = spec.request(target); return call(m, u, { token, body, ...extra }); };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const fn = `qa_fail_audit_${RUN}`;

    for (const spec of ACTIONS) {
      section(spec.action);
      const target = await spec.setup();
      const initial = await spec.state(target);
      const unchanged = (s) => (spec.unchanged ? spec.unchanged(s) : same(s, initial));

      // a. unauthorized
      const forbidden = await send(spec, target, T.cust);
      const anon = await send(spec, target, undefined);
      check(`a. customer -> 403, anonymous -> 401; state unchanged, no audit row`, forbidden.status === 403 && anon.status === 401 && unchanged(await spec.state(target)) && (await rowsFor(spec, target)).length === 0, { forbidden: forbidden.status, anon: anon.status });

      // b. fault injection inside the admin transaction
      await db.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if new.action = '${spec.action}' then raise exception 'qa injected audit failure'; end if; return new; end $$`);
      await db.query(`create trigger ${fn} before insert on admin_activity_logs for each row execute function ${fn}()`);
      const before = await totalRows();
      let faulted;
      try {
        faulted = await send(spec, target, T.admin, { headers: { 'X-Request-ID': `qa-fault-${spec.action}-${RUN}` } });
      } finally {
        await db.query(`drop trigger ${fn} on admin_activity_logs`);
        await db.query(`drop function ${fn}()`);
      }
      const afterFault = await spec.state(target);
      const tokenAlive = spec.action === 'USER_SUSPENDED' ? (await call('GET', '/auth/me', { token: sessionTokens[target] })).status : 'n/a';
      check(`b. injected audit failure -> 500 generic body + X-Request-ID; business change rolled back${spec.action === 'USER_SUSPENDED' ? ' (sessions not revoked: token still 200)' : ''}; no row`,
        faulted.status === 500 && same(faulted.body, { statusCode: 500, message: 'Internal server error' }) && faulted.requestId === `qa-fault-${spec.action}-${RUN}` && unchanged(afterFault) && (await totalRows()) === before && (spec.action !== 'USER_SUSPENDED' || tokenAlive === 200),
        { status: faulted.status, body: faulted.body, afterFault, initial, tokenAlive });

      // c. success
      const rid = `qa-ok-${spec.action.toLowerCase()}-${RUN}`;
      const ok = await send(spec, target, T.admin, { headers: { 'X-Request-ID': rid } });
      const rows = await rowsFor(spec, target);
      const targetId = spec.create ? String(ok.body?.id) : target;
      check(`c. success ${ok.status} -> exactly one row (actor = authenticated admin, action, target, metadata.requestId = response header); state changed`,
        [200, 201].includes(ok.status) && ok.requestId === rid && rows.length === 1 && rows[0].admin === ids.admin && rows[0].action === spec.action && rows[0].tt === spec.targetType && rows[0].target === targetId && rows[0].metadata?.requestId === rid && spec.changed(await spec.state(target)),
        { status: ok.status, body: ok.body, rows, state: await spec.state(target) });

      // d. repeat
      const afterOk = await spec.state(target);
      const repeat = await send(spec, target, T.admin);
      const repeatStatus = spec.repeatStatus ?? 409;
      check(`d. repeat -> ${repeatStatus}${repeatStatus === 200 ? ' (unchanged update)' : ''}; no new row; state unchanged`, repeat.status === repeatStatus && (await rowsFor(spec, target)).length === 1 && same(await spec.state(target), afterOk), { status: repeat.status, rows: (await rowsFor(spec, target)).length });

      // e. race on a fresh target
      const raceTarget = await spec.setup();
      const racers = await Promise.all(Array.from({ length: RACERS }, (_, i) => send(spec, raceTarget, i % 2 ? T.admin2 : T.admin, { port: PORTS[i % 2], headers: { 'X-Request-ID': `qa-race-${spec.action.toLowerCase()}-${i}-${RUN}` } })));
      const raceRows = await rowsFor(spec, raceTarget);
      const statuses = racers.map((r) => r.status).sort().join(',');
      const winners = spec.repeatStatus === 200
        ? racers.filter((r) => raceRows[0] && r.requestId === raceRows[0].metadata?.requestId)
        : racers.filter((r) => [200, 201].includes(r.status));
      const expectStatuses = spec.repeatStatus === 200 ? Array(RACERS).fill(200).join(',') : [spec.create ? 201 : 200, ...Array(RACERS - 1).fill(409)].sort().join(',');
      const winnerIndex = racers.indexOf(winners[0]);
      check(`e. ${RACERS} concurrent identical requests on 2 instances -> statuses [${expectStatuses}], exactly one row with the winner's requestId and actor; state changed once`,
        statuses === expectStatuses && raceRows.length === 1 && winners.length === 1 && raceRows[0].admin === (winnerIndex % 2 ? ids.admin2 : ids.admin) && spec.changed(await spec.state(raceTarget)),
        { statuses, raceRows, winners: winners.length });
    }

    section('Global');
    {
      const nonJson = await one(`select count(*)::int c from admin_activity_logs where metadata is null or not (metadata ? 'requestId')`);
      check('every audit row written through the API carries metadata.requestId', nonJson.c === 0, nonJson);
      const actors = await one(`select count(*)::int c from admin_activity_logs l join users u on u.id = l.admin_user_id where u.role <> 'ADMIN'`);
      check('every audit row is attributed to an ADMIN account', actors.c === 0, actors);
      const expectedRows = ACTIONS.length * 2; // c + e per action
      check(`exactly ${expectedRows} audit rows in total (one per successful action, none from faults, repeats or races)`, (await totalRows()) === expectedRows, await totalRows());
      const leftovers = await one(`select count(*)::int c from pg_trigger where tgname like 'qa_fail_audit_%'`);
      check('no fault-injection trigger left behind', leftovers.c === 0, leftovers);
    }
  } finally {
    for (const app of apps) await app.stop();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed  (out: ${OUT_DIR})`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('QA run aborted:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
