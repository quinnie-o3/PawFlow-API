/*
 * P3-BE08-03 review moderation and security: real HTTP + real PostgreSQL
 * on a disposable QA database only. Two API instances.
 *
 *   npm run build
 *   npm run qa:review-moderation
 *
 * Races use deterministic barriers: a second connection holds a row lock
 * that one transaction needs, the other transaction is started and observed
 * waiting in pg_stat_activity, then the barrier is released. Both orders of
 * admin hide vs provider response are forced this way, not left to timing.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_review_moderation), QA_PORTS
 * (default 8321,8322), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, DB, Client, sleep, prepareDatabase, dropDatabase, createApp, createApi, keyPaths, forbiddenIn } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_review_moderation';
const PORTS = (process.env.QA_PORTS ?? '8321,8322').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-moderation-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaModerationPass123!';
const RUN = 'rm' + Date.now().toString(36);
const HIDDEN_TOKEN = `hiddentoken${RUN}`;

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const sqlState = (sql, params) => db.query(sql, params).then(() => 'ok', (e) => e.code);
  const apps = [];
  const api = createApi(PORTS);
  const statuses = [];
  const call = async (method, url, opts = {}) => { const r = await api(method, url, opts); statuses.push(r.status); return r; };
  const mail = (n) => `${n}.${RUN}@qa.test`;
  const secrets = [PASSWORD, JWT_SECRET];
  const side = new Client({ ...DB, database: NAME });
  let sideConnected = false;

  try {
    section('0. Schema');
    const defs = Object.fromEntries((await all(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'reviews'::regclass`)).map((c) => [c.conname, c.d]));
    check(`17 migrations applied, last AddReviewResponseConstraints1797500000000, 0 pending DDL; text CHECK trims the Unicode set (chr(160), chr(12288), chr(65279) present)`, migrations.at(-1) === 'AddReviewResponseConstraints1797500000000' && pendingDdl.length === 0 && ['chr(160)', 'chr(12288)', 'chr(65279)', 'chr(8232)'].every((s) => defs.chk_reviews_response_text?.includes(s)), { last: migrations.at(-1), pendingDdl, text: defs.chk_reviews_response_text });

    // ------------------------------------------------------------- seed
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    for (const [n, role] of [['ownerA', 'PROVIDER_OWNER'], ['ownerB', 'PROVIDER_OWNER'], ['ownerX', 'PROVIDER_OWNER'], ['staffA', 'PROVIDER_STAFF'], ['staffOff', 'PROVIDER_STAFF'], ['cust1', 'CUSTOMER'], ['cust2', 'CUSTOMER'], ['admin', 'ADMIN']]) {
      ids[n] = (await one(`insert into users(full_name, email, phone, password_hash, role, status) values ($1, $2, $3, $4, $5, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), '08' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), hash, role])).id;
    }
    const petType = (await one(`insert into pet_types(name) values ($1) returning id::text id`, ['Cat ' + RUN])).id;
    const category = (await one(`insert into service_categories(name) values ($1) returning id::text id`, ['Bath ' + RUN])).id;
    const pet = {};
    for (const c of ['cust1', 'cust2']) pet[c] = (await one(`insert into pets(owner_id, pet_type_id, name, health_note) values ($1, $2, $3, 'private health') returning id::text id`, [ids[c], petType, 'Pet ' + c])).id;
    const prov = {}; const svc = {}; const slot = {};
    for (const p of ['A', 'B']) {
      prov[p] = (await one(`insert into providers(owner_id, business_name, address, approval_status) values ($1, $2, 'QA road', 'APPROVED') returning id::text id`, [ids['owner' + p], `QA Mod ${p} ${RUN}`])).id;
      svc[p] = (await one(`insert into services(provider_id, category_id, name, price, duration_minutes) values ($1, $2, $3, 50000, 30) returning id::text id`, [prov[p], category, `Bath ${p}`])).id;
      slot[p] = (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity, booked_count) values ($1, $2, current_date - 1, '08:00', '09:00', 100, 0) returning id::text id`, [prov[p], svc[p]])).id;
    }
    await db.query(`insert into provider_staff(provider_id, user_id, status) values ($1, $2, 'ACTIVE'), ($1, $3, 'INACTIVE')`, [prov.A, ids.staffA, ids.staffOff]);
    const bookings = { A: [], B: [] };
    const newBooking = async (p, c, status = 'COMPLETED') => {
      const b = (await one(`insert into bookings(customer_id, pet_id, provider_id, service_id, slot_id, status, booked_price, customer_note) values ($1, $2, $3, $4, $5, $6, 50000, 'private note') returning id::text id`, [ids[c], pet[c], prov[p], svc[p], slot[p], status])).id;
      await db.query(`insert into booking_status_logs(booking_id, old_status, new_status) values ($1, null, $2)`, [b, status]);
      await db.query(`update availability_slots set booked_count = booked_count + 1 where id = $1`, [slot[p]]);
      return b;
    };
    for (let i = 0; i < 24; i++) bookings.A.push(await newBooking('A', 'cust1'));
    for (let i = 0; i < 3; i++) bookings.B.push(await newBooking('B', 'cust2'));
    const pendingA = await newBooking('A', 'cust1', 'PENDING_CONFIRMATION');
    const cancelledA = await newBooking('A', 'cust1', 'CANCELLED');

    const logDir = path.join(OUT_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    for (const port of PORTS) { const app = createApp(NAME, [port], { logDir, jwtSecret: JWT_SECRET }); await app.start(); apps.push(app); }
    const login = async (n) => { const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } }); if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`); secrets.push(r.body.accessToken, r.body.refreshToken); return r.body.accessToken; };
    const T = {};
    for (const n of Object.keys(ids)) T[n] = await login(n);

    const A = []; const B = [];
    for (let i = 0; i < bookings.A.length; i++) {
      const r = await call('POST', `/bookings/${bookings.A[i]}/reviews`, { token: T.cust1, body: { rating: (i % 5) + 1, comment: i === 1 ? `Bad visit ${HIDDEN_TOKEN}` : `A review ${i}` } });
      if (r.status !== 201) throw new Error(`seed A${i}: ${r.status}`);
      A.push(String(r.body.id));
    }
    for (const b of bookings.B) { const r = await call('POST', `/bookings/${b}/reviews`, { token: T.cust2, body: { rating: 5 } }); B.push(String(r.body.id)); }
    const respond = (token, id, body, port) => call('POST', `/providers/me/reviews/${id}/response`, { token, body, port });
    const adminList = () => call('GET', '/admin/reviews', { token: T.admin });
    const adminGet = (id) => call('GET', `/admin/reviews/${id}`, { token: T.admin });
    const hide = (id, port) => call('PATCH', `/admin/reviews/${id}/hide`, { token: T.admin, port });
    const restore = (id, port) => call('PATCH', `/admin/reviews/${id}/restore`, { token: T.admin, port });
    const row = (id) => one(`select is_visible, provider_response, responded_by::text responded_by, responded_at, updated_at from reviews where id = $1`, [id]);
    const providerItem = async (token, id) => (await call('GET', '/providers/me/reviews?limit=50', { token })).body.items?.find((i) => i.id === id);

    section('1. Admin response projection');
    const answered = await respond(T.ownerA, A[0], { text: 'Thanks for visiting' });
    const r0 = await row(A[0]);
    const list = await adminList();
    const item0 = list.body.find((i) => String(i.id) === A[0]);
    const detail0 = await adminGet(A[0]);
    check('1. admin list: providerResponse, respondedBy { id, fullName }, respondedAt (= DB), isVisible', answered.status === 201 && JSON.stringify(item0.respondedBy) === JSON.stringify({ id: ids.ownerA, fullName: 'QA ownerA' }) && item0.providerResponse === 'Thanks for visiting' && item0.respondedAt === r0.responded_at.toISOString() && item0.isVisible === true, item0);
    check('2. admin detail equals the list item (same projection)', detail0.status === 200 && JSON.stringify(detail0.body) === JSON.stringify(item0), { detail: detail0.body, item0 });
    const itemNone = list.body.find((i) => String(i.id) === A[5]);
    check('3. review without response -> providerResponse, respondedBy, respondedAt all null', itemNone.providerResponse === null && itemNone.respondedBy === null && itemNone.respondedAt === null, itemNone);
    const adminKeys = [...new Set(list.body.flatMap((i) => keyPaths(i)))].sort().join();
    const adminLeaks = forbiddenIn(list.body, ['email', 'phone', 'passwordHash', 'role', 'status', 'sessionId', 'accessToken']).filter((p) => p !== 'booking.status' && p !== '[].booking.status');
    check('1b. admin bodies: responder carries no email/phone/role/status; key set as documented', adminLeaks.length === 0 && adminKeys === 'booking,booking.customerId,booking.id,booking.providerId,booking.serviceId,booking.status,bookingId,comment,createdAt,id,isVisible,providerResponse,rating,respondedAt,respondedBy,respondedBy.fullName,respondedBy.id,updatedAt', { adminLeaks, adminKeys });
    {
      // Responder deleted: text and time kept, no fabricated responder anywhere.
      const temp = (await one(`insert into users(full_name, email, password_hash, role, status) values ('QA temp', $1, $2, 'CUSTOMER', 'ACTIVE') returning id::text id`, [mail('temp'), hash])).id;
      await db.query(`update reviews set provider_response = 'Answered by a deleted account', responded_by = $2, responded_at = now() where id = $1`, [A[20], temp]);
      const del = await sqlState(`delete from users where id = $1`, [temp]);
      const a = (await adminGet(A[20])).body;
      const inList = (await adminList()).body.find((i) => String(i.id) === A[20]);
      const prov20 = await providerItem(T.ownerA, A[20]);
      check('4. deleted responder -> admin list/detail and provider list keep text and time with respondedBy null', del === 'ok' && a.providerResponse === 'Answered by a deleted account' && a.respondedAt !== null && a.respondedBy === null && JSON.stringify(inList) === JSON.stringify(a) && prov20.response?.text === 'Answered by a deleted account' && prov20.response.respondedBy === null, { del, a, prov20 });
    }
    const unauth = {
      ownerList: (await call('GET', '/admin/reviews', { token: T.ownerA })).status,
      staffDetail: (await call('GET', `/admin/reviews/${A[0]}`, { token: T.staffA })).status,
      customerList: (await call('GET', '/admin/reviews', { token: T.cust1 })).status,
      anonymous: (await call('GET', '/admin/reviews')).status,
      forgedAdminJwt: (await call('GET', '/admin/reviews', { token: jwt.sign({ sub: ids.ownerA, email: mail('ownerA'), role: 'ADMIN', sid: randomUUID() }, 'not-the-secret') })).status,
      unsignedAdminJwt: (await call('GET', '/admin/reviews', { token: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: ids.admin, role: 'ADMIN', sid: randomUUID() })).toString('base64url')}.` })).status,
    };
    evidence.adminUnauthorized = unauth;
    check('5. admin review data: provider owner/staff/customer 403, anonymous 401, forged or unsigned ADMIN token 401', unauth.ownerList === 403 && unauth.staffDetail === 403 && unauth.customerList === 403 && unauth.anonymous === 401 && unauth.forgedAdminJwt === 401 && unauth.unsignedAdminJwt === 401, unauth);

    section('2. Moderation and audit');
    const h1 = await hide(A[1]);
    const logsAfterHide = await all(`select admin_user_id::text admin, action, metadata from admin_activity_logs where target_type = 'REVIEW' and target_id = $1 order by id`, [A[1]]);
    check('6. admin hides a visible review -> 200 isVisible false; rating recomputed', h1.status === 200 && h1.body.isVisible === false && h1.body.respondedBy === null, h1.body);
    const h0 = await hide(A[0]);
    const r0h = await row(A[0]);
    const rs0 = await restore(A[0]);
    const r0r = await row(A[0]);
    check('18. answered review keeps text, responder and respondedAt through hide and restore (hide/restore bodies show them)', h0.status === 200 && rs0.status === 200 && h0.body.providerResponse === 'Thanks for visiting' && JSON.stringify(h0.body.respondedBy) === JSON.stringify(item0.respondedBy) && rs0.body.respondedAt === item0.respondedAt && r0h.provider_response === r0.provider_response && r0r.responded_by === r0.responded_by && r0r.responded_at.getTime() === r0.responded_at.getTime(), { h0: h0.body, rs0: rs0.body });
    const logs0 = await all(`select admin_user_id::text admin, action, metadata from admin_activity_logs where target_type = 'REVIEW' and target_id = $1 order by id`, [A[0]]);
    check('7/8. hide and restore are audited: REVIEW_HIDDEN then REVIEW_RESTORED by the admin, metadata fromVisible/toVisible/ratingCount/ratingAvg', logsAfterHide.length === 1 && logsAfterHide[0].admin === ids.admin && logsAfterHide[0].action === 'REVIEW_HIDDEN' && logs0.map((l) => l.action).join() === 'REVIEW_HIDDEN,REVIEW_RESTORED' && logs0.every((l) => l.admin === ids.admin && ['fromVisible', 'toVisible', 'ratingCount', 'ratingAvg'].every((k) => k in l.metadata)) && logs0[1].metadata.toVisible === true, { logsAfterHide, logs0 });
    const again = { hide: (await hide(A[1])).status, restoreVisible: (await restore(A[2])).status };
    check('existing transitions unchanged: hide a hidden review 409, restore a visible review 409', again.hide === 409 && again.restoreVisible === 409, again);

    const before = await row(A[3]);
    const providerAttempts = {
      ownerHide: (await call('PATCH', `/admin/reviews/${A[3]}/hide`, { token: T.ownerA })).status,
      staffHide: (await call('PATCH', `/admin/reviews/${A[3]}/hide`, { token: T.staffA })).status,
      ownerRestore: (await call('PATCH', `/admin/reviews/${A[1]}/restore`, { token: T.ownerA })).status,
      customerHide: (await call('PATCH', `/admin/reviews/${A[3]}/hide`, { token: T.cust1 })).status,
      responseWithIsVisible: (await respond(T.ownerA, A[3], { text: 'x', isVisible: false })).status,
      responseWithAdminId: (await respond(T.ownerA, A[3], { text: 'x', adminUserId: ids.admin })).status,
      patchProviderReview: (await call('PATCH', `/providers/me/reviews/${A[3]}`, { token: T.ownerA, body: { isVisible: false } })).status,
      editResponse: (await call('PATCH', `/providers/me/reviews/${A[0]}/response`, { token: T.ownerA, body: { text: 'edited' } })).status,
      putResponse: (await call('PUT', `/providers/me/reviews/${A[0]}/response`, { token: T.ownerA, body: { text: 'edited' } })).status,
      deleteResponse: (await call('DELETE', `/providers/me/reviews/${A[0]}/response`, { token: T.ownerA })).status,
      otherProviderRespond: (await respond(T.ownerB, A[3], { text: 'not yours' })).status,
    };
    const after = await row(A[3]);
    evidence.providerAttempts = providerAttempts;
    check('9. providers cannot hide/restore (403), cannot send moderation/identity fields (400), have no edit/delete/visibility route (404), cannot touch another provider\'s review (404); nothing changed', providerAttempts.ownerHide === 403 && providerAttempts.staffHide === 403 && providerAttempts.ownerRestore === 403 && providerAttempts.customerHide === 403 && providerAttempts.responseWithIsVisible === 400 && providerAttempts.responseWithAdminId === 400 && providerAttempts.patchProviderReview === 404 && providerAttempts.editResponse === 404 && providerAttempts.putResponse === 404 && providerAttempts.deleteResponse === 404 && providerAttempts.otherProviderRespond === 404 && JSON.stringify(after) === JSON.stringify(before) && (await row(A[0])).provider_response === 'Thanks for visiting', providerAttempts);

    section('3. Hidden-review visibility matrix');
    const pub = await call('GET', `/reviews/provider/${prov.A}`);
    const visibleCount = (await one(`select count(*)::int n from reviews r join bookings b on b.id = r.booking_id where b.provider_id = $1 and r.is_visible`, [prov.A])).n;
    check('10. public provider review list excludes the hidden review', pub.status === 200 && !pub.body.some((i) => String(i.id) === A[1]) && pub.body.length === visibleCount && !JSON.stringify(pub.body).includes(HIDDEN_TOKEN), { len: pub.body.length, visibleCount });
    const agg = await one(`select rating_count, rating_avg::text avg, (select count(*)::int from reviews r join bookings b on b.id = r.booking_id where b.provider_id = p.id and r.is_visible) vis, (select round(avg(r.rating), 2)::text from reviews r join bookings b on b.id = r.booking_id where b.provider_id = p.id and r.is_visible) vavg from providers p where p.id = $1`, [prov.A]);
    const det = await call('GET', `/providers/public/${prov.A}`);
    const search = await call('GET', `/providers/public/search?q=${encodeURIComponent(`QA Mod A ${RUN}`)}`);
    const searchItem = search.body.items?.find((i) => String(i.id) === prov.A);
    check('11. rating aggregates = visible rows only; public detail and search show the same count/avg', agg.rating_count === agg.vis && Number(agg.avg) === Number(agg.vavg) && det.body.ratingCount === agg.vis && det.body.ratingAvg === agg.avg && searchItem?.ratingCount === agg.vis && searchItem?.ratingAvg === agg.avg, { agg, detail: [det.body.ratingCount, det.body.ratingAvg], search: [searchItem?.ratingCount, searchItem?.ratingAvg] });
    const alt = {
      search: await call('GET', `/providers/public/search?q=${HIDDEN_TOKEN}`),
      detailText: JSON.stringify(det.body).includes(HIDDEN_TOKEN),
      minRating: await call('GET', `/providers/public/search?minRating=${Number(agg.avg) + 0.01 > 5 ? 5 : (Number(agg.avg) + 0.01).toFixed(2)}&q=${encodeURIComponent(`QA Mod A ${RUN}`)}`),
    };
    // Note: search terms are matched individually, so "A" also matches provider B's name; assert on A's id.
    const minRatingIds = (alt.minRating.body.items ?? []).map((i) => String(i.id));
    check('12. alternate public paths: search by the hidden comment finds nothing, provider detail never carries review text, minRating just above A\'s visible-only average excludes A', alt.search.status === 200 && alt.search.body.meta.totalItems === 0 && !alt.detailText && alt.minRating.status === 200 && !minRatingIds.includes(prov.A), { search: alt.search.body.meta, minRatingIds, avg: agg.avg });
    const mine = await call('GET', '/reviews/mine', { token: T.cust1 });
    const mineHidden = mine.body.find((i) => String(i.id) === A[1]);
    check('13. review author still sees the hidden review (isVisible false) in /reviews/mine', mine.status === 200 && mineHidden?.isVisible === false && mineHidden.comment.includes(HIDDEN_TOKEN), mineHidden);
    const ownerSees = await providerItem(T.ownerA, A[1]);
    const staffSees = await providerItem(T.staffA, A[1]);
    check('14/15. provider owner and ACTIVE staff see the hidden review flagged isVisible:false', ownerSees?.isVisible === false && staffSees?.isVisible === false && JSON.stringify(ownerSees) === JSON.stringify(staffSees), { ownerSees, staffSees });
    const bList = await call('GET', '/providers/me/reviews?limit=50&visibility=hidden', { token: T.ownerB });
    const offList = await call('GET', '/providers/me/reviews', { token: T.staffOff });
    check('16. another provider cannot see A\'s hidden review (B hidden list empty, respond 404); inactive staff 403', bList.status === 200 && bList.body.meta.totalItems === 0 && (await respond(T.ownerB, A[1], { text: 'x' })).status === 404 && offList.status === 403, { b: bList.body.meta, off: offList.status });
    const hid = await respond(T.ownerA, A[1], { text: 'Reply to hidden' });
    check('17. hidden review cannot be newly answered -> 409; nothing written', hid.status === 409 && hid.body.message === 'Hidden reviews cannot be responded to' && (await row(A[1])).provider_response === null, hid.body);

    section('4. Races with deterministic barriers');
    await side.connect();
    sideConnected = true;
    const waiting = async () => (await one(`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).n;
    const waitFor = async (n) => { for (let i = 0; i < 150; i++) { if ((await waiting()) >= n) return true; await sleep(25); } return false; };
    const audit = async (id) => (await all(`select action from admin_activity_logs where target_type = 'REVIEW' and target_id = $1 order by id`, [id])).map((l) => l.action);

    {
      // Race A: admin hide takes the review lock first and waits on the
      // provider row (barrier); the response then waits on the review lock.
      const id = A[6];
      await side.query('BEGIN');
      await side.query(`select 1 from providers where id = $1 for share`, [prov.A]);
      const hideP = hide(id, PORTS[0]);
      const hideWaiting = await waitFor(1);
      const respP = respond(T.ownerA, id, { text: 'Race A response' }, PORTS[1]);
      const bothWaiting = await waitFor(2);
      await side.query('COMMIT');
      const [h, r] = await Promise.all([hideP, respP]);
      const st = await row(id);
      evidence.raceA = { hideWaiting, bothWaiting, hide: h.status, respond: r.status, message: r.body.message, stored: st };
      check('19. Race A (admin hide wins): hide 200; response 409 hidden; no response fields written; REVIEW_HIDDEN audit retained', hideWaiting && bothWaiting && h.status === 200 && r.status === 409 && r.body.message === 'Hidden reviews cannot be responded to' && st.is_visible === false && st.provider_response === null && st.responded_by === null && st.responded_at === null && (await audit(id)).join() === 'REVIEW_HIDDEN', evidence.raceA);
    }
    {
      // Race B: the response holds the review lock and waits on the user row
      // (barrier); the admin hide then waits on the review lock.
      const id = A[7];
      await side.query('BEGIN');
      await side.query(`select 1 from users where id = $1 for update`, [ids.ownerA]);
      const t0 = new Date((await one('select now() n')).n);
      const respP = respond(T.ownerA, id, { text: 'Race B response' }, PORTS[0]);
      const respWaiting = await waitFor(1);
      const hideP = hide(id, PORTS[1]);
      const bothWaiting = await waitFor(2);
      await side.query('ROLLBACK');
      const [r, h] = await Promise.all([respP, hideP]);
      const t1 = new Date((await one('select now() n')).n);
      const st = await row(id);
      const pubB = await call('GET', `/reviews/provider/${prov.A}`);
      const aggB = await one(`select rating_count, (select count(*)::int from reviews r join bookings b on b.id = r.booking_id where b.provider_id = p.id and r.is_visible) vis from providers p where p.id = $1`, [prov.A]);
      const internalOwner = await providerItem(T.ownerA, id);
      const internalAdmin = (await adminGet(id)).body;
      evidence.raceB = { respWaiting, bothWaiting, respond: r.status, hide: h.status, stored: st };
      check('20. Race B (response wins): response 201 then hide 200; exactly one response with the owner and a DB timestamp; hidden from public and aggregates; kept for owner and admin', respWaiting && bothWaiting && r.status === 201 && h.status === 200 && st.provider_response === 'Race B response' && st.responded_by === ids.ownerA && st.responded_at >= t0 && st.responded_at <= t1 && st.is_visible === false && !pubB.body.some((i) => String(i.id) === id) && aggB.rating_count === aggB.vis && internalOwner?.response?.text === 'Race B response' && internalOwner.isVisible === false && internalAdmin.providerResponse === 'Race B response' && internalAdmin.respondedBy?.id === ids.ownerA && h.body.providerResponse === 'Race B response', evidence.raceB);
    }
    {
      // Race C1: restore holds the review lock (barrier on the provider row);
      // two responses wait behind it. The decision is made after the restore.
      const id = A[8];
      await hide(id);
      await side.query('BEGIN');
      await side.query(`select 1 from providers where id = $1 for share`, [prov.A]);
      const restoreP = restore(id, PORTS[0]);
      const restoreWaiting = await waitFor(1);
      const r1 = respond(T.ownerA, id, { text: 'C1 first' }, PORTS[0]);
      const r2 = respond(T.ownerA, id, { text: 'C1 second' }, PORTS[1]);
      const allWaiting = await waitFor(3);
      await side.query('COMMIT');
      const [rs, a, b] = await Promise.all([restoreP, r1, r2]);
      const st = await row(id);
      const codes = [a.status, b.status].sort().join();
      evidence.raceC1 = { restoreWaiting, allWaiting, restore: rs.status, responses: codes, stored: st.provider_response };
      check('21a. Race C (restore first, 2 responses waiting): restore 200, then exactly one 201 + one 409; one stored response', restoreWaiting && allWaiting && rs.status === 200 && codes === '201,409' && st.is_visible === true && ['C1 first', 'C1 second'].includes(st.provider_response), evidence.raceC1);
    }
    {
      // Race C2: a response on a HIDDEN review holds the review lock (barrier
      // on the user row); the restore waits. The response decided on the
      // hidden state it locked -> 409; afterwards one response is possible.
      const id = A[9];
      await hide(id);
      await side.query('BEGIN');
      await side.query(`select 1 from users where id = $1 for update`, [ids.ownerA]);
      const respP = respond(T.ownerA, id, { text: 'C2 early' }, PORTS[0]);
      const respWaiting = await waitFor(1);
      const restoreP = restore(id, PORTS[1]);
      const bothWaiting = await waitFor(2);
      await side.query('ROLLBACK');
      const [r, rs] = await Promise.all([respP, restoreP]);
      const mid = await row(id);
      const later = [await respond(T.ownerA, id, { text: 'C2 after restore' }), await respond(T.ownerA, id, { text: 'C2 again' })].map((x) => x.status);
      const st = await row(id);
      evidence.raceC2 = { respWaiting, bothWaiting, respond: r.status, restore: rs.status, midResponse: mid.provider_response, later, stored: st.provider_response };
      check('21b. Race C (response on hidden first, restore waiting): response 409, restore 200, nothing written; then 201 + 409 -> one response', respWaiting && bothWaiting && r.status === 409 && rs.status === 200 && mid.provider_response === null && later.join() === '201,409' && st.provider_response === 'C2 after restore', evidence.raceC2);
    }
    {
      const id = A[10];
      const texts = Array.from({ length: 10 }, (_, i) => `Dup ${i}`);
      const rs = await Promise.all(texts.map((text, i) => respond(T.ownerA, id, { text }, PORTS[i % 2])));
      const counts = rs.reduce((acc, x) => ({ ...acc, [x.status]: (acc[x.status] ?? 0) + 1 }), {});
      check('22. 10 concurrent duplicate responses -> exactly 1x201 + 9x409', counts[201] === 1 && counts[409] === 9 && texts.includes((await row(id)).provider_response), counts);
    }
    // Race D: access revocation committed while the response waits on the lock it must pass.
    const raceD = async (label, lockSql, changeSql, undoSql, id) => {
      await side.query('BEGIN');
      await side.query(lockSql[0], lockSql[1]);
      const p = respond(T.ownerA, id, { text: `D ${label}` });
      const w = await waitFor(1);
      await side.query(changeSql[0], changeSql[1]);
      await side.query('COMMIT');
      const r = await p;
      if (undoSql) await db.query(undoSql[0], undoSql[1]);
      return { waited: w, status: r.status, written: (await row(id)).provider_response !== null };
    };
    const d = {};
    d.ownership = await raceD('ownership', [`select 1 from providers where id = $1 for update`, [prov.A]], [`update providers set owner_id = $2 where id = $1`, [prov.A, ids.ownerX]], [`update providers set owner_id = $2 where id = $1`, [prov.A, ids.ownerA]], A[11]);
    d.providerSuspended = await raceD('provider', [`select 1 from providers where id = $1 for update`, [prov.A]], [`update providers set approval_status = 'SUSPENDED' where id = $1`, [prov.A]], [`update providers set approval_status = 'APPROVED' where id = $1`, [prov.A]], A[11]);
    d.accountSuspended = await raceD('account', [`select 1 from users where id = $1 for update`, [ids.ownerA]], [`update users set status = 'SUSPENDED' where id = $1`, [ids.ownerA]], [`update users set status = 'ACTIVE' where id = $1`, [ids.ownerA]], A[11]);
    d.sessionRevoked = await raceD('session', [`select 1 from auth_sessions where user_id = $1 and revoked_at is null for update`, [ids.ownerA]], [`update auth_sessions set revoked_at = now(), revoked_reason = 'LOGOUT' where user_id = $1 and revoked_at is null`, [ids.ownerA]], null, A[11]);
    evidence.raceD = d;
    check('23. ownership changed while the response waits on the provider lock -> 404, nothing written', d.ownership.waited && d.ownership.status === 404 && !d.ownership.written, d.ownership);
    check('24. provider suspended while waiting -> 403, nothing written', d.providerSuspended.waited && d.providerSuspended.status === 403 && !d.providerSuspended.written, d.providerSuspended);
    check('25. session revoked while waiting -> 401; account suspended while waiting -> 401; nothing written', d.sessionRevoked.waited && d.sessionRevoked.status === 401 && !d.sessionRevoked.written && d.accountSuspended.waited && d.accountSuspended.status === 401 && !d.accountSuspended.written, d);
    const revokedNow = await respond(T.ownerA, A[11], { text: 'with revoked token' });
    T.ownerA = await login('ownerA');
    check('25b. a revoked token stays rejected afterwards (401); a new login can respond (201)', revokedNow.status === 401 && (await respond(T.ownerA, A[11], { text: 'after re-login' })).status === 201, revokedNow.status);

    section('5. Data integrity and Unicode');
    {
      const api201 = {};
      const comb1000 = 'é'.repeat(500);
      api201.combining1000 = (await respond(T.ownerA, A[12], { text: comb1000 })).status;
      api201.combining1001 = (await respond(T.ownerA, A[13], { text: comb1000 + '́' })).status;
      api201.nbspOnly = (await respond(T.ownerA, A[13], { text: ' 　﻿' })).status;
      api201.crlfUnicodeTrim = (await respond(T.ownerA, A[13], { text: '　 Line one\r\nLine two \r\n' })).status;
      api201.emoji1000 = (await respond(T.ownerA, A[14], { text: '\u{1F408}'.repeat(1000) })).status;
      api201.control = (await respond(T.ownerA, A[15], { text: 'bell\u0007inside' })).status;
      const lone = await fetch(`http://localhost:${PORTS[0]}/api/providers/me/reviews/${A[16]}/response`, { method: 'POST', headers: { Authorization: `Bearer ${T.ownerA}`, 'Content-Type': 'application/json' }, body: '{"text":"a\\ud800b"}' });
      statuses.push(lone.status);
      api201.loneSurrogate = lone.status;
      const lens = await all(`select id::text id, char_length(provider_response) cp, provider_response from reviews where id = any($1::bigint[]) order by id`, [[A[12], A[13], A[14], A[15], A[16]].map(Number)]);
      const byId = Object.fromEntries(lens.map((l) => [l.id, l]));
      evidence.unicodeApi = { statuses: api201, lengths: lens.map((l) => ({ id: l.id, cp: l.cp })), loneStored: byId[A[16]]?.provider_response };
      check('26. API boundary in code points: 500 x (e + combining acute) = 1000 cp / 500 graphemes accepted, 1001 cp rejected; 1000 emoji accepted; DB char_length agrees', api201.combining1000 === 201 && api201.combining1001 === 400 && api201.emoji1000 === 201 && byId[A[12]].cp === 1000 && byId[A[14]].cp === 1000, evidence.unicodeApi);
      check('27. Unicode whitespace: NBSP/ideographic/BOM-only text 400; CRLF -> LF and Unicode spaces trimmed at the ends, kept inside', api201.nbspOnly === 400 && api201.crlfUnicodeTrim === 201 && byId[A[13]].provider_response === 'Line one\nLine two', evidence.unicodeApi);
      check('documented policy: other control characters are accepted (only NUL is rejected); a lone surrogate is stored as U+FFFD (1 code point, lengths still agree)', api201.control === 201 && byId[A[15]].provider_response === 'bell\u0007inside' && api201.loneSurrogate === 201 && byId[A[16]].provider_response === 'a�b' && byId[A[16]].cp === 3, evidence.unicodeApi);
    }
    {
      const r23 = A[23];
      const set = (resp, by, at) => sqlState(`update reviews set provider_response = $2, responded_by = $3, responded_at = $4 where id = $1`, [r23, resp, by, at]);
      const reset = () => db.query(`update reviews set provider_response = null, responded_by = null, responded_at = null where id = $1`, [r23]);
      const cases = {};
      const run = async (label, ...args) => { cases[label] = await set(...args); await reset(); };
      const now = new Date();
      await run('NBSP only', ' ', ids.ownerA, now);
      await run('leading ideographic space', '　hi', ids.ownerA, now);
      await run('trailing NBSP', 'hi ', ids.ownerA, now);
      await run('leading BOM', '﻿hi', ids.ownerA, now);
      await run('trailing line separator', 'hi ', ids.ownerA, now);
      await run('inner NBSP', 'h i', ids.ownerA, now);
      await run('U+180E (not whitespace in JS)', '᠎hi', ids.ownerA, now);
      await run('1000 cp combining', 'é'.repeat(500), ids.ownerA, now);
      await run('1001 cp combining', 'é'.repeat(500) + '́', ids.ownerA, now);
      await run('text without time', 'hi', ids.ownerA, null);
      await run('time without text', null, null, now);
      await run('responder without text', null, ids.ownerA, null);
      evidence.dbChecks = cases;
      const ok = ['inner NBSP', 'U+180E (not whitespace in JS)', '1000 cp combining'];
      check('29. DB CHECK: rejects Unicode-blank / Unicode-padded text and malformed response state (23514); accepts what the API can produce', Object.entries(cases).every(([k, v]) => (ok.includes(k) ? v === 'ok' : v === '23514')), cases);
      const temp = (await one(`insert into users(full_name, email, password_hash, role, status) values ('QA temp2', $1, $2, 'CUSTOMER', 'ACTIVE') returning id::text id`, [mail('temp2'), hash])).id;
      await db.query(`update reviews set provider_response = 'kept', responded_by = $2, responded_at = now() where id = $1`, [r23, temp]);
      const del = await sqlState(`delete from users where id = $1`, [temp]);
      const kept = await row(r23);
      check('28. deleting the responder keeps the response text and timestamp (responded_by NULL)', del === 'ok' && kept.provider_response === 'kept' && kept.responded_by === null && kept.responded_at !== null, { del, kept });
    }
    {
      const bodies = JSON.stringify([(await call('GET', '/providers/me/reviews?limit=50', { token: T.ownerA })).body, (await call('GET', '/providers/me/reviews?limit=50', { token: T.staffA })).body, (await adminList()).body]);
      const own = (await call('GET', '/providers/me/reviews?limit=50', { token: T.ownerA })).body.items.map((i) => i.id);
      check('30. no private customer data in provider/admin bodies (no email, phone, health note, booking note); A\'s list never contains B\'s reviews', !bodies.includes('@qa.test') && !bodies.includes('private health') && !bodies.includes('private note') && !/"phone"|"email"/.test(bodies) && !own.some((i) => B.includes(i)), { own: own.length });
    }

    section('6. Regression');
    const reg = {
      pending: (await call('POST', `/bookings/${pendingA}/reviews`, { token: T.cust1, body: { rating: 3 } })).status,
      cancelled: (await call('POST', `/bookings/${cancelledA}/reviews`, { token: T.cust1, body: { rating: 3 } })).status,
      foreign: (await call('POST', `/bookings/${bookings.B[0]}/reviews`, { token: T.cust1, body: { rating: 3 } })).status,
      duplicate: (await call('POST', `/bookings/${bookings.A[0]}/reviews`, { token: T.cust1, body: { rating: 3 } })).status,
      duplicateOfHidden: (await call('POST', `/bookings/${bookings.A[1]}/reviews`, { token: T.cust1, body: { rating: 3 } })).status,
    };
    const uniq = (await one(`select count(*)::int n from (select booking_id from reviews group by booking_id having count(*) > 1) d`)).n;
    check('31/32. P2-14: PENDING/CANCELLED booking 409, other customer\'s booking 404, duplicate 409 (also for a hidden review); no booking has two reviews', reg.pending === 409 && reg.cancelled === 409 && reg.foreign === 404 && reg.duplicate === 409 && reg.duplicateOfHidden === 409 && uniq === 0, reg);
    const mineKeys = [...new Set(mine.body.flatMap((i) => Object.keys(i)))].sort().join();
    check('33. /reviews/mine unchanged (entity shape incl. respondedBy id, own hidden reviews included)', mineKeys === 'bookingId,comment,createdAt,id,isVisible,providerResponse,rating,respondedAt,respondedBy,updatedAt', mineKeys);
    const final = await adminList();
    check('34. admin moderation functional end to end (list 200, every item has the documented projection)', final.status === 200 && final.body.every((i) => 'respondedBy' in i && 'providerResponse' in i && 'respondedAt' in i && 'isVisible' in i), final.status);
    const cmp = await call('POST', `/bookings/${cancelledA}/complaints`, { token: T.cust1, body: { reason: 'Cancelled without notice' } });
    const inReview = await call('PATCH', `/admin/complaints/${cmp.body.id}/review`, { token: T.admin, body: {} });
    const resolved = await call('PATCH', `/admin/complaints/${cmp.body.id}/resolve`, { token: T.admin, body: { adminNote: 'handled' } });
    check('35. complaint workflow unaffected: create 201 OPEN -> IN_REVIEW -> RESOLVED', cmp.status === 201 && cmp.body.status === 'OPEN' && inReview.body.status === 'IN_REVIEW' && resolved.status === 200 && resolved.body.status === 'RESOLVED', [cmp.status, inReview.status, resolved.status]);

    section('7. Global');
    const allLogs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    const leaked = secrets.filter(Boolean).filter((s) => allLogs.includes(s)).length;
    check(`logs: no password / JWT secret / tokens (${secrets.length} checked); no response text; no SQL errors`, leaked === 0 && !allLogs.includes('Race B response') && !/QueryFailedError|deadlock detected/i.test(allLogs), { leaked });
    check('no HTTP 5xx in the whole run', !statuses.some((s) => s >= 500), statuses.filter((s) => s >= 500));
    const dl = await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`);
    check('0 deadlocks', dl.d === 0, dl);
    evidence.httpCalls = statuses.length;
  } finally {
    if (sideConnected) {
      await side.query('ROLLBACK').catch(() => undefined);
      await side.end().catch(() => undefined);
    }
    while (apps.length) await apps.pop().stop().catch(() => undefined);
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'review-moderation', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
