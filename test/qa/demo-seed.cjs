/*
 * PawFlow MVP demo dataset for frontend integration (disposable QA database only).
 *
 *   npm run build
 *   npm run qa:demo-seed                       # seed, print accounts, stop the app
 *   QA_DEMO_SERVE=1 npm run qa:demo-seed       # seed and keep the API running for the FE
 *
 * Then point the frontend at it: NEXT_PUBLIC_API_URL=http://localhost:8100/api
 *
 * Every record is created through the public API, so all business rules apply
 * (working hours, slot duration, lifecycle transitions...). The only direct
 * SQL is the ADMIN account, because the API has no way to create one.
 * The database is dropped and recreated on every run, and the calls are made
 * sequentially in a fixed order, so names, IDs and statuses are identical
 * between runs (dates are relative to today, in Asia/Ho_Chi_Minh).
 * All people, phone numbers and addresses are fictional.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_demo), QA_PORTS (default 8100),
 * QA_OUT_DIR, QA_DEMO_SERVE=1, QA_DB_HOST/PORT/USERNAME/PASSWORD (default: .env).
 * The development database is never touched.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, vnDate, dayOfWeek, sourceMigrationCount, prepareDatabase, createApp, createApi, bookingInvariants } = require('./qa-env.cjs');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));

const DEMO_PASSWORD = 'PawFlow@2026';
const DOMAIN = 'pawflow.test';

const PEOPLE = {
  admin: { fullName: 'Quản trị viên PawFlow', email: `admin@${DOMAIN}` },
  khoa: { fullName: 'Trần Minh Khoa', email: `khoa.owner@${DOMAIN}`, phone: '0900000101' },
  ha: { fullName: 'Lê Thu Hà', email: `ha.staff@${DOMAIN}`, phone: '0900000102' },
  bao: { fullName: 'Phạm Quốc Bảo', email: `bao.owner@${DOMAIN}`, phone: '0900000201' },
  vy: { fullName: 'Đỗ Tường Vy', email: `vy.owner@${DOMAIN}`, phone: '0900000301' },
  lan: { fullName: 'Nguyễn Thị Lan', email: `lan.customer@${DOMAIN}`, phone: '0900000401' },
  nam: { fullName: 'Võ Hoàng Nam', email: `nam.customer@${DOMAIN}`, phone: '0900000402' },
};

/** Throws with the response body when the status is not the expected one. */
async function expect(promise, status, label) {
  const res = await promise;
  if (res.status !== status) throw new Error(`${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Next `count` dates from today+2 whose weekday is in `weekdays`. */
function upcomingDays(count, weekdays) {
  const days = [];
  for (let offset = 2; days.length < count; offset++) {
    const day = vnDate(offset);
    if (weekdays.includes(dayOfWeek(day))) days.push(day);
  }
  return days;
}

/**
 * Seeds the demo dataset through the API. `db` must be a client connected to
 * the verified QA database (used only to create the ADMIN account).
 */
async function seedDemoData({ api, db }) {
  const tokens = {};
  const ids = {};
  const register = async (key) => {
    const body = await expect(api('POST', '/auth/register', { body: { ...PEOPLE[key], password: DEMO_PASSWORD } }), 201, `register ${key}`);
    ids[key] = String(body.user.id);
    tokens[key] = body.accessToken;
  };
  const login = async (key) => {
    tokens[key] = (await expect(api('POST', '/auth/login', { body: { email: PEOPLE[key].email, password: DEMO_PASSWORD } }), 200, `login ${key}`)).accessToken;
  };

  // Admin (no API exists to create one).
  await db.query(`insert into users(full_name, email, password_hash, role, status) values ($1, $2, $3, 'ADMIN', 'ACTIVE')`, [PEOPLE.admin.fullName, PEOPLE.admin.email, await bcrypt.hash(DEMO_PASSWORD, 10)]);
  await login('admin');
  const A = tokens.admin;

  // Master data.
  const petTypes = {};
  for (const name of ['Chó', 'Mèo']) petTypes[name] = String((await expect(api('POST', '/admin/pet-types', { token: A, body: { name } }), 201, 'pet type')).id);
  const categories = {};
  for (const name of ['Tắm & vệ sinh', 'Cắt tỉa lông', 'Khám sức khỏe']) categories[name] = String((await expect(api('POST', '/admin/service-categories', { token: A, body: { name } }), 201, 'category')).id);

  // Providers.
  for (const key of ['khoa', 'bao', 'vy', 'ha', 'lan', 'nam']) await register(key);
  const providers = {};
  const createProvider = async (owner, body, decision) => {
    const p = await expect(api('POST', '/providers', { token: tokens[owner], body }), 201, `provider ${owner}`);
    if (decision) await expect(api('PATCH', `/admin/providers/${p.id}/${decision}`, { token: A }), 200, `${decision} ${owner}`);
    return String(p.id);
  };
  providers.pawSpa = await createProvider('khoa', { businessName: 'Paw Spa Sài Gòn', address: '123 Nguyễn Thị Minh Khai, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh', phone: '0280000101', description: 'Spa thú cưng: tắm sấy, cắt tỉa lông và chăm sóc móng cho chó mèo.' }, 'approve');
  providers.happyPaws = await createProvider('bao', { businessName: 'Happy Paws Thủ Đức', address: '45 Võ Văn Ngân, Phường Linh Chiểu, TP. Thủ Đức, TP. Hồ Chí Minh', phone: '0280000201', description: 'Chăm sóc chó lớn và khám sức khỏe định kỳ.' }, 'approve');
  providers.meoXinh = await createProvider('vy', { businessName: 'Mèo Xinh Bình Thạnh', address: '8 Phan Văn Trị, Phường 7, Quận Bình Thạnh, TP. Hồ Chí Minh', description: 'Hồ sơ đang chờ duyệt (không hiển thị công khai).' }, null);

  // Active staff of Paw Spa (role becomes PROVIDER_STAFF; token is re-issued at login).
  await expect(api('POST', '/providers/staff', { token: tokens.khoa, body: { userId: ids.ha, position: 'Kỹ thuật viên chăm sóc' } }), 201, 'staff');
  await login('ha');

  // Working hours: Paw Spa Mon-Sat 08:00-12:00 and 13:00-18:00 (closed Sunday); Happy Paws daily 09:00-17:00.
  for (let dow = 1; dow <= 6; dow++) {
    for (const [startTime, endTime] of [['08:00', '12:00'], ['13:00', '18:00']]) {
      await expect(api('POST', '/providers/working-hours', { token: tokens.khoa, body: { dayOfWeek: dow, startTime, endTime } }), 201, 'hours paw spa');
    }
  }
  for (let dow = 0; dow <= 6; dow++) {
    await expect(api('POST', '/providers/working-hours', { token: tokens.bao, body: { dayOfWeek: dow, startTime: '09:00', endTime: '17:00' } }), 201, 'hours happy paws');
  }

  // Services.
  const services = {};
  const createService = async (owner, key, body) => {
    services[key] = String((await expect(api('POST', '/services', { token: tokens[owner], body }), 201, `service ${key}`)).id);
  };
  await createService('khoa', 'bath', { categoryId: categories['Tắm & vệ sinh'], name: 'Tắm sấy cơ bản', price: 150000, durationMinutes: 60, description: 'Tắm, sấy khô, vệ sinh tai cho chó mèo dưới 10 kg.' });
  await createService('khoa', 'groom', { categoryId: categories['Cắt tỉa lông'], name: 'Cắt tỉa lông tạo kiểu', price: 350000, durationMinutes: 90, description: 'Cắt tỉa toàn thân theo kiểu, đã bao gồm tắm.' });
  await createService('khoa', 'combo', { categoryId: categories['Tắm & vệ sinh'], name: 'Combo tắm + cắt móng', price: 220000, durationMinutes: 60, description: 'Tắm sấy kèm cắt và mài móng.' });
  await createService('bao', 'bigDog', { categoryId: categories['Tắm & vệ sinh'], name: 'Tắm chó lớn', price: 250000, durationMinutes: 90, description: 'Dành cho chó trên 15 kg.' });
  await createService('bao', 'checkup', { categoryId: categories['Khám sức khỏe'], name: 'Khám tổng quát', price: 300000, durationMinutes: 30, description: 'Kiểm tra sức khỏe tổng quát và tư vấn dinh dưỡng.' });

  // Slots: Paw Spa on its next 5 working days, Happy Paws on the next 5 days.
  const slots = {};
  const createSlot = async (owner, serviceKey, slotDate, startTime, endTime, capacity) => {
    const slot = await expect(api('POST', '/availability', { token: tokens[owner], body: { serviceId: services[serviceKey], slotDate, startTime, endTime, capacity } }), 201, `slot ${serviceKey} ${slotDate} ${startTime}`);
    slots[`${serviceKey}@${slotDate}T${startTime}`] = String(slot.id);
    return String(slot.id);
  };
  const pawSpaDays = upcomingDays(5, [1, 2, 3, 4, 5, 6]);
  for (const day of pawSpaDays) {
    await createSlot('khoa', 'bath', day, '08:00', '09:00', 2);
    await createSlot('khoa', 'bath', day, '09:00', '10:00', 2);
    await createSlot('khoa', 'bath', day, '10:00', '11:00', 2);
    await createSlot('khoa', 'groom', day, '13:30', '15:00', 1);
    await createSlot('khoa', 'groom', day, '15:00', '16:30', 1);
    await createSlot('khoa', 'combo', day, '16:30', '17:30', 2);
  }
  const happyDays = upcomingDays(5, [0, 1, 2, 3, 4, 5, 6]);
  for (const day of happyDays) {
    await createSlot('bao', 'bigDog', day, '09:00', '10:30', 1);
    await createSlot('bao', 'checkup', day, '14:00', '14:30', 3);
    await createSlot('bao', 'checkup', day, '14:30', '15:00', 3);
  }

  // Customers and pets.
  const pets = {};
  const createPet = async (owner, key, body) => {
    pets[key] = String((await expect(api('POST', '/pets', { token: tokens[owner], body }), 201, `pet ${key}`)).id);
  };
  await createPet('lan', 'mochi', { petTypeId: petTypes['Chó'], name: 'Mochi', breed: 'Poodle', birthDate: '2022-03-15', weight: 4.5, healthNote: 'Da nhạy cảm, dùng sữa tắm không mùi.' });
  await createPet('lan', 'bo', { petTypeId: petTypes['Mèo'], name: 'Bơ', breed: 'Anh lông ngắn', birthDate: '2023-01-10', weight: 3.8 });
  await createPet('nam', 'lu', { petTypeId: petTypes['Chó'], name: 'Lu', breed: 'Corgi', birthDate: '2021-08-02', weight: 11.2 });

  // Booking lifecycle examples (Paw Spa, first two working days; Happy Paws, first day).
  const [day1, day2] = pawSpaDays;
  const bookings = {};
  const book = async (customer, pet, slotKey, extra = {}, key) => {
    const body = await expect(api('POST', '/bookings', { token: tokens[customer], key, body: { petId: pets[pet], slotId: slots[slotKey], ...extra } }), 201, `book ${slotKey}`);
    return String(body.id);
  };
  const act = (actor, id, verb, body) => expect(api('POST', `/bookings/provider/${id}/${verb}`, { token: tokens[actor], body }), 201, `${verb} ${id}`);

  bookings.pending = await book('lan', 'mochi', `bath@${day1}T09:00`, { customerNote: 'Bé hơi nhát, mong nhân viên nhẹ nhàng.' }, 'demo-lan-mochi-bath-0001');
  bookings.confirmed = await book('lan', 'bo', `bath@${day1}T10:00`);
  await act('khoa', bookings.confirmed, 'confirm');
  bookings.completed = await book('nam', 'lu', `groom@${day1}T13:30`, { customerNote: 'Cắt gọn phần lông chân.' });
  await act('khoa', bookings.completed, 'confirm');
  await act('ha', bookings.completed, 'complete');
  bookings.cancelled = await book('nam', 'lu', `combo@${day1}T16:30`);
  await expect(api('POST', `/bookings/mine/${bookings.cancelled}/cancel`, { token: tokens.nam, body: { reason: 'Bận việc đột xuất.' } }), 201, 'cancel');
  bookings.rejected = await book('lan', 'mochi', `bath@${day1}T08:00`);
  await act('ha', bookings.rejected, 'reject', { reason: 'Khung giờ này đã kín nhân viên.' });
  bookings.noShow = await book('nam', 'lu', `bath@${day2}T09:00`);
  await act('khoa', bookings.noShow, 'confirm');
  await act('khoa', bookings.noShow, 'no-show', { reason: 'Khách không đến và không báo trước.' });
  bookings.otherProvider = await book('nam', 'lu', `checkup@${happyDays[0]}T14:00`);

  // Post-booking examples.
  const review = await expect(api('POST', `/bookings/${bookings.completed}/reviews`, { token: tokens.nam, body: { rating: 5, comment: 'Bé Lu được cắt tỉa rất đẹp, nhân viên thân thiện.' } }), 201, 'review');
  const complaint = await expect(api('POST', `/bookings/${bookings.rejected}/complaints`, { token: tokens.lan, body: { reason: 'Lịch bị từ chối sát giờ, mong cửa hàng báo sớm hơn.' } }), 201, 'complaint');
  const payment = await expect(api('PUT', `/payments/provider/booking/${bookings.completed}`, { token: tokens.khoa, body: { paymentStatus: 'PAID', method: 'CASH' } }), 200, 'payment');

  const providerIds = Object.values(providers);
  const invariants = await bookingInvariants(db, providerIds);
  if (!Object.values(invariants).every((v) => v === 0)) throw new Error('demo data invariants failed: ' + JSON.stringify(invariants));

  return {
    password: DEMO_PASSWORD,
    accounts: Object.fromEntries(Object.entries(PEOPLE).map(([key, person]) => [key, { email: person.email, fullName: person.fullName, userId: ids[key] ?? null }])),
    tokens, petTypes, categories, providers, services, slots, pets, bookings,
    reviewId: String(review.id), complaintId: String(complaint.id), paymentId: String(payment.id),
    days: { pawSpa: pawSpaDays, happyPaws: happyDays },
  };
}

/** Stable description of the seeded data (no dates or tokens), used to check determinism. */
function fingerprint(seed) {
  const { tokens: _tokens, days: _days, slots, ...rest } = seed;
  return { ...rest, slotIds: Object.values(slots) };
}

async function main() {
  const name = process.env.QA_DB_NAME ?? 'pawflow_qa_demo';
  const ports = (process.env.QA_PORTS ?? '8100').split(',').map(Number);
  const outDir = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-demo-'));
  const { db, migrations, pendingDdl } = await prepareDatabase(name);
  if (migrations.length !== sourceMigrationCount() || pendingDdl.length !== 0) throw new Error(`unexpected schema state: ${migrations.length} migrations, ${pendingDdl.length} pending DDL`);
  const app = createApp(name, ports, { logDir: outDir });
  await app.start();
  try {
    const seed = await seedDemoData({ api: createApi(ports), db });
    const { tokens: _tokens, ...publicSeed } = seed;
    fs.writeFileSync(path.join(outDir, 'demo-data.json'), JSON.stringify(publicSeed, null, 2));
    fs.writeFileSync(path.join(outDir, 'demo-fingerprint.json'), JSON.stringify(fingerprint(seed), null, 2));
    console.log(`Demo data ready in ${name} (${migrations.length} migrations). Password for every account: ${seed.password}`);
    for (const [key, account] of Object.entries(seed.accounts)) console.log(`  ${key.padEnd(6)} ${account.email.padEnd(26)} ${account.fullName}`);
    console.log(`Bookings: ${JSON.stringify(seed.bookings)}`);
    console.log(`Details: ${path.join(outDir, 'demo-data.json')}`);
    if (process.env.QA_DEMO_SERVE === '1') {
      console.log(`API: http://localhost:${ports[0]}/api  (Swagger: /api/docs). Press Ctrl+C to stop.`);
      await new Promise((resolve) => process.once('SIGINT', resolve));
    }
  } finally {
    await app.stop();
    await db.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { seedDemoData, fingerprint, DEMO_PASSWORD };
