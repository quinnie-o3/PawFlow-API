/*
 * P3-BE10 booking lifecycle races and transition matrix: real HTTP + real
 * PostgreSQL on a disposable QA database only (pawflow_qa_*). Two API
 * instances.
 *
 *   npm run build
 *   npm run qa:booking-races
 *
 * Ordered races use a deterministic barrier instead of sleeps: a second
 * PostgreSQL connection holds the booking row lock (SELECT ... FOR UPDATE),
 * request A is sent and observed waiting in pg_stat_activity, then request
 * B is sent and observed waiting, then the barrier commits. Every
 * transition locks the booking row first, and row-lock waiters are served
 * in arrival order, so A always runs before B. Unordered bursts assert
 * invariants only (outcome sets that hold for any scheduling).
 *
 * Every scenario checks HTTP statuses AND PostgreSQL: booking status, the
 * status-log chain (one row per transition, old = previous new), slot
 * capacity (released exactly once), and notifications (one per recipient
 * per transition: no duplicate event keys).
 *
 * Environment: QA_DB_NAME (default pawflow_qa_booking_races), QA_PORTS
 * (default 8361,8362), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, DB, Client, vnDate, prepareDatabase, dropDatabase, createApp, createApi } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_booking_races';
const PORTS = (process.env.QA_PORTS ?? '8361,8362').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-booking-races-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaBookingRaces123!';
const RUN = 'br' + Date.now().toString(36);
const BARRIER_DEADLINE_MS = 15_000;

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 1200)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const apps = [];
  const api = createApi(PORTS);
  const mail = (n) => `${n}.${RUN}@qa.test`;
  const side = new Client({ ...DB, database: NAME });
  await side.connect();

  try {
    section('0. Schema');
    check('17 migrations applied, 0 pending DDL', migrations.length === 17 && pendingDdl.length === 0, { count: migrations.length, pendingDdl });

    // ------------------------------------------------------------- seed
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    const user = async (n, role) => (ids[n] = (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, $4, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), hash, role])).id);
    for (const [n, role] of [['owner', 'PROVIDER_OWNER'], ['staff', 'PROVIDER_STAFF'], ['staffOff', 'PROVIDER_STAFF'], ['cust', 'CUSTOMER']]) await user(n, role);
    for (let i = 0; i < 8; i++) await user(`racer${i}`, 'CUSTOMER');
    const petType = (await one(`insert into pet_types(name) values ($1) returning id::text id`, ['Dog ' + RUN])).id;
    const category = (await one(`insert into service_categories(name) values ($1) returning id::text id`, ['Walk ' + RUN])).id;
    const provider = (await one(`insert into providers(owner_id, business_name, address, approval_status) values ($1, $2, 'QA road', 'APPROVED') returning id::text id`, [ids.owner, 'QA Races ' + RUN])).id;
    for (let dow = 0; dow < 7; dow++) await db.query(`insert into provider_working_hours(provider_id, day_of_week, start_time, end_time, is_active) values ($1, $2, '07:00', '20:00', true)`, [provider, dow]);
    await db.query(`insert into provider_staff(provider_id, user_id, status) values ($1, $2, 'ACTIVE'), ($1, $3, 'INACTIVE')`, [provider, ids.staff, ids.staffOff]);
    const service = (await one(`insert into services(provider_id, category_id, name, price, duration_minutes) values ($1, $2, 'Walk', 80000, 60) returning id::text id`, [provider, category])).id;
    const inactiveService = (await one(`insert into services(provider_id, category_id, name, price, duration_minutes, status) values ($1, $2, 'Retired', 80000, 60, 'INACTIVE') returning id::text id`, [provider, category])).id;
    const pets = {};
    for (const n of Object.keys(ids).filter((k) => k === 'cust' || k.startsWith('racer'))) pets[n] = (await one(`insert into pets(owner_id, pet_type_id, name) values ($1, $2, $3) returning id::text id`, [ids[n], petType, 'Pet ' + n])).id;
    let hour = 7;
    const newSlot = async (capacity = 20, svc = service) => {
      const h = hour++ % 12 + 7;
      return (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity, booked_count) values ($1, $2, $3, $4, $5, $6, 0) returning id::text id`, [provider, svc, vnDate(3 + Math.floor(hour / 12)), `${String(h).padStart(2, '0')}:00`, `${String(h + 1).padStart(2, '0')}:00`, capacity])).id;
    };

    for (const port of PORTS) { const app = createApp(NAME, [port], { logDir: OUT_DIR, jwtSecret: JWT_SECRET }); await app.start(); apps.push(app); }
    const T = {};
    for (const n of Object.keys(ids)) {
      const r = await api('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`);
      T[n] = r.body.accessToken;
    }

    const act = {
      confirm: (who, id, port) => api('POST', `/bookings/provider/${id}/confirm`, { token: T[who], body: {}, port }),
      reject: (who, id, port) => api('POST', `/bookings/provider/${id}/reject`, { token: T[who], body: { reason: 'Fully booked' }, port }),
      complete: (who, id, port) => api('POST', `/bookings/provider/${id}/complete`, { token: T[who], body: {}, port }),
      noShow: (who, id, port) => api('POST', `/bookings/provider/${id}/no-show`, { token: T[who], body: { reason: 'Did not come' }, port }),
      cancel: (who, id, port) => api('POST', `/bookings/mine/${id}/cancel`, { token: T[who], body: {}, port }),
    };
    const book = async (who = 'cust', slotId) => {
      const slot = slotId ?? (await newSlot());
      const r = await api('POST', '/bookings', { token: T[who], body: { petId: pets[who], slotId: slot } });
      if (r.status !== 201) throw new Error(`booking: ${r.status} ${JSON.stringify(r.body)}`);
      return { id: String(r.body.id), slot };
    };

    /** Booking status, status-log chain, slot capacity and notification counts. */
    const facts = async (bookingId) => {
      const b = await one(`select b.status, s.booked_count, s.capacity from bookings b join availability_slots s on s.id = b.slot_id where b.id = $1`, [bookingId]);
      const logs = await all(`select old_status o, new_status n from booking_status_logs where booking_id = $1 order by id`, [bookingId]);
      const chainOk = logs.length > 0 && logs[0].o === null && logs.every((l, i) => i === 0 || l.o === logs[i - 1].n) && logs.at(-1).n === b.status;
      const notifs = await all(`select type, count(*)::int c, count(distinct event_key)::int k, count(distinct (recipient_user_id, event_key))::int rk from notifications where event_key like $1 group by type`, [`booking:${bookingId}:%`]);
      const dupNotifs = notifs.filter((n) => n.rk !== n.c);
      const byType = Object.fromEntries(notifs.map((n) => [n.type, n.k]));
      return { status: b.status, booked: b.booked_count, logs: logs.map((l) => l.n), chainOk, dupNotifs, events: byType };
    };

    /** Lock the booking row on the side connection; resolves to the release function. */
    const holdBooking = async (bookingId) => {
      await side.query('begin');
      await side.query('select id from bookings where id = $1 for update', [bookingId]);
      return async () => side.query('commit');
    };
    const waiters = async () => (await one(`select count(*)::int c from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).c;
    const waitFor = async (n) => {
      const deadline = Date.now() + BARRIER_DEADLINE_MS;
      while (Date.now() < deadline) {
        if ((await waiters()) >= n) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`barrier: ${n} waiter(s) not observed within ${BARRIER_DEADLINE_MS} ms`);
    };
    /** Runs a then b in that order against the same locked booking. */
    const ordered = async (bookingId, a, b) => {
      const release = await holdBooking(bookingId);
      const pa = a();
      await waitFor(1);
      const pb = b();
      await waitFor(2);
      await release();
      return Promise.all([pa, pb]);
    };

    section('1. Ordered races (row-lock barrier)');
    {
      const { id } = await book();
      const [a, b] = await ordered(id, () => act.confirm('owner', id, PORTS[0]), () => act.confirm('staff', id, PORTS[1]));
      const f = await facts(id);
      check('R1 owner confirm then staff confirm -> 201 / 409; one CONFIRMED log; one BOOKING_CONFIRMED event; no duplicate notifications', a.status === 201 && b.status === 409 && f.status === 'CONFIRMED' && f.logs.join() === 'PENDING_CONFIRMATION,CONFIRMED' && f.chainOk && f.events.BOOKING_CONFIRMED === 1 && f.dupNotifs.length === 0, { a: a.status, b: b.status, f });
    }
    {
      const { id } = await book();
      const [a, b] = await ordered(id, () => act.cancel('cust', id, PORTS[0]), () => act.confirm('owner', id, PORTS[1]));
      const f = await facts(id);
      check('R2 customer cancel then owner confirm -> 201 / 409; CANCELLED; capacity released once (0); no CONFIRMED log or event', a.status === 201 && b.status === 409 && f.status === 'CANCELLED' && f.booked === 0 && f.logs.join() === 'PENDING_CONFIRMATION,CANCELLED' && f.chainOk && !f.events.BOOKING_CONFIRMED && f.dupNotifs.length === 0, { a: a.status, b: b.status, f });
    }
    {
      const { id } = await book();
      const [a, b] = await ordered(id, () => act.confirm('owner', id, PORTS[0]), () => act.cancel('cust', id, PORTS[1]));
      const f = await facts(id);
      check('R3 owner confirm then customer cancel -> 201 / 201 (cancelling a confirmed booking is allowed); chain PENDING -> CONFIRMED -> CANCELLED; capacity released once', a.status === 201 && b.status === 201 && f.status === 'CANCELLED' && f.booked === 0 && f.logs.join() === 'PENDING_CONFIRMATION,CONFIRMED,CANCELLED' && f.chainOk && f.events.BOOKING_CONFIRMED === 1 && f.events.BOOKING_CANCELLED === 1 && f.dupNotifs.length === 0, { a: a.status, b: b.status, f });
    }
    {
      const { id } = await book();
      const [a, b] = await ordered(id, () => act.reject('staff', id, PORTS[0]), () => act.cancel('cust', id, PORTS[1]));
      const f = await facts(id);
      check('R4 staff reject then customer cancel -> 201 / 409; REJECTED; capacity released exactly once', a.status === 201 && b.status === 409 && f.status === 'REJECTED' && f.booked === 0 && f.logs.join() === 'PENDING_CONFIRMATION,REJECTED' && f.chainOk && !f.events.BOOKING_CANCELLED && f.dupNotifs.length === 0, { a: a.status, b: b.status, f });
    }
    {
      const { id } = await book();
      await act.confirm('owner', id);
      const [a, b] = await ordered(id, () => act.complete('owner', id, PORTS[0]), () => act.noShow('staff', id, PORTS[1]));
      const f = await facts(id);
      check('R5 complete then no-show on a CONFIRMED booking -> 201 / 409; COMPLETED; capacity kept (1); one terminal event', a.status === 201 && b.status === 409 && f.status === 'COMPLETED' && f.booked === 1 && f.logs.join() === 'PENDING_CONFIRMATION,CONFIRMED,COMPLETED' && f.chainOk && f.events.BOOKING_COMPLETED === 1 && !f.events.BOOKING_NO_SHOW && f.dupNotifs.length === 0, { a: a.status, b: b.status, f });
    }
    {
      const { id } = await book();
      await act.confirm('owner', id);
      const [a, b] = await ordered(id, () => act.cancel('cust', id, PORTS[0]), () => act.complete('owner', id, PORTS[1]));
      const f = await facts(id);
      check('R6 customer cancel then provider complete on a CONFIRMED booking -> 201 / 409; never completed after cancellation', a.status === 201 && b.status === 409 && f.status === 'CANCELLED' && f.booked === 0 && f.chainOk && !f.events.BOOKING_COMPLETED, { a: a.status, b: b.status, f });
    }

    section('2. Unordered bursts (invariants for any scheduling)');
    {
      const rounds = [];
      for (let round = 0; round < 6; round++) {
        const { id } = await book();
        const burst = await Promise.all([
          act.confirm('owner', id, PORTS[0]), act.confirm('staff', id, PORTS[1]), act.reject('owner', id, PORTS[1]),
          act.cancel('cust', id, PORTS[0]), act.cancel('cust', id, PORTS[1]),
        ]);
        rounds.push({ statuses: burst.map((r) => r.status), f: await facts(id) });
      }
      const bad = rounds.filter(({ statuses, f }) => {
        const okCount = statuses.filter((s) => s === 201).length;
        const counts = f.logs.reduce((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
        return !f.chainOk || f.dupNotifs.length > 0 || statuses.some((s) => s !== 201 && s !== 409) || okCount !== f.logs.length - 1
          || Object.values(counts).some((c) => c > 1) || (['CANCELLED', 'REJECTED'].includes(f.status) ? f.booked !== 0 : f.booked !== 1);
      });
      check('B1 6 rounds x 5 concurrent actions (confirm x2, reject, cancel x2, 2 instances): every 201 is exactly one logged transition, no status logged twice, valid chain, capacity consistent, no duplicate notifications', bad.length === 0, bad.slice(0, 2));
    }
    {
      const slot = await newSlot(1);
      const racers = Object.keys(pets).filter((n) => n.startsWith('racer'));
      const burst = await Promise.all(racers.map((n, i) => api('POST', '/bookings', { token: T[n], body: { petId: pets[n], slotId: slot }, port: PORTS[i % 2] })));
      const statuses = burst.map((r) => r.status).sort().join(',');
      const slotRow = await one(`select booked_count b, (select count(*)::int from bookings where slot_id = $1) n from availability_slots where id = $1`, [slot]);
      check(`B2 ${racers.length} different customers race for the last seat (capacity 1) -> exactly one 201, the rest 409 "full"; one booking row, booked_count 1`, statuses === ['201', ...Array(racers.length - 1).fill('409')].sort().join(',') && slotRow.b === 1 && slotRow.n === 1 && burst.filter((r) => r.status === 409).every((r) => /full/i.test(r.body.message)), { statuses, slotRow });
    }
    {
      const slot = await newSlot(5);
      const key = randomUUID();
      const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => api('POST', '/bookings', { token: T.cust, key, body: { petId: pets.cust, slotId: slot }, port: PORTS[i % 2] })));
      const created = await one(`select count(*)::int n, max(booked_count) b from bookings b join availability_slots s on s.id = b.slot_id where b.slot_id = $1`, [slot]);
      const bodies = new Set(burst.filter((r) => r.status === 201).map((r) => String(r.body.id)));
      check('B3 6 concurrent submissions with one Idempotency-Key (2 instances) -> one booking, every 201 returns it, the rest 409 "still processing"; capacity 1', created.n === 1 && created.b === 1 && bodies.size === 1 && burst.every((r) => r.status === 201 || (r.status === 409 && /processing/i.test(r.body.message))), { statuses: burst.map((r) => r.status), created });
    }

    section('3. Transition matrix and eligibility (HTTP + database)');
    {
      const { id } = await book();
      const before = await facts(id);
      const pendingInvalid = await Promise.all([act.complete('owner', id), act.noShow('owner', id)]);
      check('T1 complete / no-show on PENDING -> 409; nothing written', pendingInvalid.every((r) => r.status === 409) && JSON.stringify(await facts(id)) === JSON.stringify(before), pendingInvalid.map((r) => r.status));
      await act.cancel('cust', id);
      const terminal = await facts(id);
      const afterTerminal = await Promise.all([act.confirm('owner', id), act.reject('owner', id), act.complete('owner', id), act.noShow('owner', id), act.cancel('cust', id)]);
      check('T2 every action on a CANCELLED booking -> 409; no log, capacity or notification change', afterTerminal.every((r) => r.status === 409) && JSON.stringify(await facts(id)) === JSON.stringify(terminal), afterTerminal.map((r) => r.status));
      const { id: id2 } = await book();
      const inactiveStaff = await act.confirm('staffOff', id2);
      const missing = await act.confirm('owner', '999999999');
      check('T3 inactive staff -> 403 (association required); unknown booking -> 404; nothing written', inactiveStaff.status === 403 && missing.status === 404 && (await facts(id2)).status === 'PENDING_CONFIRMATION', { inactiveStaff: inactiveStaff.status, missing: missing.status });
    }
    {
      const count = async () => (await one(`select count(*)::int c from bookings`)).c;
      const full = await newSlot(1);
      await book('racer1', full); // filled by a real booking, so capacity stays consistent
      const before = await count();
      const closed = await newSlot(5);
      await db.query(`update availability_slots set status = 'CLOSED' where id = $1`, [closed]);
      const inactiveSlot = await newSlot(5, inactiveService);
      const tries = {
        'slot full -> 409': [await api('POST', '/bookings', { token: T.cust, body: { petId: pets.cust, slotId: full } }), 409],
        'slot not open -> 409': [await api('POST', '/bookings', { token: T.cust, body: { petId: pets.cust, slotId: closed } }), 409],
        'unknown slot -> 404': [await api('POST', '/bookings', { token: T.cust, body: { petId: pets.cust, slotId: '999999999' } }), 404],
        'inactive service -> 400': [await api('POST', '/bookings', { token: T.cust, body: { petId: pets.cust, slotId: inactiveSlot } }), 400],
        "another customer's pet -> 404": [await api('POST', '/bookings', { token: T.cust, body: { petId: pets.racer0, slotId: await newSlot() } }), 404],
        'provider role cannot book -> 403': [await api('POST', '/bookings', { token: T.owner, body: { petId: pets.cust, slotId: await newSlot() } }), 403],
      };
      const wrong = Object.entries(tries).filter(([, [r, s]]) => r.status !== s).map(([k, [r]]) => [k, r.status, r.body?.message]);
      check(`T4 ${Object.keys(tries).length} ineligible booking attempts get their documented status; no booking row written`, wrong.length === 0 && (await count()) === before, wrong);
    }

    section('4. Global invariants');
    {
      const inv = await one(`
        select
          (select count(*)::int from availability_slots s where s.booked_count <> (select count(*) from bookings b where b.slot_id = s.id and b.status not in ('CANCELLED','REJECTED'))) capacity_mismatch,
          (select count(*)::int from availability_slots where booked_count > capacity or booked_count < 0) capacity_bounds,
          (select count(*)::int from bookings b where b.status <> (select l.new_status from booking_status_logs l where l.booking_id = b.id order by l.id desc limit 1)) last_log_mismatch,
          (select count(*)::int from (select booking_id, new_status from booking_status_logs group by 1, 2 having count(*) > 1) d) status_logged_twice,
          (select count(*)::int from (select recipient_user_id, event_key from notifications where event_key is not null group by 1, 2 having count(*) > 1) d) duplicate_notifications,
          (select deadlocks::int from pg_stat_database where datname = current_database()) deadlocks`);
      check('capacity = active bookings everywhere, within bounds; last log = status; no status logged twice; no duplicate notification; 0 deadlocks', Object.values(inv).every((v) => v === 0), inv);
    }
  } finally {
    await side.query('rollback').catch(() => undefined);
    await side.end();
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
