/*
 * PawFlow frontend integration smoke test (disposable QA database only).
 *
 *   npm run build
 *   npm run qa:fe-smoke
 *
 * Seeds the demo dataset (test/qa/demo-seed.cjs) into a freshly recreated
 * `pawflow_qa_fe_smoke` database, starts two API instances on it and walks the
 * critical MVP flow the frontend depends on:
 *
 *   customer login -> provider search -> provider detail -> service selection
 *   -> availability search -> booking (Idempotency-Key) -> idempotent retry
 *   -> provider confirmation -> booking detail
 *
 * with status, contract, authorization, sensitive-field, CORS and database
 * invariant checks. Real (redacted) responses are written to
 * fe-contract-examples.json in QA_OUT_DIR for the API contract document.
 * The full scenario matrix lives in test/qa/mvp-e2e.cjs; this script stays small.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_fe_smoke), QA_PORTS (default
 * 8101,8102), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_HOST/PORT/USERNAME/PASSWORD.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { vnDate, sourceMigrationCount, prepareDatabase, dropDatabase, createApp, createApi, shape, forbiddenIn, bookingInvariants } = require('./qa-env.cjs');
const { seedDemoData, DEMO_PASSWORD } = require('./demo-seed.cjs');

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_fe_smoke';
const PORTS = (process.env.QA_PORTS ?? '8101,8102').split(',').map(Number);
const OUT_DIR = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-fe-smoke-'));
const FRONTEND_ORIGIN = process.env.QA_FRONTEND_URL ?? 'http://localhost:3000';

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail: condition ? undefined : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + JSON.stringify(detail).slice(0, 400)}`);
}

// Personal data and credentials are redacted before examples are written.
const REDACT = new Set(['accessToken', 'password', 'email', 'phone', 'fullName']);
const redact = (value) => Array.isArray(value) ? value.map(redact)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.has(k) && v !== null ? '<redacted>' : redact(v)]))
    : value;
const examples = {};
const capture = (label, method, url, response, requestBody) => {
  examples[label] = {
    request: { method, url, ...(requestBody === undefined ? {} : { body: redact(requestBody) }) },
    response: { status: response.status, ...(response.replayed ? { 'Idempotent-Replayed': response.replayed } : {}), body: redact(response.body) },
  };
  return response;
};

const SENSITIVE = ['passwordHash', 'password', 'ownerId', 'approvalStatus', 'role', 'customerId', 'bookingId', 'changedBy', 'bookedCount', 'capacity'];
const CONTACT = ['email', 'phone'];
const BASE_VIEW = ['bookedPrice', 'createdAt', 'customerNote', 'id', 'service', 'service.durationMinutes', 'service.id', 'service.name', 'slot', 'slot.endTime', 'slot.id', 'slot.slotDate', 'slot.startTime', 'status', 'updatedAt'];
const PET_VIEW = ['pet', 'pet.breed', 'pet.id', 'pet.name', 'pet.petType', 'pet.petType.id', 'pet.petType.name'];
const CUSTOMER_VIEW = [...BASE_VIEW, ...PET_VIEW, 'provider', 'provider.address', 'provider.businessName', 'provider.id'].sort();
const PROVIDER_VIEW = [...BASE_VIEW, ...PET_VIEW, 'pet.birthDate', 'pet.healthNote', 'pet.weight', 'customer', 'customer.fullName', 'customer.id'].sort();
const LOGS = ['statusLogs', 'statusLogs[].createdAt', 'statusLogs[].id', 'statusLogs[].newStatus', 'statusLogs[].oldStatus', 'statusLogs[].reason'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isId = (v) => typeof v === 'string' && /^[1-9]\d*$/.test(v);
const isMoney = (v) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v);

async function main() {
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  check(`QA database ${NAME} recreated with ${migrations.length} migrations, 0 pending DDL`, migrations.length === sourceMigrationCount() && pendingDdl.length === 0, { migrations: migrations.length, pendingDdl });
  const app = createApp(NAME, PORTS, { logDir: OUT_DIR });
  await app.start();
  const api = createApi(PORTS);
  try {
    const seed = await seedDemoData({ api, db });
    check('demo dataset seeded through the API (invariants clean)', true);
    const statuses = (await db.query('select id::text, status from bookings order by id')).rows;
    check('demo booking lifecycle examples have the expected statuses', same(statuses.map((r) => r.status), ['PENDING_CONFIRMATION', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW', 'PENDING_CONFIRMATION']), statuses);

    // ------------------------------------------------------------ customer login
    const loginBody = { email: seed.accounts.lan.email, password: DEMO_PASSWORD };
    const login = capture('auth.login', 'POST', '/auth/login', await api('POST', '/auth/login', { body: loginBody }), loginBody);
    check('customer login -> 200 with accessToken and user', login.status === 200 && typeof login.body.accessToken === 'string' && login.body.user.role === 'CUSTOMER', login.status);
    const lan = login.body.accessToken;
    const me = capture('auth.me', 'GET', '/auth/me', await api('GET', '/auth/me', { token: lan }));
    check('GET /auth/me -> 200 without password hash', me.status === 200 && forbiddenIn(me.body, ['passwordHash', 'password']).length === 0, me.body);
    capture('users.me', 'GET', '/users/me', await api('GET', '/users/me', { token: lan }));
    capture('pets.list', 'GET', '/pets', await api('GET', '/pets', { token: lan }));
    capture('petTypes.list', 'GET', '/pet-types', await api('GET', '/pet-types'));
    capture('serviceCategories.list', 'GET', '/service-categories', await api('GET', '/service-categories'));
    capture('auth.login.wrongPassword', 'POST', '/auth/login', await api('POST', '/auth/login', { body: { ...loginBody, password: 'WrongPass123' } }), { ...loginBody, password: '<redacted>' });

    // ------------------------------------------------------------ discovery
    const search = capture('providers.search', 'GET', '/providers/public/search?q=Paw', await api('GET', '/providers/public/search?q=Paw'));
    const searchIds = search.body.items.map((i) => i.id);
    check('provider search -> 200 paginated {items, meta, query}; APPROVED shown, PENDING hidden', search.status === 200 && searchIds.includes(seed.providers.pawSpa) && !searchIds.includes(seed.providers.meoXinh) && same(Object.keys(search.body).sort(), ['items', 'meta', 'query']) && same(Object.keys(search.body.meta).sort(), ['hasNextPage', 'hasPreviousPage', 'limit', 'page', 'totalItems', 'totalPages']), search.body);
    check('provider search exposes no owner, contact or approval fields', forbiddenIn(search.body, [...SENSITIVE, ...CONTACT]).length === 0, forbiddenIn(search.body, [...SENSITIVE, ...CONTACT]));
    capture('providers.search.all', 'GET', '/providers/public/search?sort=rating_desc&limit=2', await api('GET', '/providers/public/search?sort=rating_desc&limit=2'));
    const detail = capture('providers.detail', 'GET', '/providers/public/:id', await api('GET', `/providers/public/${seed.providers.pawSpa}`));
    check('provider detail -> 200, ratingAvg/minPrice NUMERIC strings, 1 review counted', detail.status === 200 && isMoney(detail.body.ratingAvg) && isMoney(detail.body.minPrice) && detail.body.ratingCount === 1 && detail.body.serviceCount === 3, detail.body);
    check('PENDING provider detail -> 404', capture('providers.detail.hidden', 'GET', '/providers/public/:id', await api('GET', `/providers/public/${seed.providers.meoXinh}`)).status === 404);
    capture('reviews.provider', 'GET', '/reviews/provider/:providerId', await api('GET', `/reviews/provider/${seed.providers.pawSpa}`));

    const services = capture('services.search', 'GET', '/services/public/search?providerId=:id', await api('GET', `/services/public/search?providerId=${seed.providers.pawSpa}&sort=price_asc`));
    const bath = services.body.items.find((s) => s.id === seed.services.bath);
    check('service search by provider -> 3 services, price as NUMERIC string, sorted by price', services.status === 200 && services.body.items.length === 3 && bath && bath.price === '150000.00' && services.body.items[0].price === '150000.00', services.body.items);
    check('service search exposes no internal fields', forbiddenIn(services.body, [...SENSITIVE, ...CONTACT]).length === 0, forbiddenIn(services.body, SENSITIVE));
    const serviceDetail = capture('services.detail', 'GET', '/services/public/:id', await api('GET', `/services/public/${seed.services.bath}`));
    check('service detail -> 200 durationMinutes 60', serviceDetail.status === 200 && serviceDetail.body.durationMinutes === 60, serviceDetail.body);

    const day = seed.days.pawSpa[2];
    const avail = capture('availability.search', 'GET', '/availability/public/search?providerId&serviceId&date', await api('GET', `/availability/public/search?providerId=${seed.providers.pawSpa}&serviceId=${seed.services.bath}&date=${day}`));
    const slotId = seed.slots[`bath@${day}T09:00`];
    const slotItem = avail.body.items?.find((s) => s.id === slotId);
    check('availability search -> 200 paginated, 3 bath slots that day incl. 09:00, remaining capacity visible', avail.status === 200 && avail.body.items.length === 3 && slotItem && slotItem.capacity === 2 && slotItem.bookedCount === 0, avail.body);
    check('availability items expose no owner/contact/approval fields', forbiddenIn(avail.body, ['ownerId', 'approvalStatus', 'passwordHash', ...CONTACT]).length === 0);
    const slotDetail = capture('availability.detail', 'GET', '/availability/public/:id', await api('GET', `/availability/public/${slotId}`));
    check('slot detail -> 200, belongs to the selected provider and service', slotDetail.status === 200 && slotDetail.body.provider.id === seed.providers.pawSpa && slotDetail.body.service.id === seed.services.bath, slotDetail.body);
    capture('availability.search.invalidDate', 'GET', '/availability/public/search?date=2027-02-30', await api('GET', '/availability/public/search?date=2027-02-30'));

    // ------------------------------------------------------------ booking + idempotent retry
    const key = randomUUID();
    const bookingBody = { petId: seed.pets.mochi, slotId, customerNote: 'Nhờ cắt gọn móng giúp bé.' };
    const created = capture('bookings.create', 'POST', '/bookings (Idempotency-Key)', await api('POST', '/bookings', { token: lan, key, body: bookingBody, port: PORTS[0] }), bookingBody);
    const bookingId = created.body.id;
    check('booking -> 201 PENDING_CONFIRMATION, Idempotent-Replayed: false', created.status === 201 && created.replayed === 'false' && created.body.status === 'PENDING_CONFIRMATION', created);
    check('booking response = customer projection; BIGINT ids and price as strings', same(shape(created.body), CUSTOMER_VIEW) && [created.body.id, created.body.pet.id, created.body.slot.id].every(isId) && created.body.bookedPrice === '150000.00', shape(created.body));
    check('booking response has no internal or personal fields', forbiddenIn(created.body, [...SENSITIVE, ...CONTACT, 'ownerId', 'petId', 'slotId', 'providerId', 'serviceId']).length === 0);
    const retry = capture('bookings.create.replay', 'POST', '/bookings (same Idempotency-Key, retry)', await api('POST', '/bookings', { token: lan, key, body: bookingBody, port: PORTS[1] }), bookingBody);
    check('idempotent retry on the other instance -> 201, Idempotent-Replayed: true, identical body', retry.status === 201 && retry.replayed === 'true' && same(retry.body, created.body), retry);
    const capacity = (await db.query('select booked_count::int c from availability_slots where id = $1', [slotId])).rows[0].c;
    const keyRows = (await db.query('select count(*)::int c from booking_idempotency_keys where idempotency_key = $1', [key])).rows[0].c;
    check('DB: one booking, bookedCount 1, one key row', capacity === 1 && keyRows === 1, { capacity, keyRows });
    capture('bookings.create.keyMismatch', 'POST', '/bookings (same key, different payload)', await api('POST', '/bookings', { token: lan, key, body: { ...bookingBody, customerNote: 'khác' } }), { ...bookingBody, customerNote: 'khác' });
    capture('bookings.create.badKey', 'POST', '/bookings (malformed key)', await api('POST', '/bookings', { token: lan, key: 'abc', body: bookingBody }), bookingBody);
    capture('bookings.create.unknownField', 'POST', '/bookings (unknown field)', await api('POST', '/bookings', { token: lan, body: { ...bookingBody, status: 'CONFIRMED' } }), { ...bookingBody, status: 'CONFIRMED' });
    capture('bookings.create.noToken', 'POST', '/bookings (no token)', await api('POST', '/bookings', { body: bookingBody }), bookingBody);
    capture('bookings.create.full', 'POST', '/bookings (full slot)', await api('POST', '/bookings', { token: seed.tokens.nam, body: { petId: seed.pets.lu, slotId: seed.slots[`groom@${seed.days.pawSpa[0]}T13:30`] } }), { petId: seed.pets.lu, slotId: '<groom slot, capacity 1, taken>' });

    // ------------------------------------------------------------ provider confirmation
    const staffLogin = await api('POST', '/auth/login', { body: { email: seed.accounts.ha.email, password: DEMO_PASSWORD } });
    const ha = staffLogin.body.accessToken;
    const providerList = capture('bookings.provider.list', 'GET', '/bookings/provider', await api('GET', '/bookings/provider', { token: ha }));
    check('staff sees the new booking in the provider list (provider projection)', providerList.status === 200 && providerList.body.some((b) => b.id === bookingId) && providerList.body.every((b) => same(shape(b), PROVIDER_VIEW)), providerList.status);
    check('customer cannot confirm (403); another provider gets 404', (await api('POST', `/bookings/provider/${bookingId}/confirm`, { token: lan })).status === 403 && capture('bookings.provider.confirm.otherProvider', 'POST', '/bookings/provider/:id/confirm (other provider)', await api('POST', `/bookings/provider/${bookingId}/confirm`, { token: seed.tokens.bao })).status === 404);
    const confirm = capture('bookings.provider.confirm', 'POST', '/bookings/provider/:id/confirm', await api('POST', `/bookings/provider/${bookingId}/confirm`, { token: ha }));
    check('staff confirms -> 201 CONFIRMED (provider projection, customer name only)', confirm.status === 201 && confirm.body.status === 'CONFIRMED' && same(shape(confirm.body), PROVIDER_VIEW) && forbiddenIn(confirm.body, CONTACT).length === 0, confirm);
    capture('bookings.provider.confirm.again', 'POST', '/bookings/provider/:id/confirm (again)', await api('POST', `/bookings/provider/${bookingId}/confirm`, { token: ha }));
    capture('bookings.provider.detail', 'GET', '/bookings/provider/:id', await api('GET', `/bookings/provider/${bookingId}`, { token: seed.tokens.khoa }));

    // ------------------------------------------------------------ booking detail
    const mine = capture('bookings.mine.detail', 'GET', '/bookings/mine/:id', await api('GET', `/bookings/mine/${bookingId}`, { token: lan }));
    check('customer booking detail -> CONFIRMED with 2-step history (customer projection + statusLogs)', mine.status === 200 && mine.body.status === 'CONFIRMED' && same(mine.body.statusLogs.map((l) => l.newStatus), ['PENDING_CONFIRMATION', 'CONFIRMED']) && same(shape(mine.body), [...CUSTOMER_VIEW, ...LOGS].sort()), mine.body);
    capture('bookings.mine.list', 'GET', '/bookings/mine', await api('GET', '/bookings/mine', { token: lan }));
    check("another customer reading this booking -> 404", capture('bookings.mine.detail.otherCustomer', 'GET', '/bookings/mine/:id (other customer)', await api('GET', `/bookings/mine/${bookingId}`, { token: seed.tokens.nam })).status === 404);
    check('no token -> 401; provider route as customer -> 403', (await api('GET', '/bookings/mine')).status === 401 && capture('bookings.provider.list.asCustomer', 'GET', '/bookings/provider (customer token)', await api('GET', '/bookings/provider', { token: lan })).status === 403);

    // Remaining contract examples used by the documentation.
    capture('bookings.mine.cancel', 'POST', '/bookings/mine/:id/cancel', await api('POST', `/bookings/mine/${seed.bookings.pending}/cancel`, { token: lan, body: { reason: 'Đổi lịch khác.' } }), { reason: 'Đổi lịch khác.' });
    capture('bookings.mine.cancel.again', 'POST', '/bookings/mine/:id/cancel (again)', await api('POST', `/bookings/mine/${seed.bookings.pending}/cancel`, { token: lan, body: {} }), {});
    const dashboardUrl = `/dashboard/provider?from=${vnDate(-7)}&to=${vnDate(14)}`;
    const dashboard = capture('dashboard.provider', 'GET', '/dashboard/provider?from&to', await api('GET', dashboardUrl, { token: seed.tokens.khoa }));
    check('owner dashboard -> 200 for a from/to period; staff -> 403 (owner-only)', dashboard.status === 200 && dashboard.body.period.from === vnDate(-7) && (await api('GET', dashboardUrl, { token: ha })).status === 403, dashboard.body);
    capture('dashboard.provider.missingRange', 'GET', '/dashboard/provider (no from/to)', await api('GET', '/dashboard/provider', { token: seed.tokens.khoa }));
    capture('reviews.mine', 'GET', '/reviews/mine', await api('GET', '/reviews/mine', { token: seed.tokens.nam }));
    capture('complaints.mine', 'GET', '/complaints/mine', await api('GET', '/complaints/mine', { token: lan }));
    capture('payments.provider.booking', 'GET', '/payments/provider/booking/:id', await api('GET', `/payments/provider/booking/${seed.bookings.completed}`, { token: seed.tokens.khoa }));
    capture('payments.provider.list', 'GET', '/payments/provider', await api('GET', '/payments/provider', { token: seed.tokens.khoa }));
    capture('availability.mine', 'GET', '/availability/mine', await api('GET', '/availability/mine', { token: seed.tokens.bao }));
    capture('services.mine', 'GET', '/services/mine', await api('GET', '/services/mine', { token: seed.tokens.bao }));
    capture('providers.me', 'GET', '/providers/me', await api('GET', '/providers/me', { token: seed.tokens.bao }));
    capture('providers.workingHours', 'GET', '/providers/working-hours', await api('GET', '/providers/working-hours', { token: seed.tokens.bao }));

    // ------------------------------------------------------------ CORS for the frontend origin
    const preflight = await fetch(`http://localhost:${PORTS[0]}/api/bookings`, { method: 'OPTIONS', headers: { Origin: FRONTEND_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
    const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    check(`CORS preflight from ${FRONTEND_ORIGIN} allows Authorization, Content-Type and Idempotency-Key`, preflight.status < 300 && preflight.headers.get('access-control-allow-origin') === FRONTEND_ORIGIN && ['authorization', 'content-type', 'idempotency-key'].every((h) => allowHeaders.includes(h)), { status: preflight.status, origin: preflight.headers.get('access-control-allow-origin'), allowHeaders });
    const corsGet = await fetch(`http://localhost:${PORTS[0]}/api/providers/public/${seed.providers.pawSpa}`, { headers: { Origin: FRONTEND_ORIGIN } });
    check('CORS exposes Idempotent-Replayed and allows credentials', /idempotent-replayed/i.test(corsGet.headers.get('access-control-expose-headers') ?? '') && corsGet.headers.get('access-control-allow-credentials') === 'true');
    const otherOrigin = await fetch(`http://localhost:${PORTS[0]}/api/providers/public/${seed.providers.pawSpa}`, { headers: { Origin: 'http://evil.example' } });
    check('CORS does not allow an unknown origin', otherOrigin.headers.get('access-control-allow-origin') !== 'http://evil.example');

    const inv = await bookingInvariants(db, Object.values(seed.providers));
    check('database invariants (capacity, logs, keys, working hours, ratings, deadlocks) all 0', Object.values(inv).every((v) => v === 0), inv);
    fs.writeFileSync(path.join(OUT_DIR, 'fe-contract-examples.json'), JSON.stringify(examples, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'swagger.json'), JSON.stringify((await api('GET', '/docs-json')).body, null, 2));
  } finally {
    await app.stop();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }
}

main()
  .catch((error) => check('smoke completed without errors', false, error.stack))
  .finally(() => {
    const failed = results.filter((r) => !r.pass).length;
    fs.writeFileSync(path.join(OUT_DIR, 'fe-smoke-results.json'), JSON.stringify(results, null, 2));
    console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed}  FAIL ${failed}  SKIPPED 0`);
    console.log(`Output: ${OUT_DIR}`);
    process.exitCode = failed ? 1 : 0;
  });
