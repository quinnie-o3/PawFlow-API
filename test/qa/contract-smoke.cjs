/*
 * P3-BE12 contract smoke: runtime HTTP behaviour vs the frozen OpenAPI
 * contract (docs/api/openapi.json), on a disposable QA database.
 *
 *   npm run build
 *   npm run qa:contract-smoke
 *
 * 1. Seeds the demo dataset through the API (demo-seed.cjs), then exercises
 *    the happy path of every route that no other functional suite calls
 *    (Phase 2 CRUD: admin master data, admin users/statistics, provider
 *    profile/staff/working hours, services, slots, pets, complaints).
 * 2. Error paths: unknown IDs (404), malformed IDs (400), missing token
 *    (401), wrong role (403), duplicate/invalid state (409).
 * 3. Every request made by this suite (seed included) is matched to its
 *    route template; each observed status must be documented for that
 *    operation in the OpenAPI document, and every listed route must have
 *    been called at least once with a 2xx result.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_contract_smoke), QA_PORTS
 * (default 8401), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, vnDate, dayOfWeek, prepareDatabase, dropDatabase, createApp, createApi } = require('./qa-env.cjs');
const { routeInventory } = require('./route-inventory.cjs');
const { seedDemoData } = require('./demo-seed.cjs');

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_contract_smoke';
const PORT = Number((process.env.QA_PORTS ?? '8401').split(',')[0]);
const OUT = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-contract-smoke-'));
const OPENAPI = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'api', 'openapi.json'), 'utf8'));

/** Routes without a dedicated functional suite before BE12 (see p3-be12-fe-be-traceability.md). */
const TARGETS = [
  'GET /admin/complaints', 'GET /admin/complaints/:id', 'GET /admin/pet-types', 'GET /admin/pet-types/:id', 'PATCH /admin/pet-types/:id',
  'PATCH /admin/pet-types/:id/activate', 'PATCH /admin/pet-types/:id/deactivate', 'GET /admin/providers/:id', 'PATCH /admin/providers/:id/reject',
  'GET /admin/service-categories', 'GET /admin/service-categories/:id', 'PATCH /admin/service-categories/:id',
  'PATCH /admin/service-categories/:id/activate', 'PATCH /admin/service-categories/:id/deactivate', 'GET /admin/statistics', 'GET /admin/users',
  'GET /admin/users/:id', 'DELETE /availability/mine/:id', 'GET /availability/mine/:id', 'PATCH /availability/mine/:id', 'GET /availability/public',
  'GET /complaints/mine/:id', 'DELETE /pets/:id', 'GET /pets/:id', 'PATCH /pets/:id', 'PATCH /providers/me', 'GET /providers/staff',
  'GET /providers/staff/:id', 'DELETE /providers/working-hours/:id', 'DELETE /services/mine/:id', 'GET /services/mine/:id', 'PATCH /services/mine/:id',
];

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

const routes = routeInventory().map((r) => {
  const params = (r.path.match(/:/g) ?? []).length;
  return { ...r, key: `${r.method} ${r.path}`, params, re: new RegExp(`^${r.path.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`) };
});
function routeOf(method, url) {
  const p = url.split('?')[0].replace(/\/$/, '') || '/';
  return routes.filter((r) => r.method === method && r.re.test(p)).sort((a, b) => a.params - b.params)[0];
}
const documentedCodes = (route) => Object.keys(OPENAPI.paths[`/api${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`.replace(/\/$/, '')]?.[route.method.toLowerCase()]?.responses ?? {});

