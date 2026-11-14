/*
 * P3-BE06-05 durable delivery worker — real PostgreSQL (disposable QA
 * database only), compiled PushJobStore / PushDeliveryWorker, deterministic
 * fake executors defined HERE (no production executor exists yet). No
 * provider, no Firebase. Time is controlled with an injected clock: no long
 * real-time waits for retries or lease expiry.
 *
 *   npm run build
 *   npm run qa:push-worker
 *
 * Environment: QA_DB_NAME (default pawflow_qa_push_worker), QA_PORTS (default 8261),
 * QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, DB, sleep, prepareDatabase, dropDatabase, createApp } = require('./qa-env.cjs');

// ---------------------------------------------------------------- child mode
// `node push-worker.cjs --child <db> <markerFile>`: a worker process that
// executes one job, records "sent", then hangs before persisting (killed by the parent).
if (process.argv[2] === '--child') {
  (async () => {
    const [, , , dbName, marker] = process.argv;
    const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
    const { PushJobStore } = require(path.join(ROOT, 'dist', 'push-delivery', 'worker', 'push-job.store.js'));
    const { PushDeliveryWorker } = require(path.join(ROOT, 'dist', 'push-delivery', 'worker', 'push-delivery.worker.js'));
    const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: dbName, synchronize: false, entities: [] });
    await ds.initialize();
    const executor = {
      execute: async (ctx) => {
        fs.appendFileSync(marker, JSON.stringify({ jobId: ctx.jobId, attempt: ctx.attempt, pid: process.pid }) + '\n');
        await new Promise(() => undefined); // "provider accepted", then the process dies before persisting
      },
    };
    const w = new PushDeliveryWorker(new PushJobStore(ds), { enabled: true, batchSize: 1, pollMs: 200, leaseSeconds: 10, jobTimeoutMs: 600_000, maxAttempts: 5, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 0 }, executor, { workerId: 'child-crash' });
    await w.runOnce();
  })().catch((e) => {
    console.error(e);
    process.exit(3);
  });
  return;
}

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_push_worker';
const PORT = Number(process.env.QA_PORTS ?? 8261);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-pushworker-'));
const RUN = 'w' + Date.now().toString(36);

const results = [];
const evidence = {};
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const section = (title) => console.log(`\n## ${title}`);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 23: count outbound network attempts made in this process while workers run.
  const network = { http: 0, https: 0, http2: 0, fetch: 0 };
  const http = require('http');
  const https = require('https');
  const http2 = require('http2');
  const origHttp = http.request;
  const origHttps = https.request;
  const origH2 = http2.connect;
  const origFetch = globalThis.fetch;
  const armNetworkSpy = () => {
    http.request = (...a) => (network.http++, origHttp(...a));
    https.request = (...a) => (network.https++, origHttps(...a));
    http2.connect = (...a) => (network.http2++, origH2(...a));
    globalThis.fetch = (...a) => (network.fetch++, origFetch(...a));
  };
  const disarmNetworkSpy = () => Object.assign(http, { request: origHttp }) && Object.assign(https, { request: origHttps }) && Object.assign(http2, { connect: origH2 }) && (globalThis.fetch = origFetch);

  // 24: capture every Nest log line produced by the compiled classes.
  const { Logger } = require(path.join(ROOT, 'node_modules', '@nestjs', 'common'));
  const logs = [];
  Logger.overrideLogger({ log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)), verbose: (m) => logs.push(String(m)), fatal: (m) => logs.push(String(m)) });

  const { db } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
  const { PushJobStore, DATABASE_CLOCK } = require(path.join(ROOT, 'dist', 'push-delivery', 'worker', 'push-job.store.js'));
  const { PushDeliveryWorker } = require(path.join(ROOT, 'dist', 'push-delivery', 'worker', 'push-delivery.worker.js'));
  const newDs = (extra = {}) => new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [], extra: { max: 10, ...extra } });
  const dsA = newDs({ application_name: 'qa-worker-a' });
  const dsB = newDs({ application_name: 'qa-worker-b' });
  const dsC = newDs({ application_name: 'qa-worker-c' });
  const dsD = newDs({ application_name: 'qa-worker-d' });
  for (const ds of [dsA, dsB, dsC, dsD]) await ds.initialize();

  // Controlled clock: base = database "now" at start; tests move it explicitly.
  const dbNow = async () => new Date((await one(`select now() n`)).n);
  let base = await dbNow();
  let offsetMs = 0;
  const clock = () => new Date(base.getTime() + offsetMs);
  const at = async (ms) => {
    base = await dbNow();
    offsetMs = ms;
  };
  const CFG = { enabled: true, batchSize: 5, pollMs: 200, leaseSeconds: 10, jobTimeoutMs: 5_000, maxAttempts: 3, retryBaseMs: 30_000, retryMaxMs: 3_600_000, shutdownGraceMs: 2_000 };
  const worker = (ds, executor, cfg = {}, id) => new PushDeliveryWorker(new PushJobStore(ds, clock), { ...CFG, ...cfg }, executor, { random: () => 0.5, now: () => clock().getTime(), workerId: id });
  const fixed = (outcome) => {
    const calls = [];
    return { calls, execute: async (ctx) => (calls.push(ctx), typeof outcome === 'function' ? outcome(ctx) : outcome) };
  };
  const DELIVERED = { kind: 'DELIVERED', accepted: 1, failedFinal: 0 };

  const user = (await one(`insert into users(full_name, email, password_hash, role, status) values ('QA worker', $1, 'x', 'CUSTOMER', 'ACTIVE') returning id::text id`, [`worker.${RUN}@qa.test`])).id;
  // BE07-03: opted in before any of its notifications exist (the boot case expects NO_DESTINATIONS, not PUSH_OPTED_OUT).
  await db.query(`insert into notification_preferences(user_id, push_enabled, push_enabled_at) values ($1, true, now())`, [user]);
  let seq = 0;
  const makeJobs = async (n, expiresInSeconds = 3600) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const nid = (await one(`insert into notifications(recipient_user_id, type, title, body, event_key) values ($1, 'SYSTEM_ANNOUNCEMENT', 'QA', 'QA worker body', $2) returning id::text id`, [user, `qa:${RUN}:${seq++}`])).id;
      ids.push((await one(`insert into notification_deliveries(notification_id, recipient_user_id, expires_at, next_attempt_at) values ($1, $2, now() + make_interval(secs => $3), now() - interval '1 minute') returning id::text id`, [nid, user, expiresInSeconds])).id);
    }
    return ids;
  };
  const job = (id) => one(`select id::text, status, attempt_count, lease_owner, lease_expires_at, next_attempt_at, expires_at, completed_at, last_error_category cat, last_error_code code from notification_deliveries where id = $1`, [id]);
  const clearQueue = () => db.query(`update notification_deliveries set status = 'EXPIRED', completed_at = now(), lease_owner = null, lease_expires_at = null where status in ('PENDING','PROCESSING')`);
  const deadlocksBefore = (await one(`select deadlocks::int d from pg_stat_database where datname = current_database()`)).d;
  armNetworkSpy();

  try {
    section('1. Claiming');
    {
      await at(0);
      const ids = await makeJobs(7);
      const sA = new PushJobStore(dsA, clock);
      const [c1] = await sA.claim('wkr-a', 1, 10);
      const row = await job(c1.id);
      check('1. claim one: PROCESSING, attempt 1, unique lease token <workerId>:<16 hex>, lease = now + 10 s', c1.id === ids[0] && row.status === 'PROCESSING' && row.attempt_count === 1 && /^wkr-a:[0-9a-f]{16}$/.test(row.lease_owner) && row.lease_owner === c1.leaseToken && new Date(row.lease_expires_at) - clock() === 10_000, { c1, row });
      const many = await sA.claim('wkr-a', 5, 10);
      check('2. claim multiple: next 5 due jobs in next_attempt_at, id order; distinct tokens', many.map((j) => j.id).join() === ids.slice(1, 6).join() && new Set(many.map((j) => j.leaseToken)).size === 5, many.map((j) => j.id));
      await sA.claim('wkr-a', 5, 10);
      const empty = await sA.claim('wkr-a', 5, 10);
      check('3. empty queue (everything leased) -> []', empty.length === 0);
      await clearQueue();
    }
    {
      const ids = await makeJobs(10);
      const [a, b] = await Promise.all([new PushJobStore(dsA, clock).claim('inst-a', 10, 10), new PushJobStore(dsB, clock).claim('inst-b', 10, 10)]);
      const union = [...a, ...b].map((j) => j.id);
      check('4. two instances claiming concurrently -> disjoint sets covering all 10 jobs', union.length === 10 && new Set(union).size === 10 && ids.every((id) => union.includes(id)), { a: a.length, b: b.length });
      await clearQueue();
    }
    {
      const ids = await makeJobs(60);
      const pools = [dsA, dsB, dsC, dsD];
      const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => new PushJobStore(pools[i % 4], clock).claim(`c${i}`, 5, 10)));
      const claimed = claims.flat().map((j) => j.id);
      evidence.twentyClaims = { claimers: 20, perClaimLimit: 5, jobs: 60, claimed: claimed.length, distinct: new Set(claimed).size };
      check('5. 20 concurrent claimers (4 pools, limit 5) over 60 jobs -> 60 distinct claims, none twice, every job leased once', claimed.length === 60 && new Set(claimed).size === 60 && ids.every((id) => claimed.includes(id)), evidence.twentyClaims);
      const owners = await one(`select count(*)::int c, count(distinct lease_owner)::int d from notification_deliveries where id = any($1::bigint[])`, [ids]);
      check('5. each claimed row has its own lease token', owners.c === 60 && owners.d === 60, owners);
      await clearQueue();
    }
    {
      const ids = await makeJobs(6);
      const holder = await dsD.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query(`select id from notification_deliveries where id = any($1::bigint[]) for update`, [ids.slice(0, 3)]);
      const t = Date.now();
      const got = await new PushJobStore(dsA, clock).claim('skip', 10, 10);
      const ms = Date.now() - t;
      await holder.rollbackTransaction();
      await holder.release();
      check('6. SKIP LOCKED: rows locked by another transaction are skipped without waiting; the free rows are claimed', got.map((j) => j.id).join() === ids.slice(3).join() && ms < 1_000, { got: got.map((j) => j.id), ms });
      await clearQueue();
    }

    section('2. Leases and fencing');
    {
      await at(0);
      const [id] = await makeJobs(1);
      const sA = new PushJobStore(dsA, clock);
      const sB = new PushJobStore(dsB, clock);
      const [old] = await sA.claim('old', 1, 10);
      await at(5_000);
      const early = await sB.claim('new', 1, 10);
      await at(10_001);
      const [fresh] = await sB.claim('new', 1, 10);
      check('7. lease expiration: not reclaimable while valid (+5 s), reclaimed after expiry (+10 s) with attempt 2 and a new token', early.length === 0 && fresh?.id === id && fresh.attempt === 2 && fresh.leaseToken !== old.leaseToken, { early, fresh });
      const stale = {
        complete: await sA.complete(old, null, null),
        fail: await sA.fail(old, 'TRANSIENT', 'x/y'),
        expire: await sA.expire(old),
        retry: await sA.scheduleRetry(old, 30_000, 'TRANSIENT', 'x/y'),
        renew: (await sA.renew([old], 10)).size,
      };
      const still = await job(id);
      check('8. stale worker (old token): complete/fail/expire/retry/renew all rejected; job still owned by the new worker', !stale.complete && !stale.fail && !stale.expire && stale.retry === null && stale.renew === 0 && still.status === 'PROCESSING' && still.lease_owner === fresh.leaseToken, { stale, still });
      const ok = await sB.complete(fresh, null, null);
      const done = await job(id);
      const reclaim = await sB.claim('again', 5, 10);
      await at(10 * 3_600_000);
      const later = await sB.claim('again', 5, 10);
      const illegal = await db.query(`update notification_deliveries set status = 'PENDING', completed_at = null where id = $1`, [id]).then(() => null, (e) => e.code);
      check('8 + 15. current owner completes (DONE, lease cleared); terminal jobs are never reclaimed and the trigger refuses to reopen them', ok && done.status === 'DONE' && done.lease_owner === null && done.completed_at && reclaim.length === 0 && later.length === 0 && illegal === '23514', { ok, done, illegal });
      await at(0);
      await clearQueue();
    }
    {
      // Lease renewal by the heartbeat during a long execution (database clock, ~12 s real time).
      const [id] = await makeJobs(1);
      const realStore = (ds) => new PushJobStore(ds, DATABASE_CLOCK);
      let midLease = null;
      let stolen = null;
      const slow = { execute: async () => {
        await sleep(6_000);
        midLease = (await job(id)).lease_expires_at;
        stolen = await realStore(dsB).claim('thief', 5, 10);
        await sleep(5_000);
        return DELIVERED;
      } };
      const w = new PushDeliveryWorker(realStore(dsA), { ...CFG, leaseSeconds: 10, jobTimeoutMs: 30_000 }, slow, { workerId: 'slow' });
      const claimedAt = new Date();
      const tick = await w.runOnce();
      const row = await job(id);
      check('lease renewal: an 11 s execution with a 10 s lease keeps its lease (renewed every lease/3), no other worker can reclaim it, completes DONE', tick.outcomes.DONE === 1 && row.status === 'DONE' && stolen.length === 0 && new Date(midLease) - claimedAt > 10_000, { tick, midLease, stolen: stolen?.length });
    }

    section('3. Outcomes, retry and backoff (controlled clock)');
    {
      await at(0);
      const [id] = await makeJobs(1);
      const ex = fixed({ kind: 'RETRY', category: 'TRANSIENT', code: 'messaging/server-unavailable' });
      const w = worker(dsA, ex);
      await w.runOnce();
      let row = await job(id);
      const d1 = new Date(row.next_attempt_at) - clock();
      check('10 + 11. retryable failure -> PENDING, lease cleared, category/code stored, next attempt = now + 30 s (base, no jitter)', row.status === 'PENDING' && row.lease_owner === null && row.cat === 'TRANSIENT' && row.code === 'messaging/server-unavailable' && d1 === 30_000, { row, d1 });
      await at(29_000);
      const notYet = await w.runOnce();
      await at(30_001);
      await w.runOnce();
      row = await job(id);
      const d2 = new Date(row.next_attempt_at) - clock();
      check('11. not retried before it is due (no busy loop); attempt 2 backs off 60 s (exponential)', notYet.claimed === 0 && row.attempt_count === 2 && d2 === 60_000, { notYet, d2 });
      await at(30_001 + 60_001);
      await w.runOnce();
      row = await job(id);
      check('14. max attempts (3) exhausted -> FAILED with the last category/code, never retried again', row.status === 'FAILED' && row.attempt_count === 3 && row.cat === 'TRANSIENT' && row.completed_at && ex.calls.length === 3, row);
      await at(0);
    }
    {
      const ids = await makeJobs(3);
      const outcomes = {
        [ids[0]]: { kind: 'RETRY', category: 'TRANSIENT', code: 'messaging/server-unavailable', retryAfterMs: 120_000 },
        [ids[1]]: { kind: 'RETRY', category: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 1_000 },
        [ids[2]]: { kind: 'CONFIGURATION', code: 'app/invalid-credential' },
      };
      await at(0);
      await worker(dsA, fixed((ctx) => outcomes[ctx.jobId]), { batchSize: 3 }).runOnce();
      const delays = {};
      for (const id of ids) delays[id] = new Date((await job(id)).next_attempt_at) - clock();
      evidence.retryDelays = { retryAfter120s: delays[ids[0]], quotaWithRetryAfter1s: delays[ids[1]], configuration: delays[ids[2]] };
      check('12 + 13. Retry-After 120 s beats the 30 s backoff; quota waits >= 60 s despite Retry-After 1 s; configuration waits 5 min', delays[ids[0]] === 120_000 && delays[ids[1]] === 60_000 && delays[ids[2]] === 300_000, evidence.retryDelays);
      await clearQueue();
    }
    {
      await at(0);
      const ids = await makeJobs(3);
      const outcomes = {
        [ids[0]]: { kind: 'TERMINAL', category: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' },
        [ids[1]]: { kind: 'DISABLED' },
        [ids[2]]: { kind: 'NO_DESTINATIONS' },
      };
      const ex = fixed((ctx) => outcomes[ctx.jobId]);
      await worker(dsA, ex, { batchSize: 3 }).runOnce();
      const rows = await Promise.all(ids.map(job));
      await at(10 * 3_600_000);
      const again = await worker(dsA, ex, { batchSize: 3 }).runOnce();
      check('9 + 15. terminal -> FAILED (INVALID_PAYLOAD); DISABLED -> FAILED (PUSH_DISABLED); NO_DESTINATIONS -> DONE; none ever re-executed', rows[0].status === 'FAILED' && rows[0].cat === 'INVALID_PAYLOAD' && rows[1].status === 'FAILED' && rows[1].cat === 'PUSH_DISABLED' && rows[2].status === 'DONE' && rows[2].cat === 'NO_DESTINATIONS' && again.claimed === 0 && ex.calls.length === 3, rows.map((r) => [r.status, r.cat]));
      await at(0);
    }

    section('4. Deadlines');
    {
      await at(0);
      const [overdue] = await makeJobs(1, 600);
      const ex = fixed(DELIVERED);
      await at(601_000);
      const tick = await worker(dsA, ex).runOnce();
      const row = await job(overdue);
      check('16. job past its deadline is EXPIRED by the tick, never claimed or executed', tick.expiredOverdue === 1 && tick.claimed === 0 && row.status === 'EXPIRED' && row.cat === 'EXPIRED' && ex.calls.length === 0, { tick, row });
      await at(0);
      const [tight] = await makeJobs(1, 100);
      await at(80_000);
      await worker(dsA, fixed({ kind: 'RETRY', category: 'TRANSIENT', code: 'x/y' })).runOnce();
      const r2 = await job(tight);
      check('16. a retry that would start after the deadline (now+80 s, +30 s > 100 s) -> EXPIRED atomically', r2.status === 'EXPIRED' && r2.completed_at, r2);
      await at(0);
      const [during] = await makeJobs(1, 100);
      await worker(dsA, fixed(async () => {
        offsetMs = 150_000; // the deadline passes while the job is executing
        return { kind: 'RETRY', category: 'TRANSIENT', code: 'x/y' };
      })).runOnce();
      const r3 = await job(during);
      check('10 (crash list). job expiring during processing -> EXPIRED instead of another retry', r3.status === 'EXPIRED', r3);
      await at(0);
      const [crashedOverdue] = await makeJobs(1, 100);
      await new PushJobStore(dsA, clock).claim('crashed', 1, 10);
      await at(120_000);
      await worker(dsB, fixed(DELIVERED)).runOnce();
      const r4 = await job(crashedOverdue);
      check('crashed worker + deadline passed: the leased job is expired after its lease expires (never sent late)', r4.status === 'EXPIRED', r4);
      await at(0);
    }

    section('5. Crash recovery');
    {
      await at(0);
      const [id] = await makeJobs(1);
      await new PushJobStore(dsA, clock).claim('crash-after-claim', 1, 10); // the process dies here
      const ex = fixed(DELIVERED);
      const before = await worker(dsB, ex, {}, 'restarted-1').runOnce();
      await at(10_001);
      const after = await worker(dsB, ex, {}, 'restarted-1').runOnce();
      const row = await job(id);
      check('17 + 19. crash right after claim: invisible while the lease is valid; after expiry a restarted worker reclaims (attempt 2) and completes', before.claimed === 0 && after.outcomes.DONE === 1 && row.status === 'DONE' && row.attempt_count === 2 && ex.calls.length === 1, { before, after, row });
      await at(0);
    }
    {
      // 18: a REAL worker process executes ("provider accepted") and is killed before persisting.
      await at(0);
      const [id] = await makeJobs(1);
      const marker = path.join(OUT_DIR, 'child-executions.jsonl');
      const child = spawn(process.execPath, [__filename, '--child', NAME, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
      let childOut = '';
      child.stdout.on('data', (d) => (childOut += d));
      child.stderr.on('data', (d) => (childOut += d));
      const t0 = Date.now();
      while (!fs.existsSync(marker) && Date.now() - t0 < 20_000) await sleep(100);
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      const stuck = await job(id);
      const ex = fixed(DELIVERED);
      await at(60_000);
      const tick = await worker(dsA, ex, {}, 'recovery').runOnce();
      const row = await job(id);
      const childRuns = fs.readFileSync(marker, 'utf8').trim().split('\n').length;
      evidence.crashAfterExecution = { childExecutions: childRuns, recoveryExecutions: ex.calls.length, finalAttempt: row.attempt_count, status: row.status };
      check('18. process killed after execution, before persistence: job left PROCESSING (child lease), then reclaimed and executed again -> DONE (at-least-once: 2 executions)', stuck.status === 'PROCESSING' && stuck.lease_owner?.startsWith('child-crash:') && tick.outcomes.DONE === 1 && row.status === 'DONE' && row.attempt_count === 2 && childRuns === 1 && ex.calls.length === 1, { stuck, evidence: evidence.crashAfterExecution, childOut: childOut.slice(-300) });
      await at(0);
    }

    section('6. Database outage');
    {
      const deadDs = new DataSource({ type: 'postgres', host: DB.host, port: 1, username: DB.user, password: DB.password, database: NAME, synchronize: false, entities: [] });
      const ex = fixed(DELIVERED);
      const w = new PushDeliveryWorker(new PushJobStore(deadDs, clock), CFG, ex, { workerId: 'no-db' });
      const tick = await w.runOnce();
      const failLine = logs.filter((l) => /tick failed/.test(l)).pop() ?? '';
      check('20. database unreachable: the tick fails safely (null), no execution, diagnostic without connection details', tick === null && ex.calls.length === 0 && /tick failed \(/.test(failLine) && !failLine.includes(DB.password || '\u0000') && !/password|host=|port=/i.test(failLine), failLine);

      await at(0);
      const [id] = await makeJobs(1);
      const outage = fixed(async () => {
        // the connection drops right after the external send
        await db.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'qa-worker-c' and pid <> pg_backend_pid()`);
        return DELIVERED;
      });
      const t1 = await worker(dsC, outage, {}, 'outage').runOnce();
      let row = await job(id);
      const firstState = row.status;
      await at(10_001);
      const t2 = await worker(dsA, fixed(DELIVERED), {}, 'after-outage').runOnce();
      row = await job(id);
      evidence.connectionDrop = { firstTickOutcomes: t1?.outcomes, stateAfterDrop: firstState, recoveryClaimed: t2?.claimed, final: row.status, attempts: row.attempt_count };
      check('20. connections killed mid-job: the worker survives; the result is persisted on reconnect or the job is reclaimed after lease expiry; exactly one final DONE', row.status === 'DONE' && (firstState === 'DONE' || t2.outcomes.DONE === 1), evidence.connectionDrop);
      await at(0);
    }

    section('7. Lifecycle');
    {
      await at(0);
      const ids = await makeJobs(3);
      let release;
      const gate = new Promise((r) => (release = r));
      const ex = fixed(async () => (await gate, DELIVERED));
      const w = worker(dsA, ex, { batchSize: 1, pollMs: 200, shutdownGraceMs: 5_000 }, 'graceful');
      w.start();
      const t0 = Date.now();
      while (ex.calls.length === 0 && Date.now() - t0 < 5_000) await sleep(50);
      const stopping = w.stop();
      release();
      await stopping;
      await sleep(600);
      const rows = await Promise.all(ids.map(job));
      check('21. graceful shutdown: stops claiming, lets the in-flight job finish (DONE), leaves the rest PENDING', ex.calls.length === 1 && rows.filter((r) => r.status === 'DONE').length === 1 && rows.filter((r) => r.status === 'PENDING').length === 2, rows.map((r) => r.status));
      const w2 = worker(dsB, fixed(DELIVERED), { batchSize: 5, pollMs: 200 }, 'restart');
      w2.start();
      const t1 = Date.now();
      while ((await one(`select count(*)::int c from notification_deliveries where id = any($1::bigint[]) and status = 'DONE'`, [ids])).c < 3 && Date.now() - t1 < 10_000) await sleep(100);
      await w2.stop();
      check('19. restart: a new worker instance picks up the remaining jobs', (await one(`select count(*)::int c from notification_deliveries where id = any($1::bigint[]) and status = 'DONE'`, [ids])).c === 3);
    }
    disarmNetworkSpy();
    {
      // App boot defaults (compiled app, disposable DB).
      await clearQueue();
      const pending = await makeJobs(2);
      const bootCase = async (tag, env) => {
        const dir = path.join(OUT_DIR, `boot-${tag}`);
        fs.mkdirSync(dir, { recursive: true });
        const app = createApp(NAME, [PORT], { logDir: dir, env });
        const started = await app.start().then(() => true, () => false);
        if (started) await sleep(2_500);
        await app.stop();
        return { started, log: fs.readFileSync(path.join(dir, `app-${NAME}-${PORT}.log`), 'utf8') };
      };
      const def = await bootCase('default', { PUSH_DELIVERY_MODE: 'mock' });
      const stillPending = (await one(`select count(*)::int c from notification_deliveries where id = any($1::bigint[]) and status = 'PENDING'`, [pending])).c;
      check('22. app default: worker disabled (logged), jobs untouched (still PENDING)', def.started && /Push delivery worker disabled/.test(def.log) && stillPending === 2, { stillPending, push: def.log.split('\n').filter((l) => /Push/.test(l)) });
      const disabledMode = await bootCase('enabled-disabled', { PUSH_WORKER_ENABLED: 'true' });
      check('PUSH_WORKER_ENABLED=true with push disabled -> configuration error at startup', !disabledMode.started && /requires PUSH_DELIVERY_MODE/.test(disabledMode.log));
      const fb = await bootCase('firebase', { PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-qa-worker' });
      check('23. firebase mode, worker disabled: boots, nothing claimed, no Firebase initialization or Google traffic logged', fb.started && /worker disabled/.test(fb.log) && !/googleapis|invalid-credential|Firebase Admin initialized/i.test(fb.log) && (await one(`select count(*)::int c from notification_deliveries where id = any($1::bigint[]) and status = 'PENDING'`, [pending])).c === 2);
      // BE06-06 registers the real executor: an enabled worker now starts and processes jobs end to end
      // (this user has no push device -> NO_DESTINATIONS). The executor-less refusal is covered by push-worker.spec.ts.
      const enabled = await bootCase('enabled', { PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'true', PUSH_WORKER_POLL_MS: '200' });
      const doneRows = await all(`select status, last_error_category cat from notification_deliveries where id = any($1::bigint[])`, [pending]);
      check('PUSH_WORKER_ENABLED=true + mock (BE06-06 executor registered): the app starts the worker and completes the pending jobs (NO_DESTINATIONS)', enabled.started && /Push delivery worker \S+ started/.test(enabled.log) && doneRows.every((r) => r.status === 'DONE' && r.cat === 'NO_DESTINATIONS'), { doneRows, push: enabled.log.split('\n').filter((l) => /Push/.test(l)).slice(0, 6) });
    }

    section('8. Network, logs, invariants');
    evidence.network = network;
    check('23. no outbound HTTP/HTTPS/HTTP2/fetch activity from any worker in this process', Object.values(network).every((n) => n === 0), network);
    const text = logs.join('\n');
    fs.writeFileSync(path.join(OUT_DIR, 'worker-logs.txt'), text);
    const tokens = (await all(`select distinct lease_owner from notification_deliveries where lease_owner is not null`)).map((r) => r.lease_owner);
    check('24. logs contain no lease tokens, connection secrets or notification content; job lines are ids/outcomes/codes only', !/[A-Za-z0-9-]+:[0-9a-f]{16}/.test(text) && !tokens.some((t) => text.includes(t)) && !/QA worker body|password/i.test(text) && /Push job \d+ \(notification \d+, attempt \d+\): (DELIVERED|RETRY|TERMINAL|DISABLED|NO_DESTINATIONS|CONFIGURATION)/.test(text), text.split('\n').filter((l) => /:[0-9a-f]{16}|password|QA worker body/i.test(l)).slice(0, 5));
    await sleep(1_200);
    const inv = await one(`select
      (select count(*)::int from notification_deliveries where status = 'PROCESSING' and (lease_owner is null or lease_expires_at is null)) bad_lease,
      (select count(*)::int from notification_deliveries where status in ('DONE','FAILED','EXPIRED') and completed_at is null) bad_terminal,
      (select deadlocks::int from pg_stat_database where datname = current_database()) - $1 deadlocks`, [deadlocksBefore]);
    evidence.invariants = inv;
    check('state invariants hold; 0 deadlocks', inv.bad_lease === 0 && inv.bad_terminal === 0 && inv.deadlocks === 0, inv);
  } finally {
    disarmNetworkSpy();
    for (const ds of [dsA, dsB, dsC, dsD]) if (ds.isInitialized) await ds.destroy().catch(() => undefined);
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = { suite: 'push-worker', run: RUN, db: NAME, total: results.length, passed: results.length - failed.length, failed: failed.length, evidence, outDir: OUT_DIR };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} checks passed  (out: ${OUT_DIR})`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('QA run aborted:', error);
  process.exit(2);
});
