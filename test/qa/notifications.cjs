/*
 * P3-BE04 notification inbox — real HTTP + real PostgreSQL (disposable QA database only).
 *
 *   npm run build
 *   npm run qa:notifications
 *
 * Fixtures are created through the compiled NotificationsService
 * (dist/notifications/notifications.service.js) on the QA database, the
 * same internal API P3-BE06 will use; there is no public create endpoint.
 * Two API instances. Environment: QA_DB_NAME, QA_PORTS (default 8181,8182),
 * QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_notifications';
const PORTS = (process.env.QA_PORTS ?? '8181,8182').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-notif-'));
const PASSWORD = 'QaPassword123!';
const RUN = 'n' + Date.now().toString(36);
const NEW_MIGRATION = 'CreateNotifications1795500000000';
const VIEW_KEYS = 'body,createdAt,id,isRead,payload,readAt,target,title,type';

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 500)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  let app = null;
  let ds = null;
  try {
    // ------------------------------------------------------------ schema
    section('0. Schema, constraints, immutability trigger, migration rehearsal');
    check(`all ${migrations.length} source migrations applied (last = CreateNotifications), 0 pending DDL`, migrations.length === sourceMigrationCount() && migrations.at(-1) === NEW_MIGRATION && pendingDdl.length === 0, { migrations, pendingDdl });
    ds = new DataSource({
      type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false,
      entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')],
    });
    await ds.initialize();
    await ds.undoLastMigration({ transaction: 'each' });
    const dropped = (await one(`select to_regclass('notifications') t, (select count(*)::int from pg_proc where proname = 'notifications_guard_update') f`));
    const again = await ds.runMigrations({ transaction: 'each' });
    const pendingAgain = (await ds.driver.createSchemaBuilder().log()).upQueries.length;
    check('down drops table + trigger function; up again -> 0 pending DDL', dropped.t === null && dropped.f === 0 && again.length === 1 && again[0].name === NEW_MIGRATION && pendingAgain === 0, { dropped, pendingAgain });
    const idx = (await db.query(`select indexname, indexdef from pg_indexes where tablename = 'notifications'`)).rows;
    check('indexes: (recipient_user_id, id DESC) and partial unread (… ) WHERE read_at IS NULL, unique (recipient, event_key)', idx.some((i) => i.indexname === 'idx_notifications_recipient_id' && /recipient_user_id, id DESC/.test(i.indexdef)) && idx.some((i) => i.indexname === 'idx_notifications_recipient_unread' && /WHERE \(read_at IS NULL\)/.test(i.indexdef)) && idx.some((i) => i.indexname === 'uq_notifications_recipient_event'), idx.map((i) => i.indexname));

    const { NotificationsService, NotificationRecipientNotFoundError } = require(path.join(ROOT, 'dist', 'notifications', 'notifications.service.js'));
    const { NotificationInputError } = require(path.join(ROOT, 'dist', 'notifications', 'notification-types.js'));
    const svc = new NotificationsService(ds);

    // ------------------------------------------------------------ accounts
    const app0 = createApp(NAME, PORTS, { logDir: OUT_DIR });
    app = app0;
    await app.start();
    const api = createApi(PORTS);
    const statuses = [];
    const call = async (method, url, opts) => { const r = await api(method, url, opts); statuses.push(r.status); return r; };
    const mail = (n) => `${n}.${RUN}@qa.test`;
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mkUser = async (n, role) => (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, $4, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), hash, role])).id;
    const ids = { alice: await mkUser('alice', 'CUSTOMER'), bob: await mkUser('bob', 'CUSTOMER'), owner: await mkUser('owner', 'PROVIDER_OWNER'), admin: await mkUser('admin', 'ADMIN') };
    const login = async (n) => (await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } })).body;
    const tok = { alice: (await login('alice')).accessToken, bob: (await login('bob')).accessToken, owner: (await login('owner')).accessToken, admin: (await login('admin')).accessToken };

    const types = ['BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_COMPLETED', 'PAYMENT_STATUS_CHANGED'];
    const make = (recipientUserId, i, extra = {}) => ({ recipientUserId, type: types[i % types.length], title: `Booking update #${i}`, body: `Booking ${1000 + i} changed.`, payload: { bookingCode: `B-${1000 + i}`, slot: '09:00' }, target: { type: 'BOOKING', id: String(1000 + i) }, eventKey: `qa:${recipientUserId}:${i}`, ...extra });
    for (let i = 0; i < 30; i++) await svc.create(make(ids.alice, i));
    for (let i = 0; i < 5; i++) await svc.create(make(ids.bob, i));
    for (let i = 0; i < 3; i++) await svc.create({ ...make(ids.owner, i), type: 'BOOKING_CREATED' });
    await svc.create({ recipientUserId: ids.admin, type: 'SYSTEM_ANNOUNCEMENT', title: 'Maintenance', body: 'Planned maintenance tonight.' });
    const dbUnread = async (uid) => (await one(`select count(*)::int c from notifications where recipient_user_id = $1 and read_at is null`, [uid])).c;

    section('0b. Database-level integrity');
    const rejects = async (sql, params) => db.query(sql, params).then(() => null, (e) => e.message);
    const aliceFirst = (await one(`select id::text id from notifications where recipient_user_id = $1 order by id limit 1`, [ids.alice])).id;
    const dbErrors = {
      changeRecipient: await rejects(`update notifications set recipient_user_id = $2 where id = $1`, [aliceFirst, ids.bob]),
      changeTitle: await rejects(`update notifications set title = 'x' where id = $1`, [aliceFirst]),
      badType: await rejects(`insert into notifications(recipient_user_id, type, title, body) values ($1, 'X', 't', 'b')`, [ids.alice]),
      halfTarget: await rejects(`insert into notifications(recipient_user_id, type, title, body, target_type) values ($1, 'BOOKING_CREATED', 't', 'b', 'BOOKING')`, [ids.alice]),
      payloadArray: await rejects(`insert into notifications(recipient_user_id, type, title, body, payload) values ($1, 'BOOKING_CREATED', 't', 'b', '[]')`, [ids.alice]),
      blankTitle: await rejects(`insert into notifications(recipient_user_id, type, title, body) values ($1, 'BOOKING_CREATED', '  ', 'b')`, [ids.alice]),
      unknownRecipient: await rejects(`insert into notifications(recipient_user_id, type, title, body) values (999999999, 'BOOKING_CREATED', 't', 'b')`),
    };
    check('DB rejects: owner change, content change, unknown type, half target, non-object payload, blank title, unknown recipient', Object.values(dbErrors).every((e) => e !== null) && /immutable/.test(dbErrors.changeRecipient), dbErrors);
    await db.query(`update notifications set read_at = now() where id = $1`, [aliceFirst]);
    const reread = await rejects(`update notifications set read_at = null where id = $1`, [aliceFirst]);
    check('read_at can be set once (NULL -> timestamp) but never changed or cleared afterwards', /cannot change once set/.test(reread ?? ''), reread);

    // ------------------------------------------------------------ auth
    section('1. Authentication and sessions');
    const endpoints = [['GET', '/notifications'], ['GET', '/notifications/unread-count'], ['GET', `/notifications/${aliceFirst}`], ['PATCH', `/notifications/${aliceFirst}/read`], ['PATCH', '/notifications/read-all']];
    const anon = await Promise.all(endpoints.map(([m, u]) => call(m, u)));
    const garbage = await Promise.all(endpoints.map(([m, u]) => call(m, u, { token: 'not.a.jwt' })));
    check('anonymous or garbage token -> 401 on all 5 endpoints', anon.every((r) => r.status === 401) && garbage.every((r) => r.status === 401));
    const tmp = await login('alice');
    await call('POST', '/auth/logout', { token: tmp.accessToken });
    check('token of a revoked (logged-out) session -> 401', (await call('GET', '/notifications', { token: tmp.accessToken })).status === 401);

    // ------------------------------------------------------------ list
    section('2. Listing, pagination, filters');
    const p1 = await call('GET', '/notifications?limit=10', { token: tok.alice });
    const ids1 = p1.body.items.map((n) => BigInt(n.id));
    check('page 1: 10 newest first (ids strictly descending), totals 30, query.maxId = newest id, status=all', p1.status === 200 && p1.body.items.length === 10 && ids1.every((v, i) => i === 0 || ids1[i - 1] > v) && p1.body.meta.totalItems === 30 && p1.body.meta.totalPages === 3 && p1.body.query.status === 'all' && p1.body.query.maxId === p1.body.items[0].id, { meta: p1.body.meta, query: p1.body.query, ids: p1.body.items.map((n) => n.id) });
    check('item shape = exactly the documented public fields (no recipient id, no event key)', p1.body.items.every((n) => Object.keys(n).sort().join() === VIEW_KEYS && n.target?.type === 'BOOKING' && typeof n.payload === 'object'), Object.keys(p1.body.items[0]));
    const maxId = p1.body.query.maxId;
    for (let i = 30; i < 35; i++) await svc.create(make(ids.alice, i)); // arrive while the user pages
    const p2 = await call('GET', `/notifications?limit=10&page=2&maxId=${maxId}`, { token: tok.alice });
    const p3 = await call('GET', `/notifications?limit=10&page=3&maxId=${maxId}`, { token: tok.alice });
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((n) => n.id);
    check('stable paging with maxId: new notifications do not shift pages; 3 pages = the original 30, no duplicates', new Set(all).size === 30 && p2.body.meta.totalItems === 30 && p3.body.meta.hasNextPage === false && all.every((id) => BigInt(id) <= BigInt(maxId)), { total: p2.body.meta.totalItems, unique: new Set(all).size });
    const fresh = await call('GET', '/notifications?limit=10', { token: tok.alice });
    check('without maxId the first page shows the 5 new ones (35 total)', fresh.body.meta.totalItems === 35 && BigInt(fresh.body.items[0].id) > BigInt(maxId), { meta: fresh.body.meta, query: fresh.body.query, first: fresh.body.items[0]?.id, maxId });
    const past = await call('GET', '/notifications?limit=10&page=99', { token: tok.alice });
    check('page past the end -> 200 with no items and accurate totals', past.status === 200 && past.body.items.length === 0 && past.body.meta.totalItems === 35);
    const unreadList = await call('GET', '/notifications?status=unread&limit=50', { token: tok.alice });
    const readList = await call('GET', '/notifications?status=read&limit=50', { token: tok.alice });
    check('status filter: unread (34) + read (1) = 35; filters are disjoint', unreadList.body.meta.totalItems === 34 && readList.body.meta.totalItems === 1 && readList.body.items[0].id === aliceFirst && unreadList.body.items.every((n) => !n.isRead));
    const bad = await Promise.all(['?limit=51', '?page=0', '?status=new', '?maxId=abc', '?maxId=0', '?userId=' + ids.bob, '?recipientUserId=' + ids.bob, '?limit=1e1'].map((q) => call('GET', '/notifications' + q, { token: tok.alice })));
    check('invalid query (limit>50, page 0, unknown status, bad maxId, userId/recipientUserId injection, 1e1) -> 400', bad.every((r) => r.status === 400), bad.map((r) => r.status));

    // ------------------------------------------------------------ detail / cross-user
    section('3. Detail and cross-user isolation');
    const bobN = (await one(`select id::text id from notifications where recipient_user_id = $1 order by id limit 1`, [ids.bob])).id;
    const aliceN = unreadList.body.items[0].id;
    const detail = await call('GET', `/notifications/${aliceN}`, { token: tok.alice });
    check('own notification -> 200 with full detail; viewing does NOT mark it read', detail.status === 200 && detail.body.id === aliceN && detail.body.isRead === false && (await dbUnread(ids.alice)) === 34);
    const cross = await call('GET', `/notifications/${bobN}`, { token: tok.alice });
    const missing = await call('GET', '/notifications/999999999', { token: tok.alice });
    check("another user's notification -> 404 identical to a non-existent id (no existence leak)", cross.status === 404 && JSON.stringify(cross.body) === JSON.stringify(missing.body), [cross.body, missing.body]);
    const crossRead = await call('PATCH', `/notifications/${bobN}/read`, { token: tok.alice });
    check("marking another user's notification -> 404 and the row stays unread", crossRead.status === 404 && (await one('select read_at from notifications where id = $1', [bobN])).read_at === null);
    check('non-numeric / zero / overflowing id -> 400', (await Promise.all(['abc', '0', '99999999999999999999'].map((v) => call('GET', `/notifications/${v}`, { token: tok.alice })))).every((r) => r.status === 400));
    for (const role of ['owner', 'admin']) {
      const r = await call('GET', `/notifications/${aliceN}`, { token: tok[role] });
      check(`${role === 'owner' ? 'PROVIDER_OWNER' : 'ADMIN'} cannot read a customer's notification (404); sees only their own inbox`, r.status === 404 && (await call('GET', '/notifications', { token: tok[role] })).body.meta.totalItems === (role === 'owner' ? 3 : 1));
    }

    // ------------------------------------------------------------ read / read-all
    section('4. Mark as read, read-all, unread count');
    const uc = async (t) => (await call('GET', '/notifications/unread-count', { token: t })).body.unreadCount;
    check('unread-count = database count (alice 34, bob 5)', (await uc(tok.alice)) === 34 && (await uc(tok.bob)) === 5);
    const r1 = await call('PATCH', `/notifications/${aliceN}/read`, { token: tok.alice });
    const r2 = await call('PATCH', `/notifications/${aliceN}/read`, { token: tok.alice });
    check('mark read -> 200 isRead; repeated -> 200 with the SAME readAt (idempotent); count 33', r1.status === 200 && r1.body.isRead && r2.body.readAt === r1.body.readAt && (await uc(tok.alice)) === 33, [r1.body.readAt, r2.body.readAt]);
    const target = unreadList.body.items[1].id;
    const conc = await Promise.all(Array.from({ length: 12 }, (_, i) => call('PATCH', `/notifications/${target}/read`, { token: tok.alice, port: PORTS[i % 2] })));
    check('12 concurrent mark-read requests over 2 instances -> all 200 with one identical readAt', conc.every((r) => r.status === 200) && new Set(conc.map((r) => r.body.readAt)).size === 1, tally(conc));
    const upTo = unreadList.body.items[10].id;
    const partial = await call('PATCH', '/notifications/read-all', { token: tok.alice, body: { upToId: upTo } });
    const remainingNewer = (await one(`select count(*)::int c from notifications where recipient_user_id = $1 and read_at is null and id > $2`, [ids.alice, upTo])).c;
    check('read-all with upToId marks only ids <= upToId; newer ones stay unread; counts consistent', partial.status === 200 && (await one(`select count(*)::int c from notifications where recipient_user_id = $1 and read_at is null and id <= $2`, [ids.alice, upTo])).c === 0 && remainingNewer > 0 && partial.body.unreadCount === remainingNewer && (await uc(tok.alice)) === remainingNewer, { partial: partial.body, remainingNewer });
    const bobBefore = await dbUnread(ids.bob);
    const allRead = await call('PATCH', '/notifications/read-all', { token: tok.alice });
    const allAgain = await call('PATCH', '/notifications/read-all', { token: tok.alice, body: {} });
    check('read-all -> unreadCount 0; repeated -> markedCount 0 (idempotent); bob unaffected', allRead.status === 200 && allRead.body.unreadCount === 0 && allAgain.body.markedCount === 0 && (await dbUnread(ids.bob)) === bobBefore && bobBefore === 5, [allRead.body, allAgain.body]);
    check('read-all body rejects userId and malformed upToId (400)', (await call('PATCH', '/notifications/read-all', { token: tok.alice, body: { userId: ids.bob } })).status === 400 && (await call('PATCH', '/notifications/read-all', { token: tok.alice, body: { upToId: 'x' } })).status === 400);

    // ------------------------------------------------------------ concurrency
    section('5. Concurrency: creation vs read-all, duplicate deliveries');
    {
      const before = (await one(`select coalesce(max(id), 0)::text m from notifications where recipient_user_id = $1`, [ids.alice])).m;
      const creating = (async () => { for (let i = 100; i < 140; i++) await svc.create(make(ids.alice, i)); })();
      const reading = (async () => { const out = []; for (let i = 0; i < 8; i++) { out.push(await call('PATCH', '/notifications/read-all', { token: tok.alice, port: PORTS[i % 2] })); await sleep(15); } return out; })();
      const [, readAlls] = await Promise.all([creating, reading]);
      const total = (await one(`select count(*)::int c from notifications where recipient_user_id = $1 and id > $2`, [ids.alice, before])).c;
      const apiCount = await uc(tok.alice);
      evidence.createVsReadAll = { created: total, readAllStatuses: tally(readAlls), unreadAfter: apiCount, dbUnreadAfter: await dbUnread(ids.alice) };
      check('40 creations racing 8 read-all calls: all 40 persisted, all read-all 200, API unread count == DB count, no errors', total === 40 && readAlls.every((r) => r.status === 200) && apiCount === evidence.createVsReadAll.dbUnreadAfter, evidence.createVsReadAll);
      const upToId = (await one(`select max(id)::text m from notifications where recipient_user_id = $1`, [ids.alice])).m;
      const late = [];
      const creating2 = (async () => { for (let i = 200; i < 210; i++) late.push((await svc.create(make(ids.alice, i))).notification.id); })();
      await Promise.all([creating2, call('PATCH', '/notifications/read-all', { token: tok.alice, body: { upToId } })]);
      const lateUnread = (await db.query(`select read_at from notifications where id = any($1::bigint[])`, [late])).rows.every((r) => r.read_at === null);
      check('read-all with upToId racing new creations: notifications created after upToId all stay unread', lateUnread);
    }
    {
      const input = make(ids.bob, 900, { eventKey: `qa:dup:${RUN}` });
      const dups = await Promise.all(Array.from({ length: 10 }, () => svc.create(input)));
      const rows = (await one(`select count(*)::int c from notifications where event_key = $1`, [input.eventKey])).c;
      check('10 concurrent deliveries of one event -> exactly 1 row, 1 created=true, 9 created=false, same id', rows === 1 && dups.filter((d) => d.created).length === 1 && new Set(dups.map((d) => d.notification.id)).size === 1, { rows, created: dups.filter((d) => d.created).length });
      const otherRecipient = await svc.create({ ...input, recipientUserId: ids.alice });
      check('the same event key for a different recipient is a separate notification', otherRecipient.created === true && otherRecipient.notification.id !== dups[0].notification.id);
      const sequential = await svc.create(input);
      check('re-delivery later -> created=false with the original content (no update of history)', sequential.created === false && sequential.notification.title === input.title);
    }

    // ------------------------------------------------------------ transactions, errors
    section('6. Transactions and error behaviour');
    {
      const key = `qa:rollback:${RUN}`;
      const err = await ds.transaction(async (m) => { await svc.create(make(ids.bob, 950, { eventKey: key }), m); throw new Error('business step failed'); }).catch((e) => e.message);
      check('created inside a business transaction that rolls back -> no notification persisted', err === 'business step failed' && (await one(`select count(*)::int c from notifications where event_key = $1`, [key])).c === 0);
      const key2 = `qa:commit:${RUN}`;
      await ds.transaction(async (m) => { await svc.create(make(ids.bob, 951, { eventKey: key2 }), m); });
      check('created inside a committed business transaction -> persisted', (await one(`select count(*)::int c from notifications where event_key = $1`, [key2])).c === 1);
      const many = await svc.createMany([make(ids.alice, 960), make(ids.bob, 960), { ...make(ids.owner, 960), type: 'BOOKING_CREATED' }]);
      check('createMany for several recipients (e.g. provider staff) -> one row each', many.every((r) => r.created));
      const fk = await svc.create(make('999999999', 1, { eventKey: null })).catch((e) => e);
      const bad = await svc.create({ ...make(ids.bob, 1), payload: { resetLink: 'https://x' } }).catch((e) => e);
      check('unknown recipient -> NotificationRecipientNotFoundError; sensitive payload -> NotificationInputError (nothing written)', fk instanceof NotificationRecipientNotFoundError && bad instanceof NotificationInputError);
      const deletedTarget = await svc.create({ ...make(ids.alice, 970), target: { type: 'BOOKING', id: '987654321' } });
      const view = await call('GET', `/notifications/${deletedTarget.notification.id}`, { token: tok.alice });
      const follow = await call('GET', '/bookings/mine/987654321', { token: tok.alice });
      check('a notification whose target record does not exist is still listed; following the target goes through normal auth (404)', view.status === 200 && view.body.target.id === '987654321' && follow.status === 404);
      const ownerFollow = await call('GET', '/bookings/mine/1001', { token: tok.owner });
      check('a target never grants access: a provider following a customer endpoint target -> 403 by role', ownerFollow.status === 403);
    }

    // ------------------------------------------------------------ suspension
    section('7. Suspended accounts');
    const adminSus = await call('PATCH', `/admin/users/${ids.bob}/suspend`, { token: tok.admin });
    check("suspended user's token -> 401 on the inbox; notifications are kept (not deleted)", adminSus.status === 200 && (await call('GET', '/notifications', { token: tok.bob })).status === 401 && (await one('select count(*)::int c from notifications where recipient_user_id = $1', [ids.bob])).c > 0);

    // ------------------------------------------------------------ scale
    section('8. Scale: 50,000 notifications for one user, 150,000 total');
    await db.query(`insert into notifications(recipient_user_id, type, title, body, payload, target_type, target_id, read_at)
      select $1, 'BOOKING_CONFIRMED', 'Bulk ' || g, 'Bulk body ' || g, jsonb_build_object('n', g), 'BOOKING', g, case when g % 3 = 0 then now() end
      from generate_series(1, 50000) g`, [ids.alice]);
    await db.query(`insert into notifications(recipient_user_id, type, title, body, payload, target_type, target_id)
      select $1, 'BOOKING_CREATED', 'Other ' || g, 'Other body', '{}', 'BOOKING', g from generate_series(1, 50000) g`, [ids.owner]);
    await db.query(`insert into notifications(recipient_user_id, type, title, body, payload)
      select $1, 'SYSTEM_ANNOUNCEMENT', 'Ann ' || g, 'Ann body', '{}' from generate_series(1, 50000) g`, [ids.admin]);
    await db.query('analyze notifications');
    const plan = async (sql, params) => (await db.query(`explain (analyze, format json) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    const usesSeqScan = (node) => node['Node Type'] === 'Seq Scan' || (node.Plans ?? []).some(usesSeqScan);
    const listPlan = await plan(`select id from notifications where recipient_user_id = $1 and id <= 9223372036854775807 order by id desc limit 20 offset 0`, [ids.alice]);
    const unreadPlan = await plan(`select count(*) from notifications where recipient_user_id = $1 and read_at is null`, [ids.alice]);
    const deepPlan = await plan(`select id from notifications where recipient_user_id = $1 and id <= 9223372036854775807 and read_at is null order by id desc limit 50 offset 49950`, [ids.alice]);
    evidence.plans = { list: { ms: listPlan['Execution Time'], seqScan: usesSeqScan(listPlan.Plan) }, unreadCount: { ms: unreadPlan['Execution Time'], seqScan: usesSeqScan(unreadPlan.Plan) }, deepUnreadPage: { ms: deepPlan['Execution Time'], seqScan: usesSeqScan(deepPlan.Plan) } };
    check('list (first page) and unread count use indexes, no sequential scan; first page < 5 ms', !evidence.plans.list.seqScan && !evidence.plans.unreadCount.seqScan && evidence.plans.list.ms < 5, evidence.plans);
    const timings = [];
    for (let i = 0; i < 10; i++) { const t = Date.now(); await call('GET', '/notifications?limit=50', { token: tok.alice }); timings.push(Date.now() - t); }
    const t0 = Date.now(); const cnt = await call('GET', '/notifications/unread-count', { token: tok.alice }); const ucMs = Date.now() - t0;
    timings.sort((a, b) => a - b);
    evidence.http = { listP50ms: timings[5], listMaxMs: timings[9], unreadCountMs: ucMs, unreadCount: cnt.body.unreadCount };
    check('HTTP with 50k notifications: list p50 < 100 ms, unread-count exact (= DB)', timings[5] < 100 && cnt.body.unreadCount === (await dbUnread(ids.alice)), evidence.http);

    // ------------------------------------------------------------ invariants
    section('9. Invariants and leakage');
    const inv = await one(`select
      (select count(*)::int from notifications where (target_type is null) <> (target_id is null)) half_targets,
      (select count(*)::int from notifications n left join users u on u.id = n.recipient_user_id where u.id is null) orphans,
      (select count(*)::int from (select recipient_user_id, event_key from notifications where event_key is not null group by 1, 2 having count(*) > 1) x) duplicate_events,
      (select count(*)::int from notifications where read_at < created_at) read_before_created,
      (select deadlocks::int from pg_stat_database where datname = current_database()) deadlocks`);
    evidence.invariants = inv;
    check('no half targets, orphans, duplicate events or read-before-created rows; 0 deadlocks', Object.values(inv).every((v) => v === 0), inv);
    check('no HTTP 500 anywhere', !statuses.includes(500), tally(statuses.map((status) => ({ status }))));
    const sample = JSON.stringify((await call('GET', '/notifications?limit=50', { token: tok.alice })).body);
    check('responses never contain recipient ids, event keys or password hashes', !/recipient|eventKey|event_key|passwordHash|\$2[aby]\$/.test(sample));
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
    fs.writeFileSync(path.join(OUT_DIR, 'notifications-results.json'), JSON.stringify({ results, evidence }, null, 2));
    console.log('\nEVIDENCE', JSON.stringify(evidence));
    console.log(`OUT_DIR ${OUT_DIR}`);
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed}  FAIL ${failed}  SKIPPED 0`);
    process.exitCode = failed ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  });
