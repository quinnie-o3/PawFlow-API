/*
 * P3-BE06-02 transactional outbox foundation — real PostgreSQL (disposable
 * QA database only). Exercises the compiled PushOutboxService and the
 * `notification_deliveries` schema; no worker, no provider, no Firebase.
 *
 *   npm run build
 *   npm run qa:push-outbox
 *
 * Environment: QA_DB_NAME (default pawflow_qa_push_outbox), QA_PORTS
 * (default 8231), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp, sourceMigrationCount } = require('./qa-env.cjs');
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_push_outbox';
const PORT = Number(process.env.QA_PORTS ?? 8231);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-outbox-'));
const NEW_MIGRATION = 'CreateNotificationDeliveries1796500000000';
const TTL = 600;
const RUN = 'o' + Date.now().toString(36);

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const rejects = (sql, params) => db.query(sql, params).then(() => null, (e) => ({ code: e.code, message: e.message }));
  const dsOptions = { type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [path.join(ROOT, 'dist', '**', '*.entity.js')], migrations: [path.join(ROOT, 'dist', 'database', 'migrations', '*.js')] };
  const dsA = new DataSource({ ...dsOptions, extra: { max: 15 } });
  const dsB = new DataSource({ ...dsOptions, extra: { max: 15 } });
  let app = null;

  try {
    section('0. Migration and schema');
    check(`all ${migrations.length} source migrations applied (incl. ${NEW_MIGRATION}); entity metadata = schema (0 pending DDL)`, migrations.length === sourceMigrationCount() && migrations[migrations.length - 1] === NEW_MIGRATION && pendingDdl.length === 0, { last: migrations.slice(-2), pendingDdl });
    const cols = (await all(`select column_name from information_schema.columns where table_name = 'notification_deliveries' order by ordinal_position`)).map((r) => r.column_name);
    evidence.columns = cols;
    check('columns: ids, status, attempts, schedule, deadline, lease, error category/code, timestamps — no device, registration, token, credential or content column', cols.join() === 'id,notification_id,recipient_user_id,status,attempt_count,next_attempt_at,expires_at,lease_owner,lease_expires_at,last_error_category,last_error_code,created_at,updated_at,completed_at' && !cols.some((c) => /device|registration|token|fid|credential|secret|title|body|payload/.test(c)), cols);
    const cons = (await all(`select conname, contype from pg_constraint where conrelid = 'notification_deliveries'::regclass order by conname`)).map((r) => `${r.conname}:${r.contype}`);
    evidence.constraints = cons;
    check('constraints: PK, unique notification, composite FK, 8 checks', cons.includes('uq_notification_deliveries_notification:u') && cons.includes('fk_notification_deliveries_notification:f') && cons.filter((c) => c.endsWith(':c')).length === 8 && cons.filter((c) => c.endsWith(':p')).length === 1, cons);
    const fk = await one(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'fk_notification_deliveries_notification'`);
    check('FK (notification_id, recipient_user_id) -> notifications(id, recipient_user_id) ON DELETE CASCADE', /FOREIGN KEY \(notification_id, recipient_user_id\) REFERENCES notifications\(id, recipient_user_id\) ON DELETE CASCADE/.test(fk.d), fk.d);
    const idx = (await all(`select indexname, indexdef from pg_indexes where tablename = 'notification_deliveries' order by indexname`));
    evidence.indexes = idx.map((i) => i.indexname);
    const def = (n) => idx.find((i) => i.indexname === n)?.indexdef ?? '';
    check('partial indexes: due (next_attempt_at, id) WHERE PENDING; lease WHERE PROCESSING; finished WHERE terminal', /\(next_attempt_at, id\) WHERE \(\(status\)::text = 'PENDING'/.test(def('idx_notification_deliveries_due')) && /WHERE \(\(status\)::text = 'PROCESSING'/.test(def('idx_notification_deliveries_lease')) && /DONE.*FAILED.*EXPIRED/.test(def('idx_notification_deliveries_finished')), idx);
    check('guard trigger installed', (await one(`select count(*)::int c from pg_trigger where tgname = 'trg_notification_deliveries_guard'`)).c === 1);

    await dsA.initialize();
    await dsB.initialize();
    const { NotificationsService } = require(path.join(ROOT, 'dist', 'notifications', 'notifications.service.js'));
    const { PushOutboxService, OutboxNotificationNotFoundError, OutboxUsageError } = require(path.join(ROOT, 'dist', 'push-delivery', 'push-outbox.service.js'));
    const cfg = (v) => ({ get: (k) => ({ NODE_ENV: 'test', ...v })[k] });
    const outboxA = new PushOutboxService(cfg({ PUSH_DELIVERY_MODE: 'mock', PUSH_DELIVERY_TTL_SECONDS: String(TTL) }));
    const outboxB = new PushOutboxService(cfg({ PUSH_DELIVERY_MODE: 'mock', PUSH_DELIVERY_TTL_SECONDS: String(TTL) }));
    const outboxOff = new PushOutboxService(cfg({}));
    const inboxA = new NotificationsService(dsA);

    const users = {};
    for (const n of ['alice', 'bob', 'carol']) {
      users[n] = (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, 'x', 'CUSTOMER', 'ACTIVE') returning id::text id`, [`QA ${n}`, `${n}.${RUN}@qa.test`])).id;
    }
    let seq = 0;
    const input = (userId) => ({ recipientUserId: userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'QA outbox', body: 'QA outbox body', eventKey: `qa:${RUN}:${seq++}` });
    const newNotification = async (userId) => (await inboxA.create(input(userId))).notification.id;
    const jobOf = (nid) => one(`select id::text, notification_id::text nid, recipient_user_id::text rid, status, attempt_count, extract(epoch from expires_at - created_at)::int ttl, lease_owner, completed_at from notification_deliveries where notification_id = $1`, [nid]);
    const jobCount = async (nid) => (await one(`select count(*)::int c from notification_deliveries where notification_id = $1`, [nid])).c;

    section('1. Enqueue semantics');
    // 1 + 6 + 8: valid enqueue inside an existing transaction; invisible until commit; persisted after commit
    let nid1;
    let visibleBeforeCommit;
    const r1 = await dsA.transaction(async (m) => {
      const created = await inboxA.create(input(users.alice), m);
      nid1 = created.notification.id;
      const r = await outboxA.enqueue(m, [nid1]);
      visibleBeforeCommit = await jobCount(nid1); // other connection
      return r;
    });
    const job1 = await jobOf(nid1);
    check('valid enqueue in the caller transaction -> { enqueued: [id] }', r1.enqueued.join() === nid1 && r1.alreadyQueued.length === 0 && r1.skipped === null, r1);
    check('the job is not visible to other connections before the caller commits (same transaction)', visibleBeforeCommit === 0, visibleBeforeCommit);
    check(`persisted after commit: PENDING, 0 attempts, no lease, recipient = notification recipient, deadline = TTL (${TTL}s)`, job1 && job1.status === 'PENDING' && job1.attempt_count === 0 && job1.lease_owner === null && job1.rid === users.alice && job1.ttl === TTL, job1);

    // 2: duplicate enqueue
    const r2 = await dsA.transaction((m) => outboxA.enqueue(m, [nid1, nid1]));
    check('duplicate enqueue (later transaction, repeated id) -> alreadyQueued, still exactly one job', r2.enqueued.length === 0 && r2.alreadyQueued.join() === nid1 && (await jobCount(nid1)) === 1, r2);

    // 7: parent transaction rollback
    let nRolled;
    const rolled = await dsA.transaction(async (m) => {
      nRolled = (await inboxA.create(input(users.bob), m)).notification.id;
      await outboxA.enqueue(m, [nRolled]);
      throw new Error('business failure after enqueue');
    }).then(() => 'committed', (e) => e.message);
    check('parent transaction rollback -> neither the notification nor its job exists', rolled === 'business failure after enqueue' && (await one(`select count(*)::int c from notifications where id = $1`, [nRolled])).c === 0 && (await jobCount(nRolled)) === 0);

    // 4: missing notification (all or nothing)
    const nExisting = await newNotification(users.bob);
    const missing = await dsA.transaction((m) => outboxA.enqueue(m, [nExisting, '999999999'])).then(() => null, (e) => e);
    check('missing notification -> OutboxNotificationNotFoundError(missing ids), nothing written for the others', missing instanceof OutboxNotificationNotFoundError && missing.missingIds.join() === '999999999' && (await jobCount(nExisting)) === 0, missing && missing.message);
    const notInTx = await outboxA.enqueue(dsA.manager, [nExisting]).then(() => null, (e) => e);
    check('enqueue outside a transaction is refused (OutboxUsageError)', notInTx instanceof OutboxUsageError && (await jobCount(nExisting)) === 0);

    // disabled by configuration
    const nOff = await newNotification(users.bob);
    const rOff = await dsA.transaction((m) => outboxOff.enqueue(m, [nOff]));
    check('PUSH_DELIVERY_MODE unset (disabled): no job written, result skipped=PUSH_DISABLED (inbox row kept)', rOff.skipped === 'PUSH_DISABLED' && (await jobCount(nOff)) === 0 && (await one(`select count(*)::int c from notifications where id = $1`, [nOff])).c === 1, rOff);

    section('2. Concurrency and multiple instances');
    // 3: concurrent duplicate enqueue across two instances (DataSources)
    const nConc = await newNotification(users.carol);
    const conc = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? dsB : dsA).transaction((m) => (i % 2 ? outboxB : outboxA).enqueue(m, [nConc]))));
    const created = conc.filter((r) => r.enqueued.length === 1).length;
    evidence.concurrentDuplicate = { calls: conc.length, created, alreadyQueued: conc.filter((r) => r.alreadyQueued.length === 1).length, jobs: await jobCount(nConc) };
    check('12 concurrent enqueues of one notification from 2 instances -> exactly 1 created, 11 alreadyQueued, 1 job', created === 1 && evidence.concurrentDuplicate.alreadyQueued === 11 && evidence.concurrentDuplicate.jobs === 1, evidence.concurrentDuplicate);

    // concurrent insert where the first transaction rolls back: the waiter creates the job
    const nRace = await newNotification(users.carol);
    const qrA = dsA.createQueryRunner();
    await qrA.connect();
    await qrA.startTransaction();
    const first = await outboxA.enqueue(qrA.manager, [nRace]);
    let waiterDone = false;
    const waiter = dsB.transaction((m) => outboxB.enqueue(m, [nRace])).then((r) => ((waiterDone = true), r));
    await sleep(400);
    const blocked = !waiterDone;
    await qrA.rollbackTransaction();
    await qrA.release();
    const second = await waiter;
    check('a concurrent enqueue waits for the uncommitted one; first rolls back -> the waiter creates the job', first.enqueued.join() === nRace && blocked && second.enqueued.join() === nRace && (await jobCount(nRace)) === 1, { first, blocked, second });

    // 9: two instances, overlapping batches in different input orders (repeated: deadlock regression)
    const ROUNDS = 15;
    const rounds = [];
    for (let round = 0; round < ROUNDS; round++) {
      const batch = [];
      for (let i = 0; i < 40; i++) batch.push(await newNotification([users.alice, users.bob, users.carol][i % 3]));
      const shuffled = [...batch].sort(() => Math.random() - 0.5);
      const slices = [batch.slice(0, 25), batch.slice(15, 40).reverse(), shuffled.slice(5, 35), [...batch].reverse(), shuffled];
      const outcome = await Promise.all(slices.map((sl, i) => (i % 2 ? dsB : dsA).transaction((m) => (i % 2 ? outboxB : outboxA).enqueue(m, sl)).then((r) => r, (e) => ({ error: e.code ?? e.message }))));
      const createdIds = outcome.flatMap((r) => r.enqueued ?? []);
      const jobs = await one(`select count(*)::int c, count(distinct notification_id)::int d, bool_and(d.recipient_user_id = n.recipient_user_id) same from notification_deliveries d join notifications n on n.id = d.notification_id where d.notification_id = any($1::bigint[])`, [batch]);
      rounds.push({ errors: outcome.filter((r) => r.error).map((r) => r.error), created: createdIds.length, distinct: new Set(createdIds).size, jobs: jobs.c, same: jobs.same });
    }
    evidence.multiInstance = { rounds: ROUNDS, concurrentCallsPerRound: 5, notificationsPerRound: 40, errors: rounds.flatMap((r) => r.errors), allRoundsExact: rounds.every((r) => r.created === 40 && r.distinct === 40 && r.jobs === 40 && r.same) };
    check(`${ROUNDS} rounds x 5 concurrent overlapping batches (40 notifications, mixed/reversed order, 2 instances) -> no deadlock/error, 40 jobs per round, each created exactly once, recipients match`, evidence.multiInstance.errors.length === 0 && evidence.multiInstance.allRoundsExact, { errors: evidence.multiInstance.errors, bad: rounds.filter((r) => r.created !== 40 || r.jobs !== 40 || r.errors.length) });

    section('3. Database invariants');
    // 5: invalid recipient relationship
    const nInv = await newNotification(users.alice);
    const wrongRecipient = await rejects(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [nInv, users.bob]);
    const noNotification = await rejects(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at) values (999999999, $1, now() + interval '1 hour')`, [users.bob]);
    check('job whose recipient is not the notification recipient / unknown notification -> FK violation (23503)', wrongRecipient?.code === '23503' && noNotification?.code === '23503', { wrongRecipient, noNotification });
    const dup = await rejects(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [nid1, users.alice]);
    check('second job for the same notification (plain INSERT) -> unique violation (23505)', dup?.code === '23505', dup);

    // 10: status transitions and immutability
    const nT = await newNotification(users.alice);
    await dsA.transaction((m) => outboxA.enqueue(m, [nT]));
    const jT = (await jobOf(nT)).id;
    const upd = (set, params = []) => rejects(`update notification_deliveries set ${set} where id = $1`, [jT, ...params]);
    const bad = {
      insertProcessing: await rejects(`insert into notification_deliveries(notification_id, recipient_user_id, status, lease_owner, lease_expires_at, expires_at) values ($1, $2, 'PROCESSING', 'w', now(), now() + interval '1 hour')`, [nInv, users.alice]),
      insertWithAttempts: await rejects(`insert into notification_deliveries(notification_id, recipient_user_id, attempt_count, expires_at) values ($1, $2, 3, now() + interval '1 hour')`, [nInv, users.alice]),
      insertExpiredDeadline: await rejects(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at) values ($1, $2, now() - interval '1 second')`, [nInv, users.alice]),
      pendingToDone: await upd(`status = 'DONE', completed_at = now()`),
      pendingToFailed: await upd(`status = 'FAILED', completed_at = now()`),
      processingWithoutLease: await upd(`status = 'PROCESSING'`),
      unknownStatus: await upd(`status = 'SENT'`),
      doneWithoutCompletedAt: null,
      changeRecipient: await upd(`recipient_user_id = $2`, [users.bob]),
      changeDeadline: await upd(`expires_at = expires_at + interval '1 day'`),
      lowercaseCategory: await upd(`last_error_category = 'oops'`),
      errorCodeWithMessage: await upd(`last_error_code = 'token abc@x.com is invalid'`),
      leaseOwnerWithSpaces: null,
    };
    const ok1 = await upd(`status = 'PROCESSING', lease_owner = 'host:1:abcd', lease_expires_at = now() + interval '2 minutes', attempt_count = 1`);
    bad.doneWithoutCompletedAt = await upd(`status = 'DONE'`);
    bad.attemptDecrease = await upd(`attempt_count = 0`);
    bad.leaseOwnerWithSpaces = await upd(`lease_owner = 'bad owner'`);
    const ok2 = await upd(`status = 'PENDING', lease_owner = null, lease_expires_at = null, last_error_category = 'UNAVAILABLE', last_error_code = 'messaging/server-unavailable', next_attempt_at = now() + interval '30 seconds'`);
    const ok3 = await upd(`status = 'PROCESSING', lease_owner = 'host:2:ef01', lease_expires_at = now() + interval '2 minutes', attempt_count = 2`);
    const ok4 = await upd(`status = 'DONE', lease_owner = null, lease_expires_at = null, completed_at = now()`);
    bad.doneToPending = await upd(`status = 'PENDING', completed_at = null`);
    bad.doneTouched = await upd(`last_error_code = 'x'`);
    evidence.rejectedTransitions = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v?.code ?? 'ACCEPTED']));
    check('legal path PENDING -> PROCESSING -> PENDING (retry) -> PROCESSING -> DONE is accepted', [ok1, ok2, ok3, ok4].every((x) => x === null), [ok1, ok2, ok3, ok4]);
    check('illegal inserts/transitions/edits rejected by checks or trigger (23514)', Object.values(bad).every((v) => v?.code === '23514'), evidence.rejectedTransitions);
    const nE = await newNotification(users.alice);
    await dsA.transaction((m) => outboxA.enqueue(m, [nE]));
    const expire = await rejects(`update notification_deliveries set status = 'EXPIRED', completed_at = now() where notification_id = $1`, [nE]);
    check('PENDING -> EXPIRED (deadline passed before any claim) is accepted and terminal', expire === null && (await rejects(`update notification_deliveries set status = 'PROCESSING', completed_at = null, lease_owner = 'w', lease_expires_at = now() where notification_id = $1`, [nE]))?.code === '23514');
    const updatedAtMoved = await one(`select updated_at > created_at moved from notification_deliveries where id = $1`, [jT]);
    check('trigger maintains updated_at on every change', updatedAtMoved.moved === true);

    // cascade: deleting a user deletes their notifications and jobs (no orphan jobs)
    const victim = (await one(`insert into users(full_name, email, password_hash, role, status) values ('QA v', $1, 'x', 'CUSTOMER', 'ACTIVE') returning id::text id`, [`victim.${RUN}@qa.test`])).id;
    const nV = await newNotification(victim);
    await dsA.transaction((m) => outboxA.enqueue(m, [nV]));
    await db.query(`delete from users where id = $1`, [victim]);
    check('recipient deleted -> notification and job removed by cascade (no orphan jobs)', (await jobCount(nV)) === 0);

    section('4. Sensitive data');
    const sample = await one(`select row_to_json(d)::text j from notification_deliveries d where notification_id = $1`, [nid1]);
    check('a job row holds ids, state and timestamps only (no title/body/email/registration value)', !/QA outbox|qa\.test|@/.test(sample.j), sample.j);

    section('5. Application wiring (module registered, DI resolves)');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    app = createApp(NAME, [PORT], { logDir: OUT_DIR, env: { PUSH_DELIVERY_MODE: 'mock', PUSH_DELIVERY_TTL_SECONDS: String(TTL) } });
    await app.start();
    const health = await fetch(`http://localhost:${PORT}/api`).then((r) => r.status, () => 0);
    await app.stop();
    app = null;
    const appLog = fs.readFileSync(path.join(OUT_DIR, `app-${NAME}-${PORT}.log`), 'utf8');
    // BE06-05: the delivery worker exists but must stay disabled by default (never started, no job processed).
    check('app boots with PushDeliveryModule (mode=mock): outbox logs its mode; the delivery worker stays disabled; no Firebase activity', health > 0 && /Push outbox enabled \(mode=mock, delivery TTL 600s\)/.test(appLog) && /Push delivery worker disabled/.test(appLog) && !/worker \S+ started|Push job \d+|firebase/i.test(appLog.split('\n').filter((l) => /Push/.test(l)).join('\n')), { health, push: appLog.split('\n').filter((l) => /Push/.test(l)) });

    section('6. Migration down / up (rollback removes only BE06-02 objects)');
    const before = await one(`select (select count(*)::int from notifications) n, (select count(*)::int from users) u, (select count(*)::int from pg_constraint where conrelid = 'notifications'::regclass) nc`);
    await dsA.undoLastMigration({ transaction: 'each' });
    const after = await one(`select to_regclass('notification_deliveries') t, (select count(*)::int from pg_proc where proname = 'notification_deliveries_guard') f, (select count(*)::int from pg_constraint where conname = 'uq_notifications_id_recipient') uq, (select count(*)::int from notifications) n, (select count(*)::int from users) u, (select count(*)::int from pg_constraint where conrelid = 'notifications'::regclass) nc, (select count(*)::int from migrations where name = $1) m`, [NEW_MIGRATION]);
    check('down: table, trigger function and the notifications unique removed; notifications/users data and other notification constraints intact; migration row removed', after.t === null && after.f === 0 && after.uq === 0 && after.n === before.n && after.u === before.u && after.nc === before.nc - 1 && after.m === 0, { before, after });
    const again = await dsA.runMigrations({ transaction: 'each' });
    const pendingAgain = (await dsA.driver.createSchemaBuilder().log()).upQueries.length;
    check('up again on existing data -> applied, 0 pending DDL', again.length === 1 && again[0].name === NEW_MIGRATION && pendingAgain === 0, { again: again.map((m) => m.name), pendingAgain });
  } finally {
    if (app) await app.stop().catch(() => undefined);
    for (const ds of [dsA, dsB]) if (ds.isInitialized) await ds.destroy();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'push-outbox', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
