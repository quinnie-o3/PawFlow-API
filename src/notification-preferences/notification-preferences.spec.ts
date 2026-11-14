import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { UpdateNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';

const cfg = (v: Record<string, string | undefined>) => ({ get: (k: string) => v[k] }) as unknown as ConfigService;
const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateNotificationPreferencesDto });

/** Minimal DataSource fake: one row per user, the two write statements and the read. */
function fakeDb() {
  const rows = new Map<string, { push_enabled: boolean; push_enabled_at: Date | null; updated_at: Date }>();
  const sql: string[] = [];
  let clock = 1_800_000_000_000;
  const query = jest.fn((text: string, params: [string]) => {
    sql.push(text.replace(/\s+/g, ' ').trim());
    const [userId] = params;
    const row = rows.get(userId);
    if (text.trim().startsWith('SELECT')) return Promise.resolve(row ? [{ ...row }] : []);
    const now = new Date(clock++);
    if (text.includes('INSERT')) {
      if (!row) {
        rows.set(userId, { push_enabled: true, push_enabled_at: now, updated_at: now });
        return Promise.resolve([{ user_id: userId }]);
      }
      if (!row.push_enabled) {
        Object.assign(row, { push_enabled: true, push_enabled_at: now, updated_at: now });
        return Promise.resolve([{ user_id: userId }]);
      }
      return Promise.resolve([]);
    }
    if (row?.push_enabled) {
      Object.assign(row, { push_enabled: false, push_enabled_at: null, updated_at: now });
      return Promise.resolve([[{ user_id: userId }], 1]);
    }
    return Promise.resolve([[], 0]);
  });
  return { ds: { query } as unknown as DataSource, rows, sql, query };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  }
});
afterEach(() => jest.restoreAllMocks());