const observed = []; // { key, status }
function recordingApi(api) {
  return async (method, url, options) => {
    const res = await api(method, url, options);
    const route = routeOf(method, url);
    observed.push({ key: route ? route.key : `UNMATCHED ${method} ${url}`, status: res.status, route });
    return res;
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { db, migrations, pendingDdl } = await prepareDatabase(NAME);
  check(`setup: QA database migrated (${migrations.length}, no pending DDL)`, migrations.length === 17 && pendingDdl.length === 0);
  const app = createApp(NAME, [PORT], { logDir: OUT });
  await app.start();
  try {
    const api = recordingApi(createApi([PORT]));
    const seed = await seedDemoData({ api, db });
    const T = seed.tokens;
    const ok = (res, status, label) => check(label, res.status === status, `status ${res.status}${res.status >= 400 ? ` ${JSON.stringify(res.body).slice(0, 160)}` : ''}`);

    // Admin master data.
    const petType = Object.values(seed.petTypes)[0];
    ok(await api('GET', '/admin/pet-types', { token: T.admin }), 200, 'admin lists pet types');
    ok(await api('GET', `/admin/pet-types/${petType}`, { token: T.admin }), 200, 'admin reads a pet type');
    const extraType = await api('POST', '/admin/pet-types', { token: T.admin, body: { name: 'Thỏ' } });
    ok(await api('PATCH', `/admin/pet-types/${extraType.body.id}`, { token: T.admin, body: { name: 'Thỏ cảnh' } }), 200, 'admin renames a pet type');
    ok(await api('PATCH', `/admin/pet-types/${extraType.body.id}/deactivate`, { token: T.admin }), 200, 'admin deactivates a pet type');
    ok(await api('PATCH', `/admin/pet-types/${extraType.body.id}/deactivate`, { token: T.admin }), 409, 'deactivating twice is a 409 conflict');
    ok(await api('PATCH', `/admin/pet-types/${extraType.body.id}/activate`, { token: T.admin }), 200, 'admin reactivates a pet type');
    const category = Object.values(seed.categories)[0];
    ok(await api('GET', '/admin/service-categories', { token: T.admin }), 200, 'admin lists service categories');
    ok(await api('GET', `/admin/service-categories/${category}`, { token: T.admin }), 200, 'admin reads a service category');
    const extraCat = await api('POST', '/admin/service-categories', { token: T.admin, body: { name: 'Huấn luyện' } });
    ok(await api('PATCH', `/admin/service-categories/${extraCat.body.id}`, { token: T.admin, body: { description: 'Huấn luyện cơ bản' } }), 200, 'admin updates a service category');
    ok(await api('PATCH', `/admin/service-categories/${extraCat.body.id}/deactivate`, { token: T.admin }), 200, 'admin deactivates a service category');
    ok(await api('PATCH', `/admin/service-categories/${extraCat.body.id}/activate`, { token: T.admin }), 200, 'admin reactivates a service category');

    // Admin users, statistics, providers, complaints.
    ok(await api('GET', '/admin/users?role=CUSTOMER', { token: T.admin }), 200, 'admin lists users (filtered)');
    ok(await api('GET', `/admin/users/${seed.accounts.lan.userId}`, { token: T.admin }), 200, 'admin reads a user');
    ok(await api('GET', '/admin/statistics', { token: T.admin }), 200, 'admin reads platform statistics');
    ok(await api('GET', `/admin/providers/${seed.providers.pawSpa}`, { token: T.admin }), 200, 'admin reads a provider');
    const applicant = await api('POST', '/auth/register', { body: { fullName: 'Ứng viên Từ chối', email: 'reject.owner@pawflow.test', password: 'PawFlow@2026' } });
    const application = await api('POST', '/providers', { token: applicant.body.accessToken, body: { businessName: 'Tiệm Thử Nghiệm', address: '1 Đường Thử, Quận 3' } });
    ok(await api('PATCH', `/admin/providers/${application.body.id}/reject`, { token: T.admin }), 200, 'admin rejects a pending provider application');
    ok(await api('GET', '/admin/complaints', { token: T.admin }), 200, 'admin lists complaints');
    ok(await api('GET', `/admin/complaints/${seed.complaintId}`, { token: T.admin }), 200, 'admin reads a complaint');
    ok(await api('GET', `/complaints/mine/${seed.complaintId}`, { token: T.lan }), 200, 'customer reads own complaint');

    // Provider owner: profile, staff, working hours, services, slots.
    ok(await api('PATCH', '/providers/me', { token: T.khoa, body: { description: 'Spa thú cưng (cập nhật hồ sơ).' } }), 200, 'owner updates the provider profile');
    const staff = await api('GET', '/providers/staff', { token: T.khoa });
    ok(staff, 200, 'owner lists staff');
    const staffId = (Array.isArray(staff.body) ? staff.body : staff.body?.items ?? [])[0]?.id;
    ok(await api('GET', `/providers/staff/${staffId}`, { token: T.khoa }), 200, 'owner reads a staff member');
    const sunday = await api('POST', '/providers/working-hours', { token: T.khoa, body: { dayOfWeek: 0, startTime: '08:00', endTime: '09:00' } });
    ok(sunday, 201, 'owner adds Sunday working hours');
    ok(await api('DELETE', `/providers/working-hours/${sunday.body.id}`, { token: T.khoa }), 204, 'owner deletes working hours');
    const service = await api('POST', '/services', { token: T.khoa, body: { categoryId: category, name: 'Dịch vụ tạm', price: 100000, durationMinutes: 60 } });
    ok(await api('GET', `/services/mine/${service.body.id}`, { token: T.khoa }), 200, 'owner reads own service');
    ok(await api('PATCH', `/services/mine/${service.body.id}`, { token: T.khoa, body: { price: 120000 } }), 200, 'owner updates own service');
    let day = null;
    for (let offset = 2; offset < 20 && !day; offset++) if ([1, 2, 3, 4, 5, 6].includes(dayOfWeek(vnDate(offset)))) day = vnDate(offset);
    const slot = await api('POST', '/availability', { token: T.khoa, body: { serviceId: String(service.body.id), slotDate: day, startTime: '16:00', endTime: '17:00', capacity: 1 } });
    ok(slot, 201, 'owner opens a slot for the new service');
    ok(await api('GET', `/availability/mine/${slot.body.id}`, { token: T.khoa }), 200, 'owner reads own slot');
    ok(await api('PATCH', `/availability/mine/${slot.body.id}`, { token: T.khoa, body: { capacity: 2 } }), 200, 'owner updates slot capacity');
    ok(await api('DELETE', `/availability/mine/${slot.body.id}`, { token: T.khoa }), 204, 'owner deletes an unbooked slot');
    ok(await api('DELETE', `/services/mine/${service.body.id}`, { token: T.khoa }), 204, 'owner deletes own service');
    ok(await api('GET', '/availability/public'), 200, 'public slot list');

    // Customer pets.
    const pet = seed.pets.mochi;
    ok(await api('GET', `/pets/${pet}`, { token: T.lan }), 200, 'customer reads own pet');
    ok(await api('PATCH', `/pets/${pet}`, { token: T.lan, body: { weight: 4.7 } }), 200, 'customer updates own pet');
    const temp = await api('POST', '/pets', { token: T.lan, body: { petTypeId: petType, name: 'Tạm' } });
    ok(await api('DELETE', `/pets/${temp.body.id}`, { token: T.lan }), 204, 'customer deletes a pet without bookings');

    // Error paths (statuses must be documented).
    ok(await api('GET', '/pets/999999999', { token: T.lan }), 404, 'unknown pet -> 404');
    ok(await api('GET', `/pets/${pet}`, { token: T.nam }), 404, "another customer's pet -> 404 (not revealed)");
    ok(await api('GET', '/pets/abc', { token: T.lan }), 400, 'malformed ID -> 400');
    ok(await api('GET', '/admin/users/999999999', { token: T.admin }), 404, 'unknown user -> 404');
    ok(await api('GET', '/admin/statistics'), 401, 'no token -> 401');
    ok(await api('GET', '/admin/statistics', { token: T.lan }), 403, 'customer on an admin route -> 403');
    ok(await api('GET', '/providers/staff', { token: T.lan }), 403, 'customer on an owner route -> 403');
    ok(await api('POST', '/admin/pet-types', { token: T.admin, body: { name: 'Chó' } }), 409, 'duplicate pet type -> 409');
    ok(await api('PATCH', `/pets/${pet}`, { token: T.lan, body: { unknownField: 1 } }), 400, 'unknown body field -> 400');

    // Contract comparison.
    const unmatched = observed.filter((o) => !o.route).map((o) => o.key);
    check(`every request maps to a runtime route (${observed.length} requests)`, unmatched.length === 0, unmatched.slice(0, 5).join('; '));
    const undocumented = [...new Set(observed.filter((o) => o.route && !documentedCodes(o.route).includes(String(o.status))).map((o) => `${o.key} -> ${o.status}`))];
    check(`every observed status is documented in OpenAPI for its operation (${new Set(observed.map((o) => o.key)).size} operations)`, undocumented.length === 0, undocumented.join('; '));
    const succeeded = new Set(observed.filter((o) => o.status < 300).map((o) => o.key));
    const notCalled = TARGETS.filter((t) => !succeeded.has(t));
    check(`every previously uncovered route (${TARGETS.length}) succeeded at least once`, notCalled.length === 0, notCalled.join('; '));
    fs.writeFileSync(path.join(OUT, 'observed-statuses.json'), JSON.stringify(
      Object.fromEntries([...new Set(observed.map((o) => o.key))].sort().map((k) => [k, [...new Set(observed.filter((o) => o.key === k).map((o) => o.status))].sort()])), null, 2));
  } finally {
    await app.stop();
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }
  console.log(`\ncontract-smoke: ${passed} PASS, ${failed} FAIL`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FAIL contract-smoke crashed: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
