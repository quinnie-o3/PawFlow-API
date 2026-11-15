import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { compareSchema, expectedMigrationNames, SchemaStatusService } from './schema-status.service';

const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
const EXPECTED = expectedMigrationNames(join(__dirname, '..', 'database', 'migrations'));

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('schema status (P3-BE11)', () => {
  it('derives the 17 migration names of this build from the migration files', () => {
    expect(EXPECTED).toHaveLength(17);
    expect(EXPECTED).toContain('AddReviewResponseConstraints1797500000000');
    expect(EXPECTED).toContain('CreateNotificationPreferences1797000000000');
    expect(EXPECTED).toContain('CreateUsers1789872733739');
  });

  it('compares applied and expected migrations', () => {
    expect(compareSchema(['A1', 'B2'], ['A1', 'B2'])).toEqual({ status: 'current', pending: 0, unknown: 0 });
    expect(compareSchema(['A1', 'B2'], ['A1'])).toEqual({ status: 'pending', pending: 1, unknown: 0 });
    expect(compareSchema(['A1'], ['A1', 'Z9'])).toEqual({ status: 'ahead', pending: 0, unknown: 1 });
  });

  const service = (applied: string[] | Error, env: Record<string, string>) =>
    new SchemaStatusService(
      { query: () => (applied instanceof Error ? Promise.reject(applied) : Promise.resolve(applied.map((name) => ({ name })))) } as unknown as DataSource,
      config(env),
    );

  it('current schema: starts in every environment', async () => {
    const s = service(EXPECTED, { NODE_ENV: 'production' });
    await expect(s.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(s.status).toBe('current');
  });

  it.each([
    ['pending migration', EXPECTED.slice(0, 16), 'pending'],
    ['unknown migration (database newer than the build)', [...EXPECTED, 'Future1899999999999'], 'not in this build'],
    ['unreadable migration table', new Error('relation "migrations" does not exist'), 'unreadable'],
  ])('%s: staging/production refuse to start (enforce by default)', async (_name, applied, message) => {
    for (const env of ['staging', 'production']) {
      await expect(service(applied, { NODE_ENV: env }).onApplicationBootstrap()).rejects.toThrow(message);
    }
  });

  it('development/test only warn (MIGRATIONS_CHECK=off by default); enforce can be requested anywhere', async () => {
    const dev = service(EXPECTED.slice(0, 15), { NODE_ENV: 'development' });
    await expect(dev.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(dev.status).toBe('pending');
    await expect(service(EXPECTED.slice(0, 15), { NODE_ENV: 'test', MIGRATIONS_CHECK: 'enforce' }).onApplicationBootstrap()).rejects.toThrow('MIGRATIONS_CHECK=enforce');
    await expect(service(EXPECTED.slice(0, 15), { NODE_ENV: 'staging', MIGRATIONS_CHECK: 'off' }).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
