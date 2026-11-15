/*
 * P3-BE06-03 booking events -> inbox notifications + push outbox — real HTTP
 * + real PostgreSQL (disposable QA database only). No worker, provider or
 * Firebase exists in this subtask; nothing is sent.
 *
 *   npm run build
 *   npm run qa:booking-events
 *
 * Phases
 *   A  2 instances, push disabled (development default): six events,
 *      recipients, actor exclusion, inactive staff, keys/targets, payload,
 *      idempotent replay, concurrent duplicate transitions, unauthorized
 *      transitions, rollback on notification failure, inbox-only.
 *   B  2 instances, PUSH_DELIVERY_MODE=mock: inbox + one outbox job per new
 *      notification, rollback on outbox failure, no provider activity.
 *   C  concurrency: confirm vs suspension of the recipient, booking creation
 *      vs suspension of the provider owner (bounded, 0 deadlocks).
 * Environment: QA_DB_NAME, QA_PORTS (default 8241,8242), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, sleep, prepareDatabase, dropDatabase, createApp, createApi, sourceMigrationCount } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_booking_events';
const PORTS = (process.env.QA_PORTS ?? '8241,8242').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-bookev-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaPassword123!';
const RUN = 'e' + Date.now().toString(36);
const TZ = 'Asia/Ho_Chi_Minh';
const SECRET_REASON = 'PRIVATE-REASON call me 0909123456 jane@example.com';
const REQUEST_TIMEOUT_MS = 15_000;

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const vnDate = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86400000));
const sorted = (a) => [...a].sort((x, y) => Number(x) - Number(y));
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const apps = [];
  const start = async (env, tag) => {
    const logDir = path.join(OUT_DIR, `logs-${tag}`);
    fs.mkdirSync(logDir, { recursive: true });
    for (const port of PORTS) {
      const app = createApp(NAME, [port], { logDir, jwtSecret: JWT_SECRET, env });
      await app.start();
      apps.push(app);
    }
  };
  const stopAll = async () => { while (apps.length) await apps.pop().stop(); };
  const rawApi = createApi(PORTS);
  // Every request is bounded: a hung transaction fails the run instead of blocking it.
  const api = (method, url, opts = {}) => Promise.race([
    rawApi(method, url, opts),
    sleep(REQUEST_TIMEOUT_MS).then(() => ({ status: 'TIMEOUT', body: null, headers: new Map() })),
  ]);

  try {
    check(`all ${migrations.length} source migrations applied (incl. outbox), 0 pending DDL`, migrations.length === sourceMigrationCount() && migrations.includes('CreateNotificationDeliveries1796500000000') && pendingDdl.length === 0, { last: migrations.slice(-2), pendingDdl });

    // ------------------------------------------------------------------ phase A
    section('A. Push disabled (default): six events -> inbox only');
    await start({}, 'a');
    const mail = (n) => `${n}.${RUN}@qa.test`;
    await db.query(`insert into users(full_name, email, password_hash, role, status) values ('QA Admin', $1, $2, 'ADMIN', 'ACTIVE')`, [mail('admin'), await bcrypt.hash(PASSWORD, 10)]);
    const login = async (n) => { const r = await api('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } }); if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`); return r.body.accessToken; };
    const ADMIN = await login('admin');
    const CATEGORY = String((await api('POST', '/admin/service-categories', { token: ADMIN, body: { name: `Grooming ${RUN}` } })).body.id);
    const PET_TYPE = String((await api('POST', '/admin/pet-types', { token: ADMIN, body: { name: `Dog ${RUN}` } })).body.id);
    const register = async (n) => { const r = await api('POST', '/auth/register', { body: { fullName: `QA ${n}`, email: mail(n), password: PASSWORD } }); if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body)); return { n, t: r.body.accessToken, id: String(r.body.user.id) }; };
    const customer = async (n) => { const c = await register(n); const pet = await api('POST', '/pets', { token: c.t, body: { petTypeId: PET_TYPE, name: `Pet ${n}` } }); return { ...c, pet: String(pet.body.id) }; };
    const provider = async (n) => {
      const o = await register(n);
      const p = await api('POST', '/providers', { token: o.t, body: { businessName: `${RUN} ${n} Spa`, address: `${n} Street`, phone: '0911000000', description: 'QA' } });
      const pid = String(p.body.id);
      await api('PATCH', `/admin/providers/${pid}/approve`, { token: ADMIN });
      for (let d = 0; d <= 6; d++) await api('POST', '/providers/working-hours', { token: o.t, body: { dayOfWeek: d, startTime: '08:00', endTime: '20:00' } });
      const s = await api('POST', '/services', { token: o.t, body: { categoryId: CATEGORY, name: `Grooming ${n} ${RUN}`, price: 150000, durationMinutes: 60, description: 'QA' } });
      return { ...o, pid, service: String(s.body.id) };
    };
    let slotN = 0;
    const slot = async (P, capacity = 30) => {
      const k = slotN++;
      const h = 8 + (k % 11);
      const r = await api('POST', '/availability', { token: P.t, body: { serviceId: P.service, slotDate: vnDate(2 + Math.floor(k / 11)), startTime: `${String(h).padStart(2, '0')}:00`, endTime: `${String(h + 1).padStart(2, '0')}:00`, capacity } });
      if (r.status !== 201) throw new Error('slot ' + JSON.stringify(r.body));
      return String(r.body.id);
    };
    const book = async (c, slotId, opts = {}) => {
      const r = await api('POST', '/bookings', { token: c.t, key: opts.key, body: { petId: c.pet, slotId } });
      if (r.status !== 201 && !opts.allowFailure) throw new Error('book ' + r.status + ' ' + JSON.stringify(r.body));
      return r;
    };
    const act = (actor, id, verb, body) => api('POST', `/bookings/provider/${id}/${verb}`, { token: actor.t, body: body ?? (['confirm', 'complete'].includes(verb) ? undefined : {}) });
    const cancel = (c, id, body = {}) => api('POST', `/bookings/mine/${id}/cancel`, { token: c.t, body });
    const notifs = (bookingId, type) => all(`select n.id::text, n.recipient_user_id::text r, n.type, n.title, n.body, n.payload, n.target_type, n.target_id::text tid, n.event_key, d.id::text job, d.recipient_user_id::text job_r, d.status job_status from notifications n left join notification_deliveries d on d.notification_id = n.id where n.target_type = 'BOOKING' and n.target_id = $1 ${type ? 'and n.type = $2' : ''} order by n.recipient_user_id`, type ? [bookingId, type] : [bookingId]);
    const logId = async (bookingId, status) => (await one(`select id::text from booking_status_logs where booking_id = $1 and new_status = $2`, [bookingId, status]))?.id;
    const bookingState = (id) => one(`select b.status, s.booked_count::int booked, (select count(*)::int from booking_status_logs l where l.booking_id = b.id) logs, (select count(*)::int from notifications n where n.target_type = 'BOOKING' and n.target_id = b.id) notes from bookings b join availability_slots s on s.id = b.slot_id where b.id = $1`, [id]);

    const P = await provider('owner');
    const STAFF = await register('staff');
    const STAFF2 = await register('staff2');
    const STAFF_OFF = await register('staffoff');
    for (const s of [STAFF, STAFF2]) await api('POST', '/providers/staff', { token: P.t, body: { userId: s.id, position: 'Groomer' } });
    const off = await api('POST', '/providers/staff', { token: P.t, body: { userId: STAFF_OFF.id, position: 'Former' } });
    await api('DELETE', `/providers/staff/${off.body.id}`, { token: P.t });
    STAFF.t = await login('staff');
    STAFF2.t = await login('staff2');
    const C = await customer('alice');
    const MAL = await customer('mallory');
    const P2 = await provider('other');
    const PROVIDER_SIDE = [P.id, STAFF.id, STAFF2.id];
    const inactive = await one(`select status from provider_staff where user_id = $1`, [STAFF_OFF.id]);
    check('setup: owner + 2 ACTIVE staff; one staff INACTIVE; unrelated customer and provider', inactive.status === 'INACTIVE');

    const resolutions = {};
    // E1 created
    const s1 = await slot(P);
    const createdRes = await book(C, s1, { key: `key-${RUN}-0001-create` });
    const b1 = String(createdRes.body.id);
    let n = await notifs(b1, 'BOOKING_CREATED');
    const key1 = `booking:${b1}:log:${await logId(b1, 'PENDING_CONFIRMATION')}`;
    resolutions.E1 = n.map((x) => x.r);
    check('E1 BOOKING_CREATED -> owner + ACTIVE staff (not customer, not INACTIVE staff, not unrelated users)', same(n.map((x) => x.r), PROVIDER_SIDE), n.map((x) => x.r));
    check('event key booking:{id}:log:{statusLogId}; target BOOKING/{id}; display payload', n.every((x) => x.event_key === key1 && x.target_type === 'BOOKING' && x.tid === b1 && Object.keys(x.payload).sort().join() === 'bookingId,petName,serviceName,slotDate,startTime,status' && x.payload.status === 'PENDING_CONFIRMATION'), n[0]);
    check('push disabled -> inbox rows only, no outbox job', n.every((x) => x.job === null));

    // 7: idempotent creation retry
    const replay = await book(C, s1, { key: `key-${RUN}-0001-create` });
    check('creation retry with the same Idempotency-Key -> replayed, no new notifications', replay.status === 201 && replay.headers.get('idempotent-replayed') === 'true' && String(replay.body.id) === b1 && (await notifs(b1)).length === 3);

    // 9: unauthorized transitions
    const unauth = await Promise.all([act(P2, b1, 'confirm'), act(MAL, b1, 'confirm'), cancel(MAL, b1), act(C, b1, 'confirm'), act(P2, b1, 'reject', { reason: 'x' })]);
    check('unauthorized transitions (other provider, customer on provider route, other customer) -> 403/404, no notification', unauth.every((r) => [403, 404].includes(r.status)) && (await notifs(b1)).length === 3 && (await bookingState(b1)).status === 'PENDING_CONFIRMATION', unauth.map((r) => r.status));

    // 8: concurrent duplicate confirm (2 instances, owner + 2 staff)
    const actors = [P, STAFF, STAFF2];
    const conf = await Promise.all(Array.from({ length: 9 }, (_, i) => act(actors[i % 3], b1, 'confirm')));
    n = await notifs(b1, 'BOOKING_CONFIRMED');
    evidence.concurrentConfirm = conf.map((r) => r.status);
    const winner = conf.findIndex((r) => r.status === 200 || r.status === 201);
    check('9 concurrent confirms -> one 2xx, others 409, exactly one BOOKING_CONFIRMED for the customer', conf.filter((r) => r.status === 200 || r.status === 201).length === 1 && conf.filter((r) => r.status === 409).length === 8 && n.length === 1 && n[0].r === C.id, { statuses: evidence.concurrentConfirm, n });
    resolutions.E2 = n.map((x) => x.r);
    void winner;

    // E5 completed (staff actor)
    const comp = await act(STAFF2, b1, 'complete');
    n = await notifs(b1, 'BOOKING_COMPLETED');
    resolutions.E5 = n.map((x) => x.r);
    check('E5 BOOKING_COMPLETED -> customer only', [200, 201].includes(comp.status) && n.length === 1 && n[0].r === C.id);

    // E3 rejected with a sensitive reason
    const b2 = String((await book(C, await slot(P))).body.id);
    const rej = await act(STAFF, b2, 'reject', { reason: SECRET_REASON });
    n = await notifs(b2, 'BOOKING_REJECTED');
    resolutions.E3 = n.map((x) => x.r);
    check('E3 BOOKING_REJECTED -> customer only ("Booking declined")', [200, 201].includes(rej.status) && n.length === 1 && n[0].r === C.id && n[0].title === 'Booking declined');

    // E4 cancelled by customer with a sensitive reason
    const b3 = String((await book(C, await slot(P))).body.id);
    const can = await cancel(C, b3, { reason: SECRET_REASON });
    n = await notifs(b3, 'BOOKING_CANCELLED');
    resolutions.E4 = n.map((x) => x.r);
    check('E4 BOOKING_CANCELLED (by customer) -> owner + ACTIVE staff, not the customer', [200, 201].includes(can.status) && same(n.map((x) => x.r), PROVIDER_SIDE), n.map((x) => x.r));

    // E6 no-show with a sensitive reason (the slot must have started)
    const s4 = await slot(P);
    const b4 = String((await book(C, s4)).body.id);
    await act(P, b4, 'confirm');
    await db.query(`update availability_slots set slot_date = $2 where id = $1`, [s4, vnDate(-1)]);
    const ns = await act(STAFF, b4, 'no-show', { reason: SECRET_REASON });
    n = await notifs(b4, 'BOOKING_NO_SHOW');
    resolutions.E6 = n.map((x) => x.r);
    check('E6 BOOKING_NO_SHOW -> customer only', [200, 201].includes(ns.status) && n.length === 1 && n[0].r === C.id, { status: ns.status, body: ns.body });
    evidence.recipients = resolutions;

    {
      const b5 = String((await book(C, await slot(P))).body.id);
      const notes = await notifs(b5, 'BOOKING_CREATED');
      check('each recipient appears once per event (deduplicated)', new Set(notes.map((x) => x.r)).size === notes.length && notes.length === 3);
    }
    {
      // customer -> staff role change: the acting staff member is the booking's customer
      const DUAL = await customer('dual');
      const bd = String((await book(DUAL, await slot(P))).body.id);
      await api('POST', '/providers/staff', { token: P.t, body: { userId: DUAL.id, position: 'New hire' } });
      DUAL.t = await login('dual');
      PROVIDER_SIDE.push(DUAL.id); // now ACTIVE staff: a recipient of later provider-side events
      const r = await act(DUAL, bd, 'confirm');
      const nd = await notifs(bd, 'BOOKING_CONFIRMED');
      check('actor exclusion: staff member confirming their own (pre-hire) booking is not notified of their own action', [200, 201].includes(r.status) && nd.length === 0, { status: r.status, nd });
    }

    // 16: no free-text reasons in any notification
    const leaked = (await one(`select count(*)::int c from notifications where title ilike '%PRIVATE-REASON%' or body ilike '%PRIVATE-REASON%' or payload::text ilike '%PRIVATE-REASON%' or body ~ '0909123456|@example'`)).c;
    const storedReasons = (await one(`select count(*)::int c from booking_status_logs where reason = $1`, [SECRET_REASON])).c;
    check('reject/cancel/no-show reasons stay in booking_status_logs only, never in notification title/body/payload', leaked === 0 && storedReasons === 3, { leaked, storedReasons });

    // 15: booking HTTP responses carry no notification fields
    check('booking HTTP responses unchanged (no notification/outbox fields added)', ![createdRes, comp, rej, can, ns].some((r) => /notification|eventKey|outbox|delivery/i.test(JSON.stringify(r.body))));

    // 10: rollback on notification failure
    {
      const s6 = await slot(P);
      const b6 = String((await book(C, s6)).body.id);
      const before = await bookingState(b6);
      await db.query(`create or replace function qa_fail_notif() returns trigger language plpgsql as $$ begin raise exception 'qa injected notification failure'; end $$`);
      await db.query(`create trigger qa_fail_notif before insert on notifications for each row when (new.type = 'BOOKING_CONFIRMED' and new.recipient_user_id = ${Number(C.id)}) execute function qa_fail_notif()`);
      const r = await act(P, b6, 'confirm');
      await db.query(`drop trigger qa_fail_notif on notifications; drop function qa_fail_notif()`);
      const after = await bookingState(b6);
      check('notification insert fails -> 500 and the transition rolls back (status, status log, slot, notifications unchanged)', r.status === 500 && JSON.stringify(after) === JSON.stringify(before) && after.status === 'PENDING_CONFIRMATION', { status: r.status, before, after });
      const again = await act(P, b6, 'confirm');
      check('the same transition succeeds afterwards and produces exactly one event', [200, 201].includes(again.status) && (await notifs(b6, 'BOOKING_CONFIRMED')).length === 1);
      // creation path rollback
      const s7 = await slot(P2);
      const slotBefore = (await one(`select booked_count::int c from availability_slots where id = $1`, [s7])).c;
      await db.query(`create or replace function qa_fail_notif() returns trigger language plpgsql as $$ begin raise exception 'qa injected notification failure'; end $$`);
      await db.query(`create trigger qa_fail_notif before insert on notifications for each row when (new.recipient_user_id = ${Number(P2.id)}) execute function qa_fail_notif()`);
      const rc = await book(C, s7, { allowFailure: true });
      await db.query(`drop trigger qa_fail_notif on notifications; drop function qa_fail_notif()`);
      const rowsAfter = (await one(`select count(*)::int c from bookings where slot_id = $1`, [s7])).c;
      const slotAfter = (await one(`select booked_count::int c from availability_slots where id = $1`, [s7])).c;
      check('creation: notification failure -> 500, no booking, no capacity consumed', rc.status === 500 && rowsAfter === 0 && slotAfter === slotBefore, { status: rc.status, rowsAfter, slotBefore, slotAfter });
    }
    check('phase A wrote no outbox job (push disabled)', (await one(`select count(*)::int c from notification_deliveries`)).c === 0);
    await stopAll();

    // ------------------------------------------------------------------ phase B
    section('B. Push enabled (mock, QA only): inbox + outbox');
    await start({ PUSH_DELIVERY_MODE: 'mock', PUSH_DELIVERY_TTL_SECONDS: '3600' }, 'b');
    for (const u of [P, STAFF, STAFF2, C, MAL, P2]) u.t = await login(u.n);
    {
      const bB = String((await book(C, await slot(P), { key: `key-${RUN}-0002-create` })).body.id);
      let nb = await notifs(bB, 'BOOKING_CREATED');
      check(`creation -> ${PROVIDER_SIDE.length} notifications (owner + ACTIVE staff, incl. the newly hired one), each with exactly one PENDING job for the same recipient`, same(nb.map((x) => x.r), PROVIDER_SIDE) && nb.every((x) => x.job && x.job_status === 'PENDING' && x.job_r === x.r), nb);
      const replayB = await book(C, await slot(P), { key: `key-${RUN}-0002-create`, allowFailure: true });
      check('reusing the Idempotency-Key with a different slot -> 409, no notification or job', replayB.status === 409 && (await notifs(bB)).length === PROVIDER_SIDE.length);
      const confB = await Promise.all(Array.from({ length: 6 }, (_, i) => act(actors[i % 3], bB, 'confirm')));
      nb = await notifs(bB, 'BOOKING_CONFIRMED');
      const jobsForBooking = (await one(`select count(*)::int c, count(distinct notification_id)::int d from notification_deliveries d join notifications n on n.id = d.notification_id where n.target_id = $1`, [bB]));
      check('concurrent confirms -> one notification, one job; never more than one job per notification', confB.filter((r) => [200, 201].includes(r.status)).length === 1 && nb.length === 1 && nb[0].job && jobsForBooking.c === jobsForBooking.d && jobsForBooking.c === PROVIDER_SIDE.length + 1, { statuses: confB.map((r) => r.status), jobsForBooking });
      const jobs = await all(`select d.status, d.attempt_count, d.lease_owner, extract(epoch from d.expires_at - d.created_at)::int ttl from notification_deliveries d`);
      check('jobs stay PENDING with 0 attempts (no worker, no provider call during the transaction); TTL 3600s', jobs.length === PROVIDER_SIDE.length + 1 && jobs.every((j) => j.status === 'PENDING' && j.attempt_count === 0 && j.lease_owner === null && j.ttl === 3600), jobs);

      // 11: rollback on enqueue failure
      const bF = String((await book(C, await slot(P))).body.id);
      const before = await bookingState(bF);
      const jobsBefore = (await one(`select count(*)::int c from notification_deliveries`)).c;
      await db.query(`create or replace function qa_fail_outbox() returns trigger language plpgsql as $$ begin raise exception 'qa injected outbox failure'; end $$`);
      await db.query(`create trigger qa_fail_outbox before insert on notification_deliveries for each row when (new.recipient_user_id = ${Number(C.id)}) execute function qa_fail_outbox()`);
      const r = await act(STAFF, bF, 'confirm');
      await db.query(`drop trigger qa_fail_outbox on notification_deliveries; drop function qa_fail_outbox()`);
      const after = await bookingState(bF);
      check('outbox insert fails -> 500 and the transition rolls back (status, log, slot, inbox, jobs unchanged)', r.status === 500 && JSON.stringify(after) === JSON.stringify(before) && (await one(`select count(*)::int c from notification_deliveries`)).c === jobsBefore, { status: r.status, before, after });
      const ok = await act(STAFF, bF, 'confirm');
      nb = await notifs(bF, 'BOOKING_CONFIRMED');
      check('retrying the transition after the failure -> one notification + one job', [200, 201].includes(ok.status) && nb.length === 1 && nb[0].job);
    }
    const outboxLogs = fs.readdirSync(path.join(OUT_DIR, 'logs-b')).map((f) => fs.readFileSync(path.join(OUT_DIR, 'logs-b', f), 'utf8')).join('\n');
    // BE06-05: the delivery worker exists but must stay disabled by default (never started, no job processed).
    check('apps log the outbox mode; the delivery worker stays disabled (never started); no Firebase activity', /Push outbox enabled \(mode=mock/.test(outboxLogs) && /Push delivery worker disabled/.test(outboxLogs) && !/firebase|worker \S+ started|Push job \d+/i.test(outboxLogs));

    // ------------------------------------------------------------------ phase C
    section('C. Concurrency: transitions vs account suspension (bounded, deadlock check)');
    const deadlocksBefore = (await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`)).d;
    {
      const ROUNDS = 8;
      const rounds = [];
      for (let i = 0; i < ROUNDS; i++) {
        const cu = await customer(`cs${i}`);
        const bk = String((await book(cu, await slot(P))).body.id);
        const t0 = Date.now();
        const [confirm, suspend] = await Promise.all([act(i % 2 ? STAFF : P, bk, 'confirm'), api('PATCH', `/admin/users/${cu.id}/suspend`, { token: ADMIN })]);
        const ms = Date.now() - t0;
        const state = await one(`select b.status, u.status ustatus, (select count(*)::int from notifications n where n.target_id = b.id and n.type = 'BOOKING_CONFIRMED' and n.recipient_user_id = u.id) notes, (select count(*)::int from notification_deliveries d join notifications n on n.id = d.notification_id where n.target_id = b.id and n.type = 'BOOKING_CONFIRMED') jobs from bookings b join users u on u.id = b.customer_id where b.id = $1`, [bk]);
        rounds.push({ confirm: confirm.status, suspend: suspend.status, ms, ...state });
      }
      evidence.confirmVsSuspension = rounds;
      check(`${ROUNDS} x (confirm || suspend the customer): both complete within ${REQUEST_TIMEOUT_MS / 1000}s, no 5xx, booking CONFIRMED + customer SUSPENDED + exactly one notification and one job`, rounds.every((r) => [200, 201].includes(r.confirm) && r.suspend === 200 && r.status === 'CONFIRMED' && r.ustatus === 'SUSPENDED' && r.notes === 1 && r.jobs === 1), rounds);
    }
    {
      const ROUNDS = 6;
      const rounds = [];
      for (let i = 0; i < ROUNDS; i++) {
        const Pi = await provider(`po${i}`);
        const sl = await slot(Pi);
        const t0 = Date.now();
        const [created, suspend] = await Promise.all([book(C, sl, { allowFailure: true }), api('PATCH', `/admin/users/${Pi.id}/suspend`, { token: ADMIN })]);
        const ms = Date.now() - t0;
        const notes = created.status === 201 ? (await notifs(String(created.body.id), 'BOOKING_CREATED')).filter((x) => x.r === Pi.id).length : null;
        rounds.push({ create: created.status, suspend: suspend.status, ms, ownerNotified: notes });
      }
      evidence.createVsOwnerSuspension = rounds;
      check(`${ROUNDS} x (create booking || suspend the provider owner): bounded, no 5xx, owner notification written exactly once when the booking committed`, rounds.every((r) => typeof r.create === 'number' && r.create < 500 && r.suspend === 200 && (r.create !== 201 || r.ownerNotified === 1)), rounds);
    }
    await sleep(1500); // let PostgreSQL flush per-database statistics
    const deadlocksAfter = (await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`)).d;
    const appLogs = fs.readdirSync(OUT_DIR).filter((d) => d.startsWith('logs-')).flatMap((d) => fs.readdirSync(path.join(OUT_DIR, d)).map((f) => fs.readFileSync(path.join(OUT_DIR, d, f), 'utf8'))).join('\n');
    evidence.deadlocks = { before: deadlocksBefore, after: deadlocksAfter, inLogs: (appLogs.match(/deadlock detected|40P01/g) ?? []).length };
    check('0 deadlocks (pg_stat_database counter unchanged, none in app logs)', deadlocksAfter === deadlocksBefore && evidence.deadlocks.inLogs === 0, evidence.deadlocks);

    section('D. Invariants');
    const inv = await one(`select
      (select count(*)::int from notifications n join bookings b on b.id = n.target_id where n.target_type = 'BOOKING'
         and n.recipient_user_id <> b.customer_id
         and n.recipient_user_id not in (select owner_id from providers where id = b.provider_id)
         and n.recipient_user_id not in (select user_id from provider_staff where provider_id = b.provider_id)) as unrelated_recipient,
      (select count(*)::int from (select recipient_user_id, event_key from notifications where event_key like 'booking:%' group by 1, 2 having count(*) > 1) x) as duplicate_events,
      (select count(*)::int from notifications n where n.event_key like 'booking:%' and not exists (select 1 from booking_status_logs l where n.event_key = 'booking:' || l.booking_id || ':log:' || l.id)) as key_without_log,
      (select count(*)::int from booking_status_logs l where not exists (select 1 from notifications n where n.event_key = 'booking:' || l.booking_id || ':log:' || l.id)
         and not exists (select 1 from bookings b where b.id = l.booking_id and b.customer_id = l.changed_by and l.new_status = 'CONFIRMED')) as log_without_event,
      (select count(*)::int from notification_deliveries d join notifications n on n.id = d.notification_id where d.recipient_user_id <> n.recipient_user_id) as job_recipient_mismatch`);
    evidence.invariants = inv;
    check('no unrelated recipient, no duplicate (recipient, event), every booking event key maps to a status log, every status log produced its event (except the self-confirm case), job recipient = notification recipient', Object.values(inv).every((v) => v === 0), inv);
    const tooMany = await one(`select count(*)::int c from (select notification_id from notification_deliveries group by 1 having count(*) > 1) x`);
    check('at most one delivery job per notification', tooMany.c === 0);
  } finally {
    await stopAll().catch(() => undefined);
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'booking-events', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