describe('UpdateNotificationPreferencesDto (global ValidationPipe options)', () => {
  it('accepts JSON booleans', async () => {
    await expect(validate({ pushEnabled: true })).resolves.toEqual({ pushEnabled: true });
    await expect(validate({ pushEnabled: false })).resolves.toEqual({ pushEnabled: false });
  });

  it.each([
    ['8. missing field', {}],
    ['null', { pushEnabled: null }],
    ['9. string "true"', { pushEnabled: 'true' }],
    ['9. string "false"', { pushEnabled: 'false' }],
    ['10. number 1', { pushEnabled: 1 }],
    ['10. number 0', { pushEnabled: 0 }],
    ['11. userId injection', { pushEnabled: true, userId: '1' }],
    ['role injection', { pushEnabled: true, role: 'ADMIN' }],
    ['pushEnabledAt injection', { pushEnabled: true, pushEnabledAt: '2020-01-01T00:00:00Z' }],
  ])('%s -> 400', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('pushAvailable (trusted backend configuration only)', () => {
  it.each([
    [{}, false],
    [{ PUSH_DELIVERY_MODE: 'disabled' }, false],
    [{ PUSH_DELIVERY_MODE: 'mock' }, false],
    [{ PUSH_DELIVERY_MODE: 'mock', PUSH_WORKER_ENABLED: 'true' }, false],
    [{ PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-dev' }, false],
    [{ PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-dev', PUSH_WORKER_ENABLED: 'false' }, false],
    [{ PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-dev', PUSH_WORKER_ENABLED: 'true' }, true],
  ])('21. %j -> %s', (env, expected) => {
    expect(new NotificationPreferencesService(fakeDb().ds, cfg(env)).pushAvailable).toBe(expected);
  });
});

describe('NotificationPreferencesService', () => {
  it('1 + 2. no row -> OFF defaults; reading issues only a SELECT', async () => {
    const db = fakeDb();
    const svc = new NotificationPreferencesService(db.ds, cfg({}));
    await expect(svc.getForUser('7')).resolves.toEqual({ pushEnabled: false, pushEnabledAt: null, updatedAt: null });
    expect(db.sql.every((s) => s.startsWith('SELECT'))).toBe(true);
    expect(db.rows.size).toBe(0);
  });

  it('3 + 5 + 4 + 6 + 7. state machine and consent epoch', async () => {
    const db = fakeDb();
    const svc = new NotificationPreferencesService(db.ds, cfg({}));
    const on1 = await svc.updateForUser('7', true);
    expect(on1).toMatchObject({ pushEnabled: true });
    expect(on1.pushEnabledAt).toBeInstanceOf(Date);
    const on2 = await svc.updateForUser('7', true);
    expect(on2).toEqual(on1); // repeated enable: timestamp and updatedAt preserved
    const off1 = await svc.updateForUser('7', false);
    expect(off1).toMatchObject({ pushEnabled: false, pushEnabledAt: null });
    expect(off1.updatedAt!.getTime()).toBeGreaterThan(on1.updatedAt!.getTime());
    const off2 = await svc.updateForUser('7', false);
    expect(off2).toEqual(off1); // repeated disable: nothing changes
    const on3 = await svc.updateForUser('7', true);
    expect(on3.pushEnabledAt!.getTime()).toBeGreaterThan(on1.pushEnabledAt!.getTime()); // new opt-in period
  });

  it('disabling a missing row writes nothing and stays at the defaults', async () => {
    const db = fakeDb();
    const svc = new NotificationPreferencesService(db.ds, cfg({}));
    await expect(svc.updateForUser('9', false)).resolves.toEqual({ pushEnabled: false, pushEnabledAt: null, updatedAt: null });
    expect(db.rows.size).toBe(0);
  });

  it('writes are single conditional statements using PostgreSQL now(), never an app timestamp', async () => {
    const db = fakeDb();
    const svc = new NotificationPreferencesService(db.ds, cfg({}));
    await svc.updateForUser('7', true);
    await svc.updateForUser('7', false);
    const writes = db.sql.filter((s) => !s.startsWith('SELECT'));
    expect(writes[0]).toMatch(/ON CONFLICT \(user_id\) DO UPDATE SET push_enabled = true, push_enabled_at = now\(\), updated_at = now\(\) WHERE NOT p\.push_enabled/);
    expect(writes[1]).toMatch(/SET push_enabled = false, push_enabled_at = NULL, updated_at = now\(\) WHERE user_id = \$1 AND push_enabled/);
    for (const call of db.query.mock.calls) expect(call[1]).toEqual(['7']); // only the user id is a parameter
  });

  it('getPushConsentForDelivery exposes opt-in state and the current period start', async () => {
    const db = fakeDb();
    const svc = new NotificationPreferencesService(db.ds, cfg({}));
    await expect(svc.getPushConsentForDelivery('7')).resolves.toEqual({ optedIn: false, optedInSince: null });
    const on = await svc.updateForUser('7', true);
    await expect(svc.getPushConsentForDelivery('7')).resolves.toEqual({ optedIn: true, optedInSince: on.pushEnabledAt });
  });

  it('25. logs only the user id and the new state', async () => {
    const svc = new NotificationPreferencesService(fakeDb().ds, cfg({}));
    await svc.updateForUser('7', true);
    await svc.updateForUser('7', true);
    expect(logged.filter((l) => l.includes('Push preference'))).toEqual(['Push preference of user 7 -> ON']);
  });
});

describe('NotificationPreferencesController', () => {
  it('uses the authenticated user id and maps to the public view (ISO strings, pushAvailable)', async () => {
    const db = fakeDb();
    const svc = new NotificationPreferencesService(db.ds, cfg({}));
    const ctrl = new NotificationPreferencesController(svc);
    const user = { id: '42', role: 'CUSTOMER', sessionId: 's' } as never;
    await expect(ctrl.get(user)).resolves.toEqual({ pushEnabled: false, pushEnabledAt: null, pushAvailable: false, updatedAt: null });
    const on = await ctrl.update(user, { pushEnabled: true });
    expect(on.pushEnabled).toBe(true);
    expect(on.pushEnabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(on.updatedAt).toBe(on.pushEnabledAt);
    expect(Object.keys(on).sort()).toEqual(['pushAvailable', 'pushEnabled', 'pushEnabledAt', 'updatedAt']);
    expect([...db.rows.keys()]).toEqual(['42']);
  });
});
