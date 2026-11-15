/*
 * P3-BE10 API security matrix: real HTTP + real PostgreSQL on a disposable
 * QA database only (pawflow_qa_*). Two API instances.
 *
 *   npm run build
 *   npm run qa:api-security-matrix
 *
 * The route list is not hand-written: test/qa/route-inventory.cjs reads
 * every controller route of dist/ with its guards and @Roles from Nest
 * metadata. For EVERY route:
 *   - public routes must be exactly the reviewed allowlist (a new route
 *     without JwtAuthGuard fails this suite);
 *   - every Swagger operation exists and every route is documented;
 *   - guarded routes answer 401 to: no token, forged signature, expired
 *     token, token of a logged-out session, token of a suspended account,
 *     malformed Authorization header;
 *   - @Roles routes answer 403 to every authenticated role not listed;
 *   - every rejected request (401/403) leaves every table byte-identical;
 *   - allowed roles never get 401 or 500; malformed ids never 500;
 *   - every response carries X-Request-ID (BE09), has no stack trace, no
 *     credential / password-hash / device-token field, and error bodies keep
 *     the { statusCode, message } contract.
 * Plus privilege escalation through DTO injection (role, status, owner,
 * customer, approval fields) with positive controls, and IDOR attempts with
 * valid foreign ids on owned resources.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_api_security), QA_PORTS
 * (default 8341,8342), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ROOT, DB, vnDate, prepareDatabase, dropDatabase, createApp, createApi, keyPaths } = require('./qa-env.cjs');
const { routeInventory, fillParams } = require('./route-inventory.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_api_security';
const PORTS = (process.env.QA_PORTS ?? '8341,8342').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-api-security-'));
const JWT_SECRET = randomUUID() + randomUUID();
const PASSWORD = 'QaSecurityMatrix123!';
const RUN = 'sm' + Date.now().toString(36);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLES = ['CUSTOMER', 'PROVIDER_OWNER', 'PROVIDER_STAFF', 'ADMIN'];
const MISSING_ID = '999999999';

/**
 * Reviewed list of intentionally public routes (no JwtAuthGuard): account
 * entry points and the public catalogue. Any other unguarded route fails.
 */
const PUBLIC_ROUTES = [
  'GET /',
  'POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /auth/verify-email',
  'GET /availability/public', 'GET /availability/public/search', 'GET /availability/public/:id',
  'GET /pet-types', 'GET /service-categories',
  'GET /providers/public/search', 'GET /providers/public/:id', 'GET /reviews/provider/:providerId',
  'GET /services/public', 'GET /services/public/search', 'GET /services/public/:id',
];

/** Routes that end the caller's own session(s) or credentials: exercised last, never in the shared-token sweeps. */
const SESSION_ENDING = new Set(['POST /auth/logout', 'POST /auth/logout-all', 'POST /auth/change-password', 'DELETE /auth/sessions/:id']);

/** Keys that must never appear in any response body (credentials, hashes, device destinations, internals). */
const FORBIDDEN_KEYS = ['password', 'passwordHash', 'password_hash', 'tokenHash', 'token_hash', 'refreshTokenHash', 'sessionSecret', 'registrationToken', 'encryptedRegistration', 'registrationCiphertext', 'fid', 'fcmToken', 'stack', 'leaseToken', 'secret'];

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 1200)}`);
}
const section = (title) => console.log(`\n## ${title}`);
const key = (r) => `${r.method} ${r.path}`;

