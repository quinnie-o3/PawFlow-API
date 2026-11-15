/*
 * P3-BE08-02 provider feedback: real HTTP + real PostgreSQL on a disposable
 * QA database only. Two API instances.
 *
 *   npm run build
 *   npm run qa:provider-feedback
 *
 * Environment: QA_DB_NAME (default pawflow_qa_provider_feedback), QA_PORTS
 * (default 8311,8312), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, DB, Client, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount, keyPaths, forbiddenIn } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_provider_feedback';
const PORTS = (process.env.QA_PORTS ?? '8311,8312').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-feedback-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaFeedbackPass123!';
const RUN = 'pf' + Date.now().toString(36);
const NEW_MIGRATION = 'AddReviewResponseConstraints1797500000000';
const PREV_MIGRATION = 'CreateNotificationPreferences1797000000000';
const MARK = `qa-secret-response-${RUN}`;

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

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
  const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')] });
  const side = new Client({ ...DB, database: NAME }); // second connection that holds row locks

  try {
    section('0. Migration');
    const idx = migrations.indexOf(NEW_MIGRATION);
    check(`all ${migrations.length} source migrations applied; ${NEW_MIGRATION} is last and right after ${PREV_MIGRATION}; entities = schema (0 pending DDL)`, migrations.length === sourceMigrationCount() && idx === migrations.length - 1 && migrations[idx - 1] === PREV_MIGRATION && pendingDdl.length === 0, { last: migrations.slice(-3), pendingDdl });
    const defs = Object.fromEntries((await all(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'reviews'::regclass`)).map((c) => [c.conname, c.d]));
    evidence.constraints = { consistency: defs.chk_reviews_response_consistency, text: defs.chk_reviews_response_text, responderFk: defs.fk_reviews_responder, unique: Object.entries(defs).filter(([, d]) => d.startsWith('UNIQUE (booking_id)')).map(([n]) => n) };
    check('constraints present; fk_reviews_responder still ON DELETE SET NULL; UNIQUE(booking_id) intact', !!defs.chk_reviews_response_consistency && !!defs.chk_reviews_response_text && /ON DELETE SET NULL/.test(defs.fk_reviews_responder) && evidence.constraints.unique.length === 1, evidence.constraints);

    // ---------------------------------------------------------------- seed
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    for (const [n, role] of [['ownerA', 'PROVIDER_OWNER'], ['ownerB', 'PROVIDER_OWNER'], ['ownerC', 'PROVIDER_OWNER'], ['ownerX', 'PROVIDER_OWNER'], ['ownerD', 'PROVIDER_OWNER'], ['staffA', 'CUSTOMER'], ['staffOff', 'PROVIDER_STAFF'], ['staffGone', 'CUSTOMER'], ['cust1', 'CUSTOMER'], ['cust2', 'CUSTOMER'], ['admin', 'ADMIN'], ['ghost', 'PROVIDER_OWNER']]) {
      ids[n] = (await one(`insert into users(full_name, email, phone, password_hash, role, status) values ($1, $2, $3, $4, $5, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), hash, role])).id;
    }
    const petType = (await one(`insert into pet_types(name) values ($1) returning id::text id`, ['Dog ' + RUN])).id;
    const category = (await one(`insert into service_categories(name) values ($1) returning id::text id`, ['Grooming ' + RUN])).id;
    const pet = {};
    for (const c of ['cust1', 'cust2']) pet[c] = (await one(`insert into pets(owner_id, pet_type_id, name, health_note) values ($1, $2, $3, 'secret health note') returning id::text id`, [ids[c], petType, 'Pet ' + c])).id;
    const prov = {};
    const svc = {};
    const slot = {};
    for (const p of ['A', 'B', 'C']) {
      prov[p] = (await one(`insert into providers(owner_id, business_name, address, phone, approval_status) values ($1, $2, 'QA street', '0900000000', 'APPROVED') returning id::text id`, [ids['owner' + p], `QA Provider ${p} ${RUN}`])).id;
      svc[p] = (await one(`insert into services(provider_id, category_id, name, price, duration_minutes) values ($1, $2, $3, 100000, 60) returning id::text id`, [prov[p], category, `Service ${p}`])).id;
      slot[p] = (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity, booked_count) values ($1, $2, current_date - 1, '09:00', '10:00', 200, 0) returning id::text id`, [prov[p], svc[p]])).id;
    }
    prov.D = (await one(`insert into providers(owner_id, business_name, address, approval_status) values ($1, $2, 'QA street', 'APPROVED') returning id::text id`, [ids.ownerD, `QA Provider D ${RUN}`])).id;
    await db.query(`insert into provider_staff(provider_id, user_id, status) values ($1, $2, 'ACTIVE'), ($1, $3, 'INACTIVE'), ($1, $4, 'ACTIVE')`, [prov.A, ids.staffA, ids.staffOff, ids.staffGone]);
    await db.query(`update users set role = 'PROVIDER_STAFF' where id in ($1, $2)`, [ids.staffA, ids.staffGone]);
    const bookings = { A: [], B: [], C: [] };
    const newBooking = async (p, c, status = 'COMPLETED') => {
      const b = (await one(`insert into bookings(customer_id, pet_id, provider_id, service_id, slot_id, status, booked_price, customer_note) values ($1, $2, $3, $4, $5, $6, 100000, 'private note') returning id::text id`, [ids[c], pet[c], prov[p], svc[p], slot[p], status])).id;
      await db.query(`insert into booking_status_logs(booking_id, old_status, new_status) values ($1, null, $2)`, [b, status]);
      await db.query(`update availability_slots set booked_count = booked_count + 1 where id = $1`, [slot[p]]);
      return b;
    };
    for (let i = 0; i < 30; i++) bookings.A.push(await newBooking('A', i % 2 ? 'cust2' : 'cust1'));
    for (let i = 0; i < 3; i++) bookings.B.push(await newBooking('B', 'cust1'));
    for (let i = 0; i < 2; i++) bookings.C.push(await newBooking('C', 'cust2'));
    const pendingA = await newBooking('A', 'cust1', 'PENDING_CONFIRMATION');

    section('0b. Migration rehearsal on existing data (down / invalid row / up)');
    await ds.initialize();
    {
      // A responded review and an unresponded one exist before the rehearsal.
      await db.query(`insert into reviews(booking_id, rating, comment, provider_response, responded_by, responded_at) values ($1, 4, 'pre', 'Pre-existing reply', $2, now() - interval '1 day')`, [bookings.C[0], ids.ownerC]);
      const fingerprint = async () => (await one(`select count(*)::int n, md5(string_agg(r::text, '|' order by r.id)) h from reviews r`));
      const before = await fingerprint();
      await ds.undoLastMigration({ transaction: 'each' });
      const downDefs = (await all(`select conname from pg_constraint where conrelid = 'reviews'::regclass and conname like 'chk_reviews_response%'`)).length;
      const afterDown = await fingerprint();
      // While the constraints are absent, an invalid row makes the preflight abort.
      const bad = (await one(`insert into reviews(booking_id, rating, provider_response) values ($1, 3, '  ') returning id::text id`, [bookings.C[1]])).id;
      let preflight = null;
      try { await ds.runMigrations({ transaction: 'each' }); } catch (e) { preflight = e.message; }
      const stillDown = (await all(`select conname from pg_constraint where conrelid = 'reviews'::regclass and conname like 'chk_reviews_response%'`)).length;
      await db.query(`delete from reviews where id = $1`, [bad]);
      const again = await ds.runMigrations({ transaction: 'each' });
      const pend = (await ds.driver.createSchemaBuilder().log()).upQueries.length;
      const afterUp = await fingerprint();
      evidence.rehearsal = { downConstraints: downDefs, preflight, constraintsAfterFailedUp: stillDown, reapplied: again.map((m) => m.name), pendingDdl: pend };
      check('M1. down drops only the two constraints (reviews data unchanged)', downDefs === 0 && afterDown.h === before.h, { before, afterDown, downDefs });
      check('M2. up with an invalid existing row -> preflight aborts with counts only, nothing applied', /preflight failed: 1 review\(s\) with inconsistent response columns, 1 with invalid response text/.test(preflight ?? '') && stillDown === 0 && !(preflight ?? '').includes('  '), evidence.rehearsal);
      check('M3. re-apply on existing data -> applied, data unchanged, 0 pending DDL', again.length === 1 && again[0].name === NEW_MIGRATION && pend === 0 && afterUp.h === before.h, evidence.rehearsal);
    }

    section('0c. CHECK semantics (direct SQL)');
    {
      const b = bookings.C[1];
      const ins = (resp, by, at) => sqlState(`insert into reviews(booking_id, rating, provider_response, responded_by, responded_at) values ($1, 5, $2, $3, $4)`, [b, resp, by, at]);
      const clean = () => db.query(`delete from reviews where booking_id = $1`, [b]);
      const cases = {};
      const run = async (label, ...args) => { cases[label] = await ins(...args); await clean(); };
      await run('no response', null, null, null);
      await run('valid', 'Thanks', ids.ownerC, new Date());
      await run('text+time, responder NULL (deleted account)', 'Thanks', null, new Date());
      await run('text without time', 'Thanks', ids.ownerC, null);
      await run('time without text', null, null, new Date());
      await run('responder without text', null, ids.ownerC, null);
      await run('empty', '', ids.ownerC, new Date());
      await run('spaces only', '   ', ids.ownerC, new Date());
      await run('tab/newline only', '\t\n\r', ids.ownerC, new Date());
      await run('leading space', ' a', ids.ownerC, new Date());
      await run('trailing newline', 'a\n', ids.ownerC, new Date());
      await run('inner newline', 'a\nb', ids.ownerC, new Date());
      await run('1000 ASCII', 'a'.repeat(1000), ids.ownerC, new Date());
      await run('1001 ASCII', 'a'.repeat(1001), ids.ownerC, new Date());
      await run('1000 emoji (2000 UTF-16 units)', '\u{1F436}'.repeat(1000), ids.ownerC, new Date());
      await run('1001 emoji', '\u{1F436}'.repeat(1001), ids.ownerC, new Date());
      await run('1000 Vietnamese', 'ữ'.repeat(1000), ids.ownerC, new Date());
      evidence.checkCases = cases;
      const expectOk = ['no response', 'valid', 'text+time, responder NULL (deleted account)', 'inner newline', '1000 ASCII', '1000 emoji (2000 UTF-16 units)', '1000 Vietnamese'];
      check('M4. CHECKs: consistent triple, responder optional, 1-1000 code points, no blank / surrounding ASCII whitespace (23514 otherwise)', Object.entries(cases).every(([k, v]) => (expectOk.includes(k) ? v === 'ok' : v === '23514')), cases);

      // Responder deletion: FK SET NULL still works with the constraints.
      const temp = (await one(`insert into users(full_name, email, password_hash, role, status) values ('QA temp responder', $1, $2, 'CUSTOMER', 'ACTIVE') returning id::text id`, [mail('temp'), hash])).id;
      await db.query(`insert into reviews(booking_id, rating, provider_response, responded_by, responded_at) values ($1, 5, 'Kept text', $2, now())`, [b, temp]);
      const del = await sqlState(`delete from users where id = $1`, [temp]);
      const kept = await one(`select provider_response, responded_by, responded_at is not null has_time from reviews where booking_id = $1`, [b]);
      check('M5. deleting a responder account -> responded_by NULL, response text and time kept', del === 'ok' && kept.provider_response === 'Kept text' && kept.responded_by === null && kept.has_time, { del, kept });
      await clean();
    }

    // ---------------------------------------------------------------- apps
    const logDir = path.join(OUT_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    for (const port of PORTS) {
      const app = createApp(NAME, [port], { logDir, jwtSecret: JWT_SECRET });
      await app.start();
      apps.push(app);
    }
    const login = async (n) => { const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } }); if (r.status !== 200) throw new Error(`login ${n}: ${r.status} ${JSON.stringify(r.body)}`); secrets.push(r.body.accessToken, r.body.refreshToken); return r.body.accessToken; };
    const T = {};
    for (const n of ['ownerA', 'ownerB', 'ownerC', 'staffA', 'staffOff', 'staffGone', 'cust1', 'cust2', 'admin', 'ownerX', 'ownerD']) T[n] = await login(n);

    // Reviews through the real P2-14 endpoint (rating aggregates maintained by the app).
    const reviewIds = { A: [], B: [], C: [] };
    for (const p of ['A', 'B', 'C']) {
      const list = p === 'C' ? [bookings.C[1]] : bookings[p].slice(0, p === 'A' ? 26 : 3);
      for (let i = 0; i < list.length; i++) {
        const cust = (await one(`select u.email from bookings b join users u on u.id = b.customer_id where b.id = $1`, [list[i]])).email.startsWith('cust1') ? 'cust1' : 'cust2';
        const r = await call('POST', `/bookings/${list[i]}/reviews`, { token: T[cust], body: { rating: (i % 5) + 1, comment: `Review ${p}${i}` } });
        if (r.status !== 201) throw new Error(`seed review ${p}${i}: ${r.status} ${JSON.stringify(r.body)}`);
        reviewIds[p].push(String(r.body.id));
      }
    }
    const preC = (await one(`select id::text id from reviews where booking_id = $1`, [bookings.C[0]])).id;
    reviewIds.C.unshift(preC);
    const A = reviewIds.A; // 26 reviews of provider A
    const url = (q = '') => `/providers/me/reviews${q}`;
    const respond = (token, id, body, port) => call('POST', `/providers/me/reviews/${id}/response`, { token, body, port });

    section('1. Provider list: scope and roles');
    const la = await call('GET', url('?limit=50'), { token: T.ownerA });
    const dbA = (await all(`select r.id::text id from reviews r join bookings b on b.id = r.booking_id where b.provider_id = $1`, [prov.A])).map((r) => r.id);
    check('1. owner A lists exactly its own reviews (DB-checked), standard envelope', la.status === 200 && sameSet(la.body.items.map((i) => i.id), dbA) && la.body.meta.totalItems === 26 && la.body.query.maxId === A[A.length - 1], { status: la.status, meta: la.body.meta, query: la.body.query });
    const lb = await call('GET', url('?limit=50'), { token: T.ownerB });
    check('2/10. owner B sees only its 3 reviews; total and maxId anchor reveal nothing about A', lb.status === 200 && sameSet(lb.body.items.map((i) => i.id), reviewIds.B) && lb.body.meta.totalItems === 3 && lb.body.query.maxId === reviewIds.B[2] && !lb.body.items.some((i) => A.includes(i.id)), lb.body.query);
    const ls = await call('GET', url('?limit=50'), { token: T.staffA });
    check('3. ACTIVE staff of A reads A\'s feedback', ls.status === 200 && sameSet(ls.body.items.map((i) => i.id), dbA), ls.status);
    const off = await call('GET', url(), { token: T.staffOff });
    const staffRow = (await one(`select id::text id from provider_staff where user_id = $1`, [ids.staffGone])).id;
    const deact = await call('PATCH', `/providers/staff/${staffRow}`, { token: T.ownerA, body: { status: 'INACTIVE' } });
    const gone = await call('GET', url(), { token: T.staffGone });
    evidence.inactiveStaff = { inactiveRowRoleStaff: off.status, message: off.body.message, deactivate: deact.status, afterDeactivation: gone.status };
    check('4. inactive staff -> 403 (INACTIVE row with role still PROVIDER_STAFF; and staff deactivated through the API, role reverted)', off.status === 403 && off.body.message === 'Active provider staff association is required' && deact.status === 200 && gone.status === 403, evidence.inactiveStaff);
    const c1 = await call('GET', url(), { token: T.cust1 });
    const adm = await call('GET', url(), { token: T.admin });
    const anon = await call('GET', url());
    const ghost = await call('GET', url(), { token: await login('ghost') });
    check('5/6. customer -> 403, admin -> 403, anonymous -> 401, owner without provider -> 404', c1.status === 403 && adm.status === 403 && anon.status === 401 && ghost.status === 404 && ghost.body.message === 'Provider profile not found', [c1.status, adm.status, anon.status, ghost.status]);
    const tamper = await Promise.all([url(`?providerId=${prov.B}`), url(`?provider=${prov.B}`), url(`?ownerId=${ids.ownerB}`)].map((u) => call('GET', u, { token: T.ownerA })));
    check('6b. provider-id tampering in the query -> 400 (unknown parameter), never another scope', tamper.every((r) => r.status === 400), tamper.map((r) => r.status));
    const badQ = await Promise.all(['?page=0', '?limit=51', '?rating=0', '?rating=6', '?rating=x', '?maxId=-1', '?maxId=abc', '?sort=random', '?visibility=deleted', '?responded=yes'].map((q) => call('GET', url(q), { token: T.ownerA })));
    check('query validation -> 400 for page/limit/rating/maxId/sort/visibility/responded', badQ.every((r) => r.status === 400), badQ.map((r) => r.status));

    section('2. Response creation');
    const r1 = A[0];
    const t0 = new Date((await one('select now() n')).n);
    const created = await respond(T.ownerA, r1, { text: `  Thank you!\r\nSee you soon ${MARK}  ` });
    const t1 = new Date((await one('select now() n')).n);
    const row1 = await one(`select provider_response, responded_by::text, responded_at, updated_at from reviews where id = $1`, [r1]);
    evidence.created = { status: created.status, body: created.body };
    check('11. owner responds -> 201 with the review in the provider shape; text normalized (CRLF->LF, trimmed)', created.status === 201 && created.body.id === r1 && created.body.response.text === `Thank you!\nSee you soon ${MARK}` && row1.provider_response === created.body.response.text, created.body);
    check('12. responded_by = authenticated owner; response.respondedBy = { id, fullName }', row1.responded_by === ids.ownerA && JSON.stringify(created.body.response.respondedBy) === JSON.stringify({ id: ids.ownerA, fullName: 'QA ownerA' }), row1);
    check('13. responded_at is the PostgreSQL clock (between DB readings) and is what the API returns', row1.responded_at >= t0 && row1.responded_at <= t1 && created.body.response.respondedAt === row1.responded_at.toISOString(), { t0, t1, db: row1.responded_at, api: created.body.response.respondedAt });
    const forged = {};
    for (const [label, extra] of [['respondedBy', { respondedBy: ids.cust1 }], ['respondedAt', { respondedAt: '2000-01-01T00:00:00Z' }], ['providerId', { providerId: prov.B }], ['userId', { userId: ids.ownerB }], ['unknown', { foo: 1 }]]) {
      forged[label] = (await respond(T.ownerA, A[1], { text: 'Forged', ...extra })).status;
    }
    check('14. forged respondedBy / respondedAt / providerId / userId / unknown -> 400; nothing written', Object.values(forged).every((s) => s === 400) && (await one(`select provider_response from reviews where id = $1`, [A[1]])).provider_response === null, forged);
    const st = await respond(T.staffA, A[1], { text: 'Staff reply' });
    check('15. ACTIVE staff cannot respond -> 403; nothing written', st.status === 403 && (await one(`select provider_response from reviews where id = $1`, [A[1]])).provider_response === null, st.status);
    const crossB = await respond(T.ownerB, A[1], { text: 'Cross' });
    const missing = await respond(T.ownerB, '987654321', { text: 'Missing' });
    const badId = await respond(T.ownerA, 'abc', { text: 'x' });
    check('16/17. another provider\'s review and a missing review -> identical 404 bodies; invalid id -> 400', crossB.status === 404 && missing.status === 404 && JSON.stringify(crossB.body) === JSON.stringify(missing.body) && crossB.body.message === 'Review not found' && badId.status === 400, { crossB: crossB.body, missing: missing.body, badId: badId.status });
    const others = [await respond(T.cust1, A[1], { text: 'x' }), await respond(T.admin, A[1], { text: 'x' }), await respond(undefined, A[1], { text: 'x' })];
    check('customer -> 403, admin -> 403, anonymous -> 401 on respond', others.map((r) => r.status).join() === '403,403,401', others.map((r) => r.status));

    // Hidden review (admin hide through the existing endpoint).
    const hiddenIds = [A[2], A[3]];
    for (const id of hiddenIds) { const h = await call('PATCH', `/admin/reviews/${id}/hide`, { token: T.admin }); if (h.status !== 200) throw new Error('hide ' + h.status); }
    const hid = await respond(T.ownerA, A[2], { text: 'Reply to hidden' });
    check('18. hidden review -> 409 "Hidden reviews cannot be responded to"; nothing written', hid.status === 409 && hid.body.message === 'Hidden reviews cannot be responded to' && (await one(`select provider_response from reviews where id = $1`, [A[2]])).provider_response === null, hid.body);
    const dup = await respond(T.ownerA, r1, { text: 'Second reply' }, PORTS[1]);
    const dupSame = await respond(T.ownerA, r1, { text: `Thank you!\nSee you soon ${MARK}` });
    const row1b = await one(`select provider_response, responded_by::text, responded_at from reviews where id = $1`, [r1]);
    check('19. second response (different or identical text, either instance) -> 409; text, responder and time unchanged', dup.status === 409 && dupSame.status === 409 && dup.body.message === 'Review already has a response' && row1b.provider_response === row1.provider_response && row1b.responded_at.getTime() === row1.responded_at.getTime() && row1b.responded_by === ids.ownerA, { dup: dup.body, dupSame: dupSame.status });

    {
      const target = A[4];
      const texts = Array.from({ length: 12 }, (_, i) => `Concurrent ${i}`);
      const rs = await Promise.all(texts.map((text, i) => respond(T.ownerA, target, { text }, PORTS[i % 2])));
      const counts = rs.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
      const winner = rs.findIndex((r) => r.status === 201);
      const stored = await one(`select provider_response, responded_by::text from reviews where id = $1`, [target]);
      evidence.concurrent = { counts, stored: stored.provider_response };
      check('20. 12 concurrent responses (two instances) -> exactly 1x201 + 11x409; stored text is the winner\'s', counts[201] === 1 && counts[409] === 11 && stored.provider_response === texts[winner] && stored.responded_by === ids.ownerA, evidence.concurrent);
    }

    const invalid = {};
    for (const [label, text] of [['empty', ''], ['spaces', '    '], ['unicode spaces', '  \n\t'], ['1001 ASCII', 'a'.repeat(1001)], ['1001 emoji', '\u{1F436}'.repeat(1001)], ['NUL', 'a\u0000b'], ['number', 42], ['null', null], ['object', { a: 1 }]]) {
      invalid[label] = (await respond(T.ownerA, A[5], { text })).status;
    }
    invalid.missing = (await respond(T.ownerA, A[5], {})).status;
    check('21. invalid / blank / oversized / NUL / non-string / missing text -> 400; nothing written', Object.values(invalid).every((s) => s === 400) && (await one(`select provider_response from reviews where id = $1`, [A[5]])).provider_response === null, invalid);
    const emoji = await respond(T.ownerA, A[5], { text: ' ' + '\u{1F436}'.repeat(1000) + '\n' });
    const ascii = await respond(T.ownerA, A[6], { text: 'b'.repeat(1000) });
    const lens = await one(`select char_length(provider_response) e, octet_length(provider_response) eb, (select char_length(provider_response) from reviews where id = $2) a from reviews where id = $1`, [A[5], A[6]]);
    check('22. Unicode boundary: 1000 emoji (2000 UTF-16 units) and 1000 ASCII accepted; DB char_length 1000 for both (same rule as the CHECK)', emoji.status === 201 && ascii.status === 201 && lens.e === 1000 && lens.a === 1000 && lens.eb === 4000, { emoji: emoji.status, ascii: ascii.status, lens });

    const susp = await call('PATCH', `/admin/providers/${prov.C}/suspend`, { token: T.admin });
    const cList = await call('GET', url(), { token: T.ownerC });
    const cResp = await respond(T.ownerC, reviewIds.C[1], { text: 'Suspended reply' });
    check('23. SUSPENDED provider: list 200 (reads allowed), respond 403 "A SUSPENDED provider cannot respond to reviews"', susp.status === 200 && cList.status === 200 && cList.body.meta.totalItems === 2 && cResp.status === 403 && cResp.body.message === 'A SUSPENDED provider cannot respond to reviews', { susp: susp.status, list: cList.status, resp: cResp.body });

    section('3. Locked races (a second connection holds the row lock, then commits a change)');
    await side.connect();
    // Waits until the API request is blocked on a lock held by `side`.
    const waitBlocked = async () => {
      for (let i = 0; i < 100; i++) {
        const w = await one(`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (w.n > 0) return true;
        await sleep(30);
      }
      return false;
    };
    const race = async (label, lockSql, changeSql, reviewId, token = T.ownerA, undoSql) => {
      await side.query('BEGIN');
      await side.query(lockSql[0], lockSql[1]);
      const pending = respond(token, reviewId, { text: `Race ${label}` });
      const blocked = await waitBlocked();
      await side.query(changeSql[0], changeSql[1]);
      await side.query('COMMIT');
      const r = await pending;
      const row = await one(`select provider_response from reviews where id = $1`, [reviewId]);
      if (undoSql) await db.query(undoSql[0], undoSql[1]);
      return { status: r.status, message: r.body?.message, blocked, written: row.provider_response !== null };
    };
    const races = {};
    races.suspend = await race('suspend', [`select 1 from providers where id = $1 for update`, [prov.A]], [`update providers set approval_status = 'SUSPENDED' where id = $1`, [prov.A]], A[7], T.ownerA, [`update providers set approval_status = 'APPROVED' where id = $1`, [prov.A]]);
    races.ownership = await race('ownership', [`select 1 from providers where id = $1 for update`, [prov.A]], [`update providers set owner_id = $2 where id = $1`, [prov.A, ids.ownerX]], A[7], T.ownerA, [`update providers set owner_id = $2 where id = $1`, [prov.A, ids.ownerA]]);
    races.hide = await race('hide', [`select 1 from reviews where id = $1 for update`, [A[7]]], [`update reviews set is_visible = false where id = $1`, [A[7]]], A[7], T.ownerA, [`update reviews set is_visible = true where id = $1`, [A[7]]]);
    races.otherResponse = await race('other', [`select 1 from reviews where id = $1 for update`, [A[7]]], [`update reviews set provider_response = 'Committed first', responded_by = $2, responded_at = now() where id = $1`, [A[7], ids.ownerA]], A[7]);
    races.accountSuspended = await race('account', [`select 1 from users where id = $1 for update`, [ids.ownerA]], [`update users set status = 'SUSPENDED' where id = $1`, [ids.ownerA]], A[8], T.ownerA, [`update users set status = 'ACTIVE' where id = $1`, [ids.ownerA]]);
    races.logout = await race('logout', [`select 1 from auth_sessions where user_id = $1 and revoked_at is null for update`, [ids.ownerA]], [`update auth_sessions set revoked_at = now(), revoked_reason = 'LOGOUT' where user_id = $1 and revoked_at is null`, [ids.ownerA]], A[8]);
    T.ownerA = await login('ownerA');
    races.commitFirst = await race('committed-first', [`select 1 from providers where id = $1 for update`, [prov.A]], [`select 1`, []], A[8]);
    evidence.races = races;
    check('6/23. suspension committed while the response waits on the provider lock -> 403, nothing written', races.suspend.blocked && races.suspend.status === 403 && !races.suspend.written, races.suspend);
    check('ownership change committed while waiting -> 404, nothing written', races.ownership.blocked && races.ownership.status === 404 && !races.ownership.written, races.ownership);
    check('24. admin-style hide committed while the response waits on the review lock -> 409 hidden, nothing written', races.hide.blocked && races.hide.status === 409 && races.hide.message === 'Hidden reviews cannot be responded to' && !races.hide.written, races.hide);
    check('response committed by another transaction first -> 409, the committed text kept', races.otherResponse.blocked && races.otherResponse.status === 409 && (await one(`select provider_response from reviews where id = $1`, [A[7]])).provider_response === 'Committed first', races.otherResponse);
    check('account suspended while waiting on the user lock -> 401, nothing written', races.accountSuspended.blocked && races.accountSuspended.status === 401 && !races.accountSuspended.written, races.accountSuspended);
    check('session revoked (logout) while waiting on the session lock -> 401, nothing written', races.logout.blocked && races.logout.status === 401 && !races.logout.written, races.logout);
    check('lock released without change -> the waiting response succeeds (201)', races.commitFirst.blocked && races.commitFirst.status === 201 && races.commitFirst.written, races.commitFirst);

    {
      // Real admin hide vs owner response on fresh reviews, fired together.
      const targets = A.slice(9, 15);
      const http = await Promise.all(targets.map(async (id, i) => {
        const [h, r] = await Promise.all([
          call('PATCH', `/admin/reviews/${id}/hide`, { token: T.admin, port: PORTS[i % 2] }),
          respond(T.ownerA, id, { text: `Raced ${i}` }, PORTS[(i + 1) % 2]),
        ]);
        return { id, hide: h.status, respond: r.status };
      }));
      const outcomes = [];
      for (const o of http) {
        const row = await one(`select is_visible, provider_response is not null responded from reviews where id = $1`, [o.id]);
        outcomes.push({ hide: o.hide, respond: o.respond, ...row });
      }
      evidence.hideRace = outcomes;
      check('24b. 6 real admin hide || owner response pairs -> hide always 200; response 201 (stored, then hidden) or 409 (nothing stored); never 5xx', outcomes.every((o) => o.hide === 200 && !o.is_visible && ((o.respond === 201 && o.responded) || (o.respond === 409 && !o.responded))), outcomes);
      // Restore them for the regression section.
      for (const id of targets) await call('PATCH', `/admin/reviews/${id}/restore`, { token: T.admin });

      // D4, the other order: a response that exists before the hide is kept,
      // disappears from the public list with the review, and returns on restore.
      const later = A[15];
      const resp = await respond(T.ownerA, later, { text: 'Answered before moderation' });
      const before = await one(`select provider_response, responded_by::text, responded_at from reviews where id = $1`, [later]);
      const hide = await call('PATCH', `/admin/reviews/${later}/hide`, { token: T.admin });
      const hiddenRow = await one(`select is_visible, provider_response, responded_by::text, responded_at from reviews where id = $1`, [later]);
      const publicHidden = (await call('GET', `/reviews/provider/${prov.A}`)).body.some((i) => String(i.id) === later);
      const ownerView = (await call('GET', url('?visibility=hidden&limit=50'), { token: T.ownerA })).body.items.find((i) => i.id === later);
      const restoreLater = await call('PATCH', `/admin/reviews/${later}/restore`, { token: T.admin });
      const publicBack = (await call('GET', `/reviews/provider/${prov.A}`)).body.find((i) => String(i.id) === later);
      evidence.respondThenHide = { respond: resp.status, hide: hide.status, publicHidden, ownerSees: !!ownerView?.response, restored: restoreLater.status };
      check('24c. response before an admin hide is preserved (text, responder, time unchanged); hidden from the public, shown to the owner with isVisible:false; back on restore', resp.status === 201 && hide.status === 200 && hiddenRow.is_visible === false && hiddenRow.provider_response === before.provider_response && hiddenRow.responded_by === before.responded_by && hiddenRow.responded_at.getTime() === before.responded_at.getTime() && !publicHidden && ownerView?.isVisible === false && ownerView?.response?.text === 'Answered before moderation' && restoreLater.status === 200 && publicBack?.providerResponse === 'Answered before moderation', evidence.respondThenHide);
    }

    section('4. Listing: hidden reviews, filters, pagination');
    const full = await call('GET', url('?limit=50'), { token: T.ownerA });
    const byId = Object.fromEntries(full.body.items.map((i) => [i.id, i]));
    check('7. hidden reviews are listed for the owner with isVisible:false; visibility filters match the DB', hiddenIds.every((id) => byId[id]?.isVisible === false) && (await call('GET', url('?visibility=hidden'), { token: T.ownerA })).body.meta.totalItems === 2 && (await call('GET', url('?visibility=visible'), { token: T.ownerA })).body.meta.totalItems === 24, hiddenIds.map((id) => byId[id]?.isVisible));
    check('7b. staff sees the same hidden flags', (await call('GET', url('?visibility=hidden'), { token: T.staffA })).body.items.every((i) => hiddenIds.includes(i.id)));
    const dbCounts = await one(`select count(*) filter (where r.rating = 5)::int five, count(*) filter (where r.provider_response is not null)::int resp, count(*) filter (where r.provider_response is null)::int unresp, count(*) filter (where r.rating = 1 and not r.is_visible)::int one_hidden from reviews r join bookings b on b.id = r.booking_id where b.provider_id = $1`, [prov.A]);
    const fr = {
      five: (await call('GET', url('?rating=5'), { token: T.ownerA })).body,
      resp: (await call('GET', url('?responded=responded&limit=50'), { token: T.ownerA })).body,
      unresp: (await call('GET', url('?responded=unresponded'), { token: T.ownerA })).body.meta.totalItems,
      oneHidden: (await call('GET', url('?rating=1&visibility=hidden'), { token: T.ownerA })).body.meta.totalItems,
    };
    check('9. rating / responded / combined filters match DB counts; responded items all carry a response', fr.five.meta.totalItems === dbCounts.five && fr.five.items.every((i) => i.rating === 5) && fr.resp.meta.totalItems === dbCounts.resp && fr.resp.items.every((i) => i.response !== null) && fr.unresp === dbCounts.unresp && fr.oneHidden === dbCounts.one_hidden, { fr: { five: fr.five.meta.totalItems, resp: fr.resp.meta.totalItems, unresp: fr.unresp, oneHidden: fr.oneHidden }, dbCounts });

    // Every sort: pages of 4 concatenated == the DB order, no duplicates; then a
    // new review arrives and later pages with maxId are unaffected.
    const orderSql = { newest: 'r.created_at desc, r.id desc', oldest: 'r.created_at asc, r.id asc', rating_desc: 'r.rating desc, r.created_at desc, r.id desc', rating_asc: 'r.rating asc, r.created_at desc, r.id desc' };
    const paging = {};
    let inserted = null;
    for (const sort of Object.keys(orderSql)) {
      const first = await call('GET', url(`?sort=${sort}&limit=4`), { token: T.ownerA });
      const anchor = first.body.query.maxId;
      const expected = (await all(`select r.id::text id from reviews r join bookings b on b.id = r.booking_id where b.provider_id = $1 and r.id <= $2 order by ${orderSql[sort]}`, [prov.A, anchor])).map((r) => r.id);
      const firstSort = !inserted;
      if (firstSort) {
        const r = await call('POST', `/bookings/${bookings.A[26]}/reviews`, { token: T.cust1, body: { rating: 5, comment: 'Arrived during paging' } });
        inserted = String(r.body.id);
      }
      const seen = first.body.items.map((i) => i.id);
      for (let page = 2; page <= first.body.meta.totalPages; page++) {
        const r = await call('GET', url(`?sort=${sort}&limit=4&page=${page}&maxId=${anchor}`), { token: T.ownerA, port: PORTS[page % 2] });
        seen.push(...r.body.items.map((i) => i.id));
      }
      paging[sort] = { ok: seen.join() === expected.join() && new Set(seen).size === seen.length && (!firstSort || !seen.includes(inserted)), pages: first.body.meta.totalPages, items: seen.length };
    }
    const fresh = await call('GET', url('?limit=1'), { token: T.ownerA });
    evidence.paging = paging;
    check('8. stable pagination for every sort (pages of 4 == DB order, no duplicates/gaps); a review created mid-paging stays out of maxId pages and is first on a fresh first page', Object.values(paging).every((p) => p.ok) && fresh.body.items[0].id === inserted && fresh.body.query.maxId === inserted, { paging, fresh: fresh.body.items.map((i) => i.id), inserted });
    const past = await call('GET', url('?page=999'), { token: T.ownerA });
    const empty = await call('GET', url(), { token: T.ownerD });
    check('page past the end -> 200 empty with accurate totals; provider without reviews -> 200 empty, totalPages 0, maxId null', past.status === 200 && past.body.items.length === 0 && past.body.meta.totalItems === 27 && empty.status === 200 && empty.body.items.length === 0 && empty.body.meta.totalPages === 0 && empty.body.query.maxId === null, { past: past.body.meta, empty: empty.body });

    section('5. Regression');
    const p214 = {
      pending: (await call('POST', `/bookings/${pendingA}/reviews`, { token: T.cust1, body: { rating: 5 } })).status,
      foreign: (await call('POST', `/bookings/${bookings.A[27]}/reviews`, { token: T.cust1, body: { rating: 5 } })).status,
      range: (await call('POST', `/bookings/${bookings.A[28]}/reviews`, { token: T.cust1, body: { rating: 6 } })).status,
      provider: (await call('POST', `/bookings/${bookings.A[28]}/reviews`, { token: T.ownerA, body: { rating: 5 } })).status,
      okCust1: (await call('POST', `/bookings/${bookings.A[28]}/reviews`, { token: T.cust1, body: { rating: 4 } })).status,
    };
    p214.duplicate = (await call('POST', `/bookings/${bookings.A[28]}/reviews`, { token: T.cust1, body: { rating: 4 } })).status;
    p214.duplicateOfHidden = (await call('POST', `/bookings/${bookings.A[2]}/reviews`, { token: T.cust1, body: { rating: 4 } })).status;
    evidence.p214 = p214;
    check('25/26. P2-14 unchanged: non-COMPLETED 409, other customer\'s booking 404, rating 6 400, provider role 403, own COMPLETED 201, duplicate 409 (also when the existing review is hidden)', p214.pending === 409 && p214.foreign === 404 && p214.range === 400 && p214.provider === 403 && p214.okCust1 === 201 && p214.duplicate === 409 && p214.duplicateOfHidden === 409, p214);

    const pub = await call('GET', `/reviews/provider/${prov.A}`);
    const pubKeys = [...new Set(pub.body.flatMap((i) => Object.keys(i)))].sort();
    check('27. public list excludes hidden reviews and keeps its projection (no responder, booking or customer)', pub.status === 200 && !pub.body.some((i) => hiddenIds.includes(i.id)) && pub.body.length === 26 && pubKeys.join() === 'comment,createdAt,id,providerResponse,rating,respondedAt', { len: pub.body.length, pubKeys });
    const agg = await all(`select p.id::text id, p.rating_count, p.rating_avg::text avg, (select count(*)::int from reviews r join bookings b on b.id = r.booking_id where b.provider_id = p.id and r.is_visible) visible, (select coalesce(round(avg(r.rating), 2), 0)::text from reviews r join bookings b on b.id = r.booking_id where b.provider_id = p.id and r.is_visible) vavg from providers p where p.id = any($1::bigint[])`, [[prov.A, prov.B].map(Number)]);
    const detailA = await call('GET', `/providers/public/${prov.A}`);
    check('28. rating aggregates = visible rows only (A, B); public detail ratingCount matches; responses never changed them', agg.every((a) => a.rating_count === a.visible && Number(a.avg) === Number(a.vavg)) && detailA.body.ratingCount === 26, { agg, detail: detailA.body.ratingCount });
    const mine = await call('GET', '/reviews/mine', { token: T.cust1 });
    const mineKeys = [...new Set(mine.body.flatMap((i) => Object.keys(i)))].sort().join();
    check('29. /reviews/mine unchanged: entity shape (incl. respondedBy), includes the customer\'s hidden review', mine.status === 200 && mineKeys === 'bookingId,comment,createdAt,id,isVisible,providerResponse,rating,respondedAt,respondedBy,updatedAt' && mine.body.some((i) => i.id === A[2] && i.isVisible === false), mineKeys);
    const logs = await all(`select action, metadata from admin_activity_logs where target_type = 'REVIEW' and target_id = $1 order by id`, [A[2]]);
    const again = await call('PATCH', `/admin/reviews/${A[2]}/hide`, { token: T.admin });
    const restore = await call('PATCH', `/admin/reviews/${A[2]}/restore`, { token: T.admin });
    const logs2 = await all(`select action from admin_activity_logs where target_type = 'REVIEW' and target_id = $1 order by id`, [A[2]]);
    check('30. admin hide/restore unchanged: REVIEW_HIDDEN logged with fromVisible/toVisible/rating metadata, hide twice 409, restore 200 + REVIEW_RESTORED', logs.length === 1 && logs[0].action === 'REVIEW_HIDDEN' && logs[0].metadata.fromVisible === true && logs[0].metadata.toVisible === false && 'ratingCount' in logs[0].metadata && again.status === 409 && restore.status === 200 && logs2.map((l) => l.action).join() === 'REVIEW_HIDDEN,REVIEW_RESTORED', { logs, again: again.status, restore: restore.status });
    const adminView = await call('GET', `/admin/reviews/${r1}`, { token: T.admin });
    evidence.adminViewHasRespondedBy = 'respondedBy' in (adminView.body ?? {});

    const providerBodies = [la.body, full.body, created.body, ls.body];
    const forbidden = ['email', 'phone', 'passwordHash', 'password_hash', 'customerId', 'customer_id', 'ownerId', 'healthNote', 'customerNote', 'bookedPrice', 'updatedAt', 'providerId', 'accessToken'];
    const leaks = providerBodies.flatMap((b) => forbiddenIn(b, forbidden));
    const itemShape = [...new Set(keyPaths(full.body.items[0]))].sort().join();
    const texts = JSON.stringify(providerBodies);
    check('31. provider bodies: no email/phone/password/customer id/pet/notes/price/updatedAt; exact item shape; no contact data values', leaks.length === 0 && itemShape === 'booking,booking.id,booking.service,booking.service.id,booking.service.name,booking.slot,booking.slot.slotDate,booking.slot.startTime,comment,createdAt,customer,customer.fullName,id,isVisible,rating,response' + (full.body.items[0].response ? ',response.respondedAt,response.respondedBy,response.respondedBy.fullName,response.respondedBy.id,response.text' : '') && !texts.includes('@qa.test') && !texts.includes('secret health note') && !texts.includes('private note'), { leaks, itemShape });

    section('6. Logs and global');
    const allLogs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    const leaked = secrets.filter(Boolean).filter((s) => allLogs.includes(s)).length;
    check(`32. logs: no password / JWT secret / tokens (${secrets.length} checked); response text never logged; responses logged as ids only`, leaked === 0 && !allLogs.includes(MARK) && /Provider \d+ responded to review \d+ \(user \d+\)/.test(allLogs) && !/QueryFailedError|deadlock/i.test(allLogs), { leaked, markInLogs: allLogs.includes(MARK) });
    check('no HTTP 5xx in the whole run', !statuses.some((s) => s >= 500), statuses.filter((s) => s >= 500));
    const dl = await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`);
    check('0 deadlocks', dl.d === 0, dl);
    evidence.httpCalls = statuses.length;
  } finally {
    await side.end().catch(() => undefined);
    while (apps.length) await apps.pop().stop().catch(() => undefined);
    if (ds.isInitialized) await ds.destroy();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'provider-feedback', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
