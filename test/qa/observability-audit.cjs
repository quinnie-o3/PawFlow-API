/*
 * P3-BE09 observability & audit: real HTTP + real PostgreSQL on a disposable
 * QA database only (pawflow_qa_*; the development database is never used).
 * Two API instances share the database.
 *
 *   npm run build
 *   npm run qa:observability-audit
 *
 * Covers: X-Request-ID on every response (success, 400, 401, 403, 404, 409,
 * 500), client ID validation, audit rows correlated with the request that
 * caused them (sequential and concurrent, across instances), unchanged
 * admin activity-log API (filters, pagination, detail, RBAC, pre-BE09
 * rows), atomic rollback of business change + audit row (forced failure via
 * a QA-only trigger), and the application logs: one JSON object per line,
 * exactly one completion event per request, normalized routes, no
 * credentials / tokens / PII / stack traces.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_observability), QA_PORTS
 * (default 8331,8332), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, DB, prepareDatabase, dropDatabase, createApp, createApi } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_observability';
const PORTS = (process.env.QA_PORTS ?? '8331,8332').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-observability-'));
const JWT_SECRET = require('crypto').randomUUID() + require('crypto').randomUUID();
const PASSWORD = 'QaObservabilityPass123!';
const RUN = 'ob' + Date.now().toString(36);
const LEAK_EMAIL = `leak.check.${RUN}@private.example`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 900)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Key-order-insensitive equality for flat JSON objects (jsonb does not keep key order). */
const sameObject = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const apps = [];
  const api = createApi(PORTS);
  const responses = []; // every API response: { status, requestId }
  const call = async (method, url, opts = {}) => {
    const r = await api(method, url, opts);
    responses.push({ status: r.status, requestId: r.headers.get('x-request-id'), url });
    return { ...r, requestId: r.headers.get('x-request-id') };
  };
  const mail = (n) => `${n}.${RUN}@qa.test`;
  const secrets = [PASSWORD, JWT_SECRET, DB.password].filter((s) => s && s.length >= 6);
  const logDir = path.join(OUT_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  try {
    section('0. Schema (BE09 adds no migration)');
    check('17 migrations applied, last AddReviewResponseConstraints1797500000000, 0 pending DDL', migrations.length === 17 && migrations.at(-1) === 'AddReviewResponseConstraints1797500000000' && pendingDdl.length === 0, { count: migrations.length, last: migrations.at(-1), pendingDdl });

    // ------------------------------------------------------------- seed
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    const users = [['admin', 'ADMIN'], ['admin2', 'ADMIN'], ['cust', 'CUSTOMER'], ['owner', 'PROVIDER_OWNER']];
    for (let i = 0; i < 12; i++) users.push([`target${i}`, 'CUSTOMER']);
    for (const [n, role] of users) {
      ids[n] = (await one(`insert into users(full_name, email, phone, password_hash, role, status) values ($1, $2, $3, $4, $5, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), hash, role])).id;
    }
    // One provider per owner (providers.owner_id is unique).
    const provider = async (label) => {
      const owner = (await one(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, 'PROVIDER_OWNER', 'ACTIVE') returning id::text id`, [`QA owner ${label}`, mail(`owner-${label}`), hash])).id;
      return (await one(`insert into providers(owner_id, business_name, address, approval_status) values ($1, $2, 'QA road', 'PENDING') returning id::text id`, [owner, `QA Obs ${label} ${RUN}`])).id;
    };
    const prov = {};
    for (const label of ['seq', 'gen', 'dup', 'fail', ...Array.from({ length: 8 }, (_, i) => `c${i}`)]) prov[label] = await provider(label);

    // A pre-BE09 audit row (no requestId in metadata) must stay readable and unchanged.
    const legacy = await one(`insert into admin_activity_logs(admin_user_id, action, target_type, target_id, metadata, created_at) values ($1, 'PROVIDER_APPROVED', 'PROVIDER', $2, '{"fromStatus":"PENDING","toStatus":"APPROVED"}', now() - interval '30 days') returning id::text id`, [ids.admin2, prov.c7]);

    for (const port of PORTS) { const app = createApp(NAME, [port], { logDir, jwtSecret: JWT_SECRET }); await app.start(); apps.push(app); }
    const login = async (n) => {
      const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`);
      secrets.push(r.body.accessToken, r.body.refreshToken);
      return r.body.accessToken;
    };
    const T = { admin: await login('admin'), admin2: await login('admin2'), cust: await login('cust') };
    const audits = (targetType, targetId) => all(`select id::text id, admin_user_id::text admin, action, metadata from admin_activity_logs where target_type = $1 and target_id = $2 order by id`, [targetType, targetId]);

    section('1. X-Request-ID contract over real HTTP');
    {
      const ok = await call('GET', '/admin/activity-logs', { token: T.admin });
      const anon = await call('GET', '/admin/activity-logs');
      const forbidden = await call('GET', '/admin/activity-logs', { token: T.cust });
      const invalid = await call('GET', '/admin/activity-logs?limit=abc', { token: T.admin });
      const missing = await call('GET', `/no/such/route/${LEAK_EMAIL}`);
      check('1. generated UUID v4 on 200 / 401 / 403 / 400 / 404 responses', [ok, anon, forbidden, invalid, missing].every((r) => UUID_V4.test(r.requestId ?? '')) && [ok.status, anon.status, forbidden.status, invalid.status, missing.status].join() === '200,401,403,400,404', [ok, anon, forbidden, invalid, missing].map((r) => [r.status, r.requestId]));
      const kept = await call('GET', '/admin/activity-logs', { token: T.admin, headers: { 'X-Request-ID': `qa-client-${RUN}-001` } });
      const replaced = await call('GET', '/admin/activity-logs', { token: T.admin, headers: { 'X-Request-ID': 'bad id <x>' } });
      const tooLong = await call('GET', '/admin/activity-logs', { token: T.admin, headers: { 'X-Request-ID': 'a'.repeat(129) } });
      check('2. valid client ID kept; invalid (spaces/markup) and over-long IDs replaced by a UUID', kept.requestId === `qa-client-${RUN}-001` && UUID_V4.test(replaced.requestId ?? '') && UUID_V4.test(tooLong.requestId ?? ''), [kept.requestId, replaced.requestId, tooLong.requestId]);
      const cors = await fetch(`http://localhost:${PORTS[0]}/api`, { headers: { Origin: 'http://localhost:3000' } });
      check('3. CORS exposes X-Request-ID to the browser', /x-request-id/i.test(cors.headers.get('access-control-expose-headers') ?? ''), cors.headers.get('access-control-expose-headers'));
    }

    section('2. Audit rows correlated with their request');
    {
      const clientId = `qa-approve-${RUN}-seq`;
      const r = await call('PATCH', `/admin/providers/${prov.seq}/approve`, { token: T.admin, headers: { 'X-Request-ID': clientId } });
      const rows = await audits('PROVIDER', prov.seq);
      check('4. approve: 200, one PROVIDER_APPROVED row by the authenticated admin, metadata = transition + requestId of the request', r.status === 200 && r.requestId === clientId && rows.length === 1 && rows[0].admin === ids.admin && rows[0].action === 'PROVIDER_APPROVED' && sameObject(rows[0].metadata, { fromStatus: 'PENDING', toStatus: 'APPROVED', requestId: clientId }), { status: r.status, rows });

      const gen = await call('PATCH', `/admin/providers/${prov.gen}/approve`, { token: T.admin });
      const genRows = await audits('PROVIDER', prov.gen);
      check('5. without a client ID the audit row carries the server-generated ID returned in the header', gen.status === 200 && UUID_V4.test(gen.requestId) && genRows.length === 1 && genRows[0].metadata.requestId === gen.requestId, { header: gen.requestId, genRows });

      const again = await call('PATCH', `/admin/providers/${prov.seq}/approve`, { token: T.admin, headers: { 'X-Request-ID': `qa-approve-${RUN}-again` } });
      const forbiddenAction = await call('PATCH', `/admin/providers/${prov.c6}/approve`, { token: T.cust, headers: { 'X-Request-ID': `qa-approve-${RUN}-cust` } });
      check('6. repeated approve -> 409 and no new audit row; non-admin -> 403 and no audit row, no state change', again.status === 409 && (await audits('PROVIDER', prov.seq)).length === 1 && forbiddenAction.status === 403 && (await audits('PROVIDER', prov.c6)).length === 0 && (await one(`select approval_status s from providers where id = $1`, [prov.c6])).s === 'PENDING', { again: again.status, forbidden: forbiddenAction.status });

      const forged = await call('PATCH', `/admin/providers/${prov.c5}/approve`, { token: T.admin, headers: { 'X-Request-ID': `qa-forged-${RUN}`, 'X-User-Id': ids.admin2, 'X-Admin-Id': ids.admin2 } });
      const forgedRows = await audits('PROVIDER', prov.c5);
      check('7. actor identity comes from the session only: spoofed identity headers are ignored', forged.status === 200 && forgedRows.length === 1 && forgedRows[0].admin === ids.admin, forgedRows);
    }

    section('3. Concurrency across two instances');
    {
      const targets = Array.from({ length: 10 }, (_, i) => ids[`target${i}`]);
      const results3 = await Promise.all(targets.map((userId, i) => call('PATCH', `/admin/users/${userId}/suspend`, { token: i % 2 ? T.admin2 : T.admin, port: PORTS[i % 2], headers: { 'X-Request-ID': `qa-suspend-${RUN}-${i}` } })));
      const rows = await all(`select target_id::text target, admin_user_id::text admin, metadata->>'requestId' rid from admin_activity_logs where action = 'USER_SUSPENDED' and target_id = any($1::bigint[])`, [targets]);
      const byTarget = Object.fromEntries(rows.map((row) => [row.target, row]));
      const allMatch = targets.every((userId, i) => byTarget[userId]?.rid === `qa-suspend-${RUN}-${i}` && byTarget[userId]?.admin === (i % 2 ? ids.admin2 : ids.admin));
      check('8. 10 concurrent suspensions on 2 instances: 10 rows, each with its own requestId and actor', results3.every((r, i) => r.status === 200 && r.requestId === `qa-suspend-${RUN}-${i}`) && rows.length === 10 && allMatch, { statuses: results3.map((r) => r.status), rows });

      const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => call('PATCH', `/admin/providers/${prov.dup}/approve`, { token: T.admin, port: PORTS[i % 2], headers: { 'X-Request-ID': `qa-race-${RUN}-${i}` } })));
      const winners = racers.filter((r) => r.status === 200);
      const dupRows = await audits('PROVIDER', prov.dup);
      check('9. 6 racing approvals of one provider: exactly one 200 (others 409), exactly one audit row, carrying the winner\'s requestId', winners.length === 1 && racers.filter((r) => r.status === 409).length === 5 && dupRows.length === 1 && dupRows[0].metadata.requestId === winners[0]?.requestId, { statuses: racers.map((r) => r.status), dupRows });
    }

    section('4. Atomicity: business change and audit row roll back together');
    {
      // QA-only trigger: any audit insert for this provider fails inside the admin transaction.
      await db.query(`create function qa_fail_audit() returns trigger language plpgsql as $$ begin if new.target_type = 'PROVIDER' and new.target_id = ${Number(prov.fail)} then raise exception 'qa forced audit failure for ${LEAK_EMAIL}'; end if; return new; end $$`);
      await db.query(`create trigger qa_fail_audit before insert on admin_activity_logs for each row execute function qa_fail_audit()`);
      const failId = `qa-forced-fail-${RUN}`;
      const r = await call('PATCH', `/admin/providers/${prov.fail}/approve`, { token: T.admin, headers: { 'X-Request-ID': failId } });
      const state = await one(`select approval_status s from providers where id = $1`, [prov.fail]);
      check('10. forced audit failure -> 500 with the generic body, provider still PENDING, no audit row', r.status === 500 && JSON.stringify(r.body) === JSON.stringify({ statusCode: 500, message: 'Internal server error' }) && r.requestId === failId && state.s === 'PENDING' && (await audits('PROVIDER', prov.fail)).length === 0, { status: r.status, body: r.body, state });
      await db.query(`drop trigger qa_fail_audit on admin_activity_logs`);
      await db.query(`drop function qa_fail_audit()`);
      const retry = await call('PATCH', `/admin/providers/${prov.fail}/approve`, { token: T.admin });
      check('11. after the fault is removed the same action succeeds and is audited once', retry.status === 200 && (await audits('PROVIDER', prov.fail)).length === 1, { status: retry.status });
    }

    section('5. Admin activity-log API unchanged');
    {
      const list = await call('GET', `/admin/activity-logs?targetType=PROVIDER&adminUserId=${ids.admin}&limit=2&offset=0`, { token: T.admin });
      const page2 = await call('GET', `/admin/activity-logs?targetType=PROVIDER&adminUserId=${ids.admin}&limit=2&offset=2`, { token: T.admin });
      const expectedTotal = (await one(`select count(*)::int c from admin_activity_logs where target_type = 'PROVIDER' and admin_user_id = $1`, [ids.admin])).c;
      const keys = list.body.items?.[0] ? Object.keys(list.body.items[0]).join() : '';
      check('12. list: filters + pagination { limit, offset, total }, item shape unchanged, pages disjoint', list.status === 200 && list.body.items.length === 2 && list.body.pagination.total === expectedTotal && list.body.pagination.limit === 2 && keys === 'id,adminUserId,action,targetType,targetId,metadata,createdAt' && page2.body.items.every((i) => !list.body.items.some((j) => j.id === i.id)), { list: list.body, keys });
      const byAction = await call('GET', `/admin/activity-logs?action=USER_SUSPENDED&limit=50`, { token: T.admin2 });
      check('13. action filter returns the 10 suspensions, newest first', byAction.status === 200 && byAction.body.pagination.total === 10 && byAction.body.items.every((i) => i.action === 'USER_SUSPENDED') && byAction.body.items.every((item, i, arr) => i === 0 || arr[i - 1].createdAt >= item.createdAt), byAction.body.pagination);
      const old = await call('GET', `/admin/activity-logs/${legacy.id}`, { token: T.admin });
      check('14. pre-BE09 row (no requestId) still readable with its original metadata', old.status === 200 && sameObject(old.body.metadata, { fromStatus: 'PENDING', toStatus: 'APPROVED' }) && old.body.adminUserId === ids.admin2, old.body);
      const rbac = [await call('GET', `/admin/activity-logs/${legacy.id}`, { token: T.cust }), await call('GET', `/admin/activity-logs/${legacy.id}`), await call('GET', '/admin/activity-logs', { token: T.cust })];
      check('15. activity logs stay ADMIN-only (403 customer, 401 anonymous)', rbac.map((r) => r.status).join() === '403,401,403', rbac.map((r) => r.status));
      const auditRowsWithSecrets = await one(`select count(*)::int c from admin_activity_logs where metadata::text ~* '(password|token|authorization|cookie|@)'`);
      check('16. no audit metadata contains credentials, tokens or e-mail addresses', auditRowsWithSecrets.c === 0, auditRowsWithSecrets);
    }

    section('6. Application logs');
    {
      await sleep(300); // completion events are written on response 'finish'
      const raw = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
      fs.writeFileSync(path.join(OUT_DIR, 'all-app-logs.jsonl'), raw);
      const lines = raw.split('\n').filter((l) => l.trim() !== '');
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const notJson = lines.filter((_, i) => parsed[i] === null || typeof parsed[i] !== 'object');
      check(`17. every log line (${lines.length}) is one JSON object with timestamp, level, event`, notJson.length === 0 && parsed.every((r) => r && typeof r.timestamp === 'string' && typeof r.level === 'string' && typeof r.event === 'string'), notJson.slice(0, 3));

      const completions = parsed.filter((r) => r?.event === 'http.request.completed' || r?.event === 'http.request.aborted');
      const perId = {};
      for (const c of completions) perId[c.requestId] = (perId[c.requestId] ?? 0) + 1;
      const tracked = responses.filter((r) => r.requestId);
      const missingOrDup = tracked.filter((r) => perId[r.requestId] !== 1);
      check(`18. exactly one completion event per request (${tracked.length} requests), same requestId as the response header`, missingOrDup.length === 0, missingOrDup.slice(0, 5));

      const statusMatches = tracked.every((r) => completions.find((c) => c.requestId === r.requestId)?.statusCode === r.status);
      const levelsOk = completions.every((c) => (c.statusCode >= 500 ? c.level === 'error' : c.statusCode >= 400 ? c.level === 'warn' : ['info', 'debug'].includes(c.level)));
      check('19. completion status codes equal the responses; levels: 5xx error, 4xx warn, else info/debug', statusMatches && levelsOk, completions.filter((c) => !['info', 'debug', 'warn', 'error'].includes(c.level)).slice(0, 3));

      const approve = completions.find((c) => c.requestId === `qa-approve-${RUN}-seq`);
      const routesRaw = completions.filter((c) => /\/\d+(\/|$)|\?|@/.test(c.route ?? ''));
      check('20. routes are templates (/api/admin/providers/:id/approve), never raw ids, query strings or path values', approve?.route === '/api/admin/providers/:id/approve' && routesRaw.length === 0 && completions.find((c) => c.statusCode === 404)?.route === '/(unmatched)', { approve, routesRaw: routesRaw.slice(0, 3) });

      const failed = completions.find((c) => c.requestId === `qa-forced-fail-${RUN}`);
      check('21. the forced 500 is one error event with errorName QueryFailedError and SQLSTATE P0001, no message', failed?.level === 'error' && failed.errorName === 'QueryFailedError' && failed.dbCode === 'P0001' && !parsed.some((r) => r?.requestId === `qa-forced-fail-${RUN}` && r !== failed), failed);

      const appLines = parsed.filter((r) => r?.event === 'app.log' && r.requestId);
      check('22. application lines written during a request carry its requestId (e.g. auth/login handling)', parsed.filter((r) => r?.requestId).length >= completions.length && appLines.every((r) => typeof r.requestId === 'string'), { appLines: appLines.length });

      const leaked = [...secrets, LEAK_EMAIL, 'qa forced audit failure', ...Object.keys(ids).map((n) => mail(n))].filter((s) => raw.includes(s));
      const shapes = [/eyJhbGciOi/, /password_hash/i, /"authorization"/i, /"cookie"/i, /\n\s+at\s/, /\bat \S+ \(.+:\d+:\d+\)/];
      check(`23. logs contain no password, JWT, refresh token, JWT/DB secret, e-mail address, DB error text or stack trace (${secrets.length + 1 + Object.keys(ids).length} values checked)`, leaked.length === 0 && shapes.every((re) => !re.test(raw)), { leaked: leaked.map((s) => s.slice(0, 6) + '…'), shapes: shapes.filter((re) => re.test(raw)).map(String) });
      check('24. no Firebase activity, push worker disabled', /Push delivery worker disabled/.test(raw) && !/firebase/i.test(raw), null);
    }
  } finally {
    for (const app of apps) await app.stop();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Logs and evidence: ${OUT_DIR}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('QA run aborted:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