async function main() {
  const routes = routeInventory();
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const apps = [];
  const api = createApi(PORTS);
  const seen = []; // every response, for the global response checks
  const call = async (method, url, opts = {}) => {
    const r = await api(method, url, opts);
    seen.push({ method, url, status: r.status, requestId: r.headers.get('x-request-id'), body: r.body });
    return r;
  };
  const mail = (n) => `${n}.${RUN}@qa.test`;

  /** Byte-level fingerprint of every application table (md5 of all rows, ordered). */
  const tables = (await all(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'migrations' order by 1`)).map((t) => t.tablename);
  const snapshot = async () => {
    const out = {};
    for (const t of tables) out[t] = (await one(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h, count(*)::int n from "${t}" x`)).h;
    return out;
  };
  const changedTables = (a, b) => tables.filter((t) => a[t] !== b[t]);

  try {
    section('0. Inventory, schema, documentation');
    check(`route inventory read from dist/ metadata: ${routes.length} routes`, routes.length >= 100, routes.length);
    check('17 migrations applied, 0 pending DDL', migrations.length === 17 && pendingDdl.length === 0, { count: migrations.length, pendingDdl });

    const unguarded = routes.filter((r) => !r.guards.includes('JwtAuthGuard')).map(key);
    const unexpectedPublic = unguarded.filter((k) => !PUBLIC_ROUTES.includes(k));
    const staleAllowlist = PUBLIC_ROUTES.filter((k) => !unguarded.includes(k));
    check(`public routes = reviewed allowlist (${PUBLIC_ROUTES.length}); no other route lacks JwtAuthGuard`, unexpectedPublic.length === 0 && staleAllowlist.length === 0, { unexpectedPublic, staleAllowlist });
    const rolesWithoutGuard = routes.filter((r) => r.roles && !r.guards.includes('RolesGuard')).map(key);
    check('every @Roles route is enforced by RolesGuard (no decorative role metadata)', rolesWithoutGuard.length === 0, rolesWithoutGuard);
    const unknownRoles = routes.flatMap((r) => r.roles ?? []).filter((role) => !ROLES.includes(role));
    check('@Roles only uses the 4 implemented roles', unknownRoles.length === 0, unknownRoles);

    // ------------------------------------------------------------- seed
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    const user = async (n, role) => (ids[n] = (await one(`insert into users(full_name, email, phone, password_hash, role, status) values ($1, $2, $3, $4, $5, 'ACTIVE') returning id::text id`, [`QA ${n}`, mail(n), '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), hash, role])).id);
    for (const [n, role] of [['cust', 'CUSTOMER'], ['cust2', 'CUSTOMER'], ['owner', 'PROVIDER_OWNER'], ['owner2', 'PROVIDER_OWNER'], ['staff', 'PROVIDER_STAFF'], ['admin', 'ADMIN'], ['suspended', 'CUSTOMER'], ['loggedOut', 'CUSTOMER']]) await user(n, role);
    const petType = (await one(`insert into pet_types(name) values ($1) returning id::text id`, ['Dog ' + RUN])).id;
    const category = (await one(`insert into service_categories(name) values ($1) returning id::text id`, ['Groom ' + RUN])).id;
    const prov = {}; const svc = {}; const slot = {}; const pet = {};
    for (const p of ['1', '2']) {
      prov[p] = (await one(`insert into providers(owner_id, business_name, address, approval_status) values ($1, $2, 'QA road', 'APPROVED') returning id::text id`, [ids[p === '1' ? 'owner' : 'owner2'], `QA Sec ${p} ${RUN}`])).id;
      svc[p] = (await one(`insert into services(provider_id, category_id, name, price, duration_minutes) values ($1, $2, $3, 100000, 60) returning id::text id`, [prov[p], category, `Groom ${p}`])).id;
      slot[p] = (await one(`insert into availability_slots(provider_id, service_id, slot_date, start_time, end_time, capacity, booked_count) values ($1, $2, $3, '09:00', '10:00', 10, 0) returning id::text id`, [prov[p], svc[p], vnDate(5)])).id;
      // Bookings must fall inside active working hours (P2-14).
      for (let dow = 0; dow < 7; dow++) await db.query(`insert into provider_working_hours(provider_id, day_of_week, start_time, end_time, is_active) values ($1, $2, '08:00', '18:00', true)`, [prov[p], dow]);
    }
    await db.query(`insert into provider_staff(provider_id, user_id, status) values ($1, $2, 'ACTIVE')`, [prov['1'], ids.staff]);
    for (const c of ['cust', 'cust2']) pet[c] = (await one(`insert into pets(owner_id, pet_type_id, name) values ($1, $2, $3) returning id::text id`, [ids[c], petType, 'Pet ' + c])).id;

    for (const port of PORTS) { const app = createApp(NAME, [port], { logDir: OUT_DIR, jwtSecret: JWT_SECRET }); await app.start(); apps.push(app); }
    const secrets = [PASSWORD, JWT_SECRET, DB.password].filter((s) => s && s.length >= 6);
    const login = async (n) => {
      const r = await call('POST', '/auth/login', { body: { email: mail(n), password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login ${n}: ${r.status}`);
      secrets.push(r.body.accessToken, r.body.refreshToken);
      return r.body;
    };
    const T = {};
    for (const n of ['cust', 'cust2', 'owner', 'owner2', 'staff', 'admin']) T[n] = (await login(n)).accessToken;
    const byRole = { CUSTOMER: T.cust, PROVIDER_OWNER: T.owner, PROVIDER_STAFF: T.staff, ADMIN: T.admin };

    // Bad credentials of every kind.
    const sus = await login('suspended');
    const suspend = await call('PATCH', `/admin/users/${ids.suspended}/suspend`, { token: T.admin });
    const out = await login('loggedOut');
    const logout = await call('POST', '/auth/logout', { token: out.accessToken, body: { refreshToken: out.refreshToken } });
    const decoded = jwt.decode(T.cust);
    const BAD = {
      'no token': undefined,
      'forged signature': jwt.sign({ sub: ids.admin, role: 'ADMIN', sid: decoded.sid }, 'not-the-secret'),
      'expired token': jwt.sign({ sub: decoded.sub, role: decoded.role, sid: decoded.sid, exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET),
      'unknown session id': jwt.sign({ sub: decoded.sub, role: decoded.role, sid: randomUUID() }, JWT_SECRET),
      'session of another user (sub/sid mismatch)': jwt.sign({ sub: ids.admin, role: 'ADMIN', sid: decoded.sid }, JWT_SECRET),
      'logged-out session': out.accessToken,
      'suspended account': sus.accessToken,
    };
    check('setup: suspension 200 and logout 2xx (their tokens become the negative fixtures)', suspend.status === 200 && [200, 201, 204].includes(logout.status), { suspend: suspend.status, logout: logout.status });

    // Owned resources used for IDOR attempts.
    const booking = await call('POST', '/bookings', { token: T.cust, body: { petId: pet.cust, slotId: slot['1'] } });
    check('setup: customer 1 books provider 1 (201)', booking.status === 201, booking.body);
    const bookingId = String(booking.body.id);

    section('1. Swagger documents exactly the implemented routes');
    {
      const docs = await (await fetch(`http://localhost:${PORTS[0]}/api/docs-json`)).json();
      const documented = Object.entries(docs.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p.replace(/^\/api/, '').replace(/\{([^}]+)\}/g, ':$1') || '/'}`));
      const undocumented = routes.map(key).filter((k) => !documented.includes(k));
      const phantom = documented.filter((k) => !routes.map(key).includes(k));
      check(`every route is in /api/docs-json and every documented operation exists (${documented.length} operations)`, undocumented.length === 0 && phantom.length === 0, { undocumented, phantom });
    }

    section('2. Authentication: every guarded route rejects every bad credential with 401');
    const guarded = routes.filter((r) => r.guards.includes('JwtAuthGuard'));
    {
      const before = await snapshot();
      const failures = [];
      for (const r of guarded) {
        for (const [label, token] of Object.entries(BAD)) {
          const res = await call(r.method, fillParams(r.path, MISSING_ID), { token, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
          if (res.status !== 401) failures.push({ route: key(r), label, status: res.status });
        }
        const malformed = await call(r.method, fillParams(r.path, MISSING_ID), { headers: { Authorization: 'Basic dXNlcjpwYXNz' }, body: r.method === 'GET' ? undefined : {} });
        if (malformed.status !== 401) failures.push({ route: key(r), label: 'Basic scheme', status: malformed.status });
      }
      check(`${guarded.length} guarded routes x ${Object.keys(BAD).length + 1} bad credentials -> 401 every time (${guarded.length * (Object.keys(BAD).length + 1)} requests)`, failures.length === 0, failures.slice(0, 10));
      const changed = changedTables(before, await snapshot());
      check('the 401 sweep changed no table (byte-identical fingerprints of every table)', changed.length === 0, changed);
    }

    section('3. Role authorization: every @Roles route rejects every other role with 403');
    const roleRoutes = routes.filter((r) => r.roles && !SESSION_ENDING.has(key(r)));
    {
      const before = await snapshot();
      const failures = [];
      let requests = 0;
      for (const r of roleRoutes) {
        for (const role of ROLES.filter((x) => !r.roles.includes(x))) {
          requests++;
          const res = await call(r.method, fillParams(r.path, MISSING_ID), { token: byRole[role], body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
          if (res.status !== 403) failures.push({ route: key(r), role, status: res.status });
        }
      }
      check(`${roleRoutes.length} role-restricted routes, every forbidden role -> 403 (${requests} requests)`, failures.length === 0, failures.slice(0, 10));
      const changed = changedTables(before, await snapshot());
      check('the 403 sweep changed no table', changed.length === 0, changed);
      const adminOnly = routes.filter((r) => r.path.startsWith('/admin')).filter((r) => JSON.stringify(r.roles) !== '["ADMIN"]').map(key);
      check('every /admin route is ADMIN-only', adminOnly.length === 0, adminOnly);

      // A correctly signed token (as if the signing secret leaked) whose role claim says ADMIN for a
      // CUSTOMER session: roles come from the database (JwtStrategy), never from the claim.
      const tampered = jwt.sign({ sub: decoded.sub, role: 'ADMIN', sid: decoded.sid }, JWT_SECRET, { expiresIn: 600 });
      const adminRoutes = routes.filter((r) => JSON.stringify(r.roles) === '["ADMIN"]');
      const escalations = [];
      const before2 = await snapshot();
      for (const r of adminRoutes) {
        const res = await call(r.method, fillParams(r.path, MISSING_ID), { token: tampered, body: r.method === 'GET' ? undefined : {} });
        if (res.status !== 403) escalations.push({ route: key(r), status: res.status });
      }
      check(`role claim tampered to ADMIN on a CUSTOMER session -> 403 on all ${adminRoutes.length} ADMIN routes (role read from the database)`, escalations.length === 0, escalations.slice(0, 5));
      check('the tampered-claim sweep changed no table', changedTables(before2, await snapshot()).length === 0, changedTables(before2, await snapshot()));
    }

    section('4. Allowed roles: never 401, never 500 (missing and malformed ids)');
    {
      const failures = [];
      let requests = 0;
      for (const r of guarded.filter((x) => !SESSION_ENDING.has(key(x)))) {
        for (const role of r.roles ?? ROLES) {
          for (const id of r.path.includes(':') ? [MISSING_ID, 'abc', '-1', '1.5', '99999999999999999999999'] : [null]) {
            requests++;
            const url = id === null ? r.path : fillParams(r.path, id);
            const res = await call(r.method, url, { token: byRole[role], body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
            if (res.status === 401 || res.status >= 500) failures.push({ route: key(r), role, id, status: res.status });
          }
        }
      }
      check(`allowed role x id variants: no 401, no 5xx (${requests} requests)`, failures.length === 0, failures.slice(0, 10));
      const publicFailures = [];
      for (const r of routes.filter((x) => !x.guards.includes('JwtAuthGuard'))) {
        for (const id of r.path.includes(':') ? [MISSING_ID, 'abc'] : [null]) {
          const res = await call(r.method, id === null ? r.path : fillParams(r.path, id), { body: r.method === 'GET' ? undefined : {} });
          if (res.status >= 500 || res.status === 401 || res.status === 403) publicFailures.push({ route: key(r), id, status: res.status });
        }
      }
      check('public routes answer anonymous callers without 401/403/5xx (empty bodies -> 400, missing -> 404)', publicFailures.length === 0, publicFailures);
    }

    section('5. Privilege escalation through DTO injection (with positive controls)');
    {
      const before = await snapshot();
      const reg = (extra) => call('POST', '/auth/register', { body: { fullName: 'QA New', email: mail(`new${Math.random().toString(36).slice(2, 8)}`), password: PASSWORD, ...extra } });
      const injected = {
        'register role=ADMIN': await reg({ role: 'ADMIN' }),
        'register status=ACTIVE+emailVerifiedAt': await reg({ status: 'ACTIVE', emailVerifiedAt: new Date().toISOString() }),
        'profile role=ADMIN': await call('PATCH', '/users/me', { token: T.cust, body: { fullName: 'Hacker', role: 'ADMIN' } }),
        'profile status / email': await call('PATCH', '/users/me', { token: T.cust, body: { status: 'ACTIVE', email: mail('takeover') } }),
        'provider approvalStatus=APPROVED': await call('PATCH', '/providers/me', { token: T.owner, body: { approvalStatus: 'SUSPENDED', ownerId: ids.owner2 } }),
        'provider ratingAvg': await call('PATCH', '/providers/me', { token: T.owner, body: { ratingAvg: '5.00', ratingCount: 999 } }),
        'booking customerId of another customer': await call('POST', '/bookings', { token: T.cust, body: { petId: pet.cust, slotId: slot['1'], customerId: ids.cust2 } }),
        'booking status=CONFIRMED': await call('POST', '/bookings', { token: T.cust, body: { petId: pet.cust, slotId: slot['1'], status: 'CONFIRMED' } }),
        'pet ownerId of another customer': await call('POST', '/pets', { token: T.cust, body: { petTypeId: petType, name: 'Injected', ownerId: ids.cust2 } }),
      };
      const notRejected = Object.entries(injected).filter(([, r]) => r.status !== 400).map(([k, r]) => [k, r.status]);
      check(`${Object.keys(injected).length} privileged-field injections -> 400 (forbidNonWhitelisted)`, notRejected.length === 0, notRejected);
      const changed = changedTables(before, await snapshot());
      check('the rejected injections changed no table', changed.length === 0, changed);
      const control = {
        register: (await reg({})).status,
        profile: (await call('PATCH', '/users/me', { token: T.cust, body: { fullName: 'QA cust renamed' } })).status,
        provider: (await call('PATCH', '/providers/me', { token: T.owner, body: { description: 'Updated' } })).status,
        pet: (await call('POST', '/pets', { token: T.cust, body: { petTypeId: petType, name: 'Legit' } })).status,
      };
      const roles = await one(`select role, status from users where id = $1`, [ids.cust]);
      check('positive controls succeed with the same payloads minus the privileged field; role/status unchanged', control.register === 201 && control.profile === 200 && control.provider === 200 && control.pet === 201 && roles.role === 'CUSTOMER' && roles.status === 'ACTIVE', { control, roles });
    }

    section('6. Resource-level isolation (IDOR with valid foreign ids)');
    {
      // Fixtures first (the fingerprint is taken after them): provider 1's staff link and working
      // hours, a complaint of customer 1, and a COMPLETED booking whose payment provider 1 recorded.
      const staffLink = (await one(`select id::text id from provider_staff where provider_id = $1 and user_id = $2`, [prov['1'], ids.staff])).id;
      const hours = (await one(`select id::text id from provider_working_hours where provider_id = $1 order by id limit 1`, [prov['1']])).id;
      const complaint = (await one(`insert into complaints(booking_id, created_by, reason, status) values ($1, $2, 'QA private complaint', 'OPEN') returning id::text id`, [bookingId, ids.cust])).id;
      const done = (await one(`insert into bookings(customer_id, pet_id, provider_id, service_id, slot_id, status, booked_price) values ($1, $2, $3, $4, $5, 'COMPLETED', 100000) returning id::text id`, [ids.cust, pet.cust, prov['1'], svc['1'], slot['1']])).id;
      await db.query(`insert into booking_status_logs(booking_id, old_status, new_status) values ($1, null, 'COMPLETED')`, [done]);
      await db.query(`update availability_slots set booked_count = booked_count + 1 where id = $1`, [slot['1']]);
      const paid = await call('PUT', `/payments/provider/booking/${done}`, { token: T.owner, body: { paymentStatus: 'PAID', method: 'CASH' } });
      check('setup: provider 1 records the payment of its completed booking (200)', paid.status === 200, { status: paid.status, body: paid.body });

      const before = await snapshot();
      const attempts = {
        'customer 2 reads customer 1 booking': await call('GET', `/bookings/mine/${bookingId}`, { token: T.cust2 }),
        'customer 2 cancels customer 1 booking': await call('POST', `/bookings/mine/${bookingId}/cancel`, { token: T.cust2, body: {} }),
        'owner 2 reads provider 1 booking': await call('GET', `/bookings/provider/${bookingId}`, { token: T.owner2 }),
        'owner 2 confirms provider 1 booking': await call('POST', `/bookings/provider/${bookingId}/confirm`, { token: T.owner2, body: {} }),
        'owner 2 rejects provider 1 booking': await call('POST', `/bookings/provider/${bookingId}/reject`, { token: T.owner2, body: { reason: 'x' } }),
        'customer 2 reads customer 1 pet': await call('GET', `/pets/${pet.cust}`, { token: T.cust2 }),
        'customer 2 deletes customer 1 pet': await call('DELETE', `/pets/${pet.cust}`, { token: T.cust2 }),
        'customer 2 books with customer 1 pet': await call('POST', '/bookings', { token: T.cust2, body: { petId: pet.cust, slotId: slot['1'] } }),
      };
      // Owner-scoped provider resources of provider 1, attacked by owner 2 with valid ids and valid bodies
      // (so validation passes and only the ownership check can stop the request).
      Object.assign(attempts, {
        'owner 2 reads provider 1 slot': await call('GET', `/availability/mine/${slot['1']}`, { token: T.owner2 }),
        'owner 2 updates provider 1 slot': await call('PATCH', `/availability/mine/${slot['1']}`, { token: T.owner2, body: { capacity: 1 } }),
        'owner 2 deletes provider 1 slot': await call('DELETE', `/availability/mine/${slot['1']}`, { token: T.owner2 }),
        'owner 2 reads provider 1 service': await call('GET', `/services/mine/${svc['1']}`, { token: T.owner2 }),
        'owner 2 updates provider 1 service': await call('PATCH', `/services/mine/${svc['1']}`, { token: T.owner2, body: { price: 1 } }),
        'owner 2 deletes provider 1 service': await call('DELETE', `/services/mine/${svc['1']}`, { token: T.owner2 }),
        'owner 2 reads provider 1 staff link': await call('GET', `/providers/staff/${staffLink}`, { token: T.owner2 }),
        'owner 2 deactivates provider 1 staff': await call('PATCH', `/providers/staff/${staffLink}`, { token: T.owner2, body: { status: 'INACTIVE' } }),
        'owner 2 removes provider 1 staff': await call('DELETE', `/providers/staff/${staffLink}`, { token: T.owner2 }),
        'owner 2 edits provider 1 working hours': await call('PATCH', `/providers/working-hours/${hours}`, { token: T.owner2, body: { isActive: false } }),
        'owner 2 deletes provider 1 working hours': await call('DELETE', `/providers/working-hours/${hours}`, { token: T.owner2 }),
        'owner 2 reads provider 1 booking payment': await call('GET', `/payments/provider/booking/${done}`, { token: T.owner2 }),
        'owner 2 marks provider 1 booking paid': await call('PUT', `/payments/provider/booking/${done}`, { token: T.owner2, body: { paymentStatus: 'PAID', method: 'CASH' } }),
        'customer 2 reads customer 1 complaint': await call('GET', `/complaints/mine/${complaint}`, { token: T.cust2 }),
      });
      const notHidden = Object.entries(attempts).filter(([, r]) => r.status !== 404).map(([k, r]) => [k, r.status, r.body?.message]);
      check(`${Object.keys(attempts).length} foreign-object attempts (bookings, pets, slots, services, staff, working hours, payments, complaints) -> 404 (existing policy: foreign = missing, C-01)`, notHidden.length === 0, notHidden);
      const changed = changedTables(before, await snapshot());
      check('the IDOR attempts changed no table', changed.length === 0, changed);
      const ownerView = await call('GET', `/bookings/provider/${bookingId}`, { token: T.owner });
      const staffView = await call('GET', `/bookings/provider/${bookingId}`, { token: T.staff });
      check('positive controls: owner and active staff of provider 1 see the booking; customer name only (no email/phone)', ownerView.status === 200 && staffView.status === 200 && !keyPaths(ownerView.body).some((p) => /customer\.(email|phone)/.test(p)), { owner: ownerView.status, staff: staffView.status });
      const controls = {
        slot: (await call('GET', `/availability/mine/${slot['1']}`, { token: T.owner })).status,
        service: (await call('GET', `/services/mine/${svc['1']}`, { token: T.owner })).status,
        staff: (await call('GET', `/providers/staff/${staffLink}`, { token: T.owner })).status,
        payment: (await call('GET', `/payments/provider/booking/${done}`, { token: T.owner })).status,
        complaint: (await call('GET', `/complaints/mine/${complaint}`, { token: T.cust })).status,
      };
      check('positive controls: the owning provider / customer reads the same slot, service, staff link, payment and complaint (200)', Object.values(controls).every((s) => s === 200), controls);
    }

    section('7. Global response contract');
    {
      const noId = seen.filter((r) => !UUID_V4.test(r.requestId ?? ''));
      check(`every response (${seen.length}) carries a server-generated X-Request-ID`, noId.length === 0, noId.slice(0, 3).map((r) => [r.method, r.url, r.status]));
      const leaks = seen.flatMap((r) => keyPaths(r.body).filter((p) => FORBIDDEN_KEYS.includes(p.split('.').pop().replace(/^\[\]/, ''))).map((p) => [r.method, r.url, p]));
      check('no response body contains a credential, hash, device token, lease token or stack field', leaks.length === 0, leaks.slice(0, 5));
      const tokenEcho = seen.filter((r) => !/^\/auth\/(login|refresh)$/.test(r.url) && secrets.some((s) => JSON.stringify(r.body ?? '').includes(s)));
      check('no response echoes a password, JWT secret, DB password or token outside login/refresh', tokenEcho.length === 0, tokenEcho.slice(0, 3).map((r) => [r.method, r.url]));
      const errors = seen.filter((r) => r.status >= 400);
      const badShape = errors.filter((r) => !(r.body && typeof r.body === 'object' && r.body.statusCode === r.status && 'message' in r.body));
      const internals = errors.filter((r) => /QueryFailedError|duplicate key|violates|\bat \S+:\d+:\d+|node_modules|SELECT |INSERT /i.test(JSON.stringify(r.body)));
      check(`every error body (${errors.length}) keeps { statusCode = HTTP status, message }, with no SQL, driver or stack text`, badShape.length === 0 && internals.length === 0, { badShape: badShape.slice(0, 3).map((r) => [r.method, r.url, r.status, r.body]), internals: internals.slice(0, 3).map((r) => [r.url, r.body]) });
    }

    section('8. Session-ending routes (last)');
    {
      const a = await login('cust2');
      const b = await login('cust2');
      const killOther = await call('DELETE', `/auth/sessions/${jwt.decode(b.accessToken).sid}`, { token: a.accessToken });
      const bAfter = await call('GET', '/auth/me', { token: b.accessToken });
      const cross = await call('DELETE', `/auth/sessions/${jwt.decode(T.cust).sid}`, { token: a.accessToken });
      const custStill = await call('GET', '/auth/me', { token: T.cust });
      check('a user can revoke their own other session (-> 401 there) but not another user\'s session (404, still valid)', [200, 204].includes(killOther.status) && bAfter.status === 401 && cross.status === 404 && custStill.status === 200, { killOther: killOther.status, bAfter: bAfter.status, cross: cross.status, custStill: custStill.status });
      const all2 = await call('POST', '/auth/logout-all', { token: a.accessToken });
      const aAfter = await call('GET', '/auth/me', { token: a.accessToken });
      check('logout-all ends the caller\'s sessions; other users unaffected', [200, 201, 204].includes(all2.status) && aAfter.status === 401 && (await call('GET', '/auth/me', { token: T.cust })).status === 200, { all2: all2.status, aAfter: aAfter.status });
    }

    section('9. Logs');
    {
      const raw = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(path.join(OUT_DIR, f), 'utf8')).join('\n');
      const leaked = secrets.filter((s) => raw.includes(s));
      check(`application logs contain no password, token or secret (${secrets.length} values) and no JWT`, leaked.length === 0 && !/eyJhbGciOi/.test(raw), { leaked: leaked.length });
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
