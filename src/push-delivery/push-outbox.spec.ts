import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';

import { DEFAULT_PUSH_DELIVERY_TTL_SECONDS, loadPushDeliveryConfig } from './push-delivery.config';
import { MAX_ENQUEUE_BATCH, OutboxNotificationNotFoundError, OutboxUsageError, PushOutboxService } from './push-outbox.service';

const config = (v: Record<string, string | undefined>) => ({ get: (k: string) => v[k] }) as unknown as ConfigService;

function fakeManager(row: { ok: boolean; missing: string[]; inserted: string[] }, inTransaction = true) {
  const query = jest.fn().mockResolvedValue([row]);
  return { manager: { query, queryRunner: { isTransactionActive: inTransaction } } as unknown as EntityManager, query };
}

describe('loadPushDeliveryConfig', () => {
  it('defaults: disabled (not explicit), 24 h TTL', () => {
    expect(loadPushDeliveryConfig(config({}))).toEqual({ mode: 'disabled', modeExplicit: false, ttlSeconds: DEFAULT_PUSH_DELIVERY_TTL_SECONDS, firebaseProjectId: null, sendTimeoutMs: 10_000 });
  });

  it('accepts the three modes (case-insensitive) and a TTL in range', () => {
    expect(loadPushDeliveryConfig(config({ PUSH_DELIVERY_MODE: ' MOCK ', PUSH_DELIVERY_TTL_SECONDS: '600' }))).toMatchObject({ mode: 'mock', modeExplicit: true, ttlSeconds: 600 });
    expect(loadPushDeliveryConfig(config({ PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-dev' })).mode).toBe('firebase');
    expect(loadPushDeliveryConfig(config({ PUSH_DELIVERY_MODE: 'disabled' })).modeExplicit).toBe(true);
  });

  it('production: the mode must be explicit and mock is refused', () => {
    expect(() => loadPushDeliveryConfig(config({ NODE_ENV: 'production' }))).toThrow('must be set explicitly');
    expect(() => loadPushDeliveryConfig(config({ NODE_ENV: 'production', PUSH_DELIVERY_MODE: 'mock' }))).toThrow('not allowed');
    expect(loadPushDeliveryConfig(config({ NODE_ENV: 'production', PUSH_DELIVERY_MODE: 'disabled' })).mode).toBe('disabled');
    expect(loadPushDeliveryConfig(config({ NODE_ENV: 'production', PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-prod' })).mode).toBe('firebase');
  });

  it.each(['fcm', 'true'])('rejects unknown mode %s', (mode) => {
    expect(() => loadPushDeliveryConfig(config({ PUSH_DELIVERY_MODE: mode }))).toThrow('PUSH_DELIVERY_MODE must be');
  });

  it.each(['0', '59', '2419201', '1.5', 'abc'])('rejects TTL %s', (ttl) => {
    expect(() => loadPushDeliveryConfig(config({ PUSH_DELIVERY_TTL_SECONDS: ttl }))).toThrow('PUSH_DELIVERY_TTL_SECONDS');
  });
});

describe('PushOutboxService.enqueue', () => {
  const enabled = () => new PushOutboxService(config({ PUSH_DELIVERY_MODE: 'mock', PUSH_DELIVERY_TTL_SECONDS: '600' }));

  it('requires the caller transaction (refuses a manager without an active transaction)', async () => {
    const { manager, query } = fakeManager({ ok: true, missing: [], inserted: [] }, false);
    await expect(enabled().enqueue(manager, ['1'])).rejects.toBeInstanceOf(OutboxUsageError);
    await expect(enabled().enqueue(undefined as unknown as EntityManager, ['1'])).rejects.toBeInstanceOf(OutboxUsageError);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[['0']], [['-1']], [['1.5']], [['abc']], [[1 as unknown as string]], [['12345678901234567890']]])('rejects invalid ids %j without touching the database', async (ids) => {
    const { manager, query } = fakeManager({ ok: true, missing: [], inserted: [] });
    await expect(enabled().enqueue(manager, ids)).rejects.toBeInstanceOf(OutboxUsageError);
    expect(query).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_ENQUEUE_BATCH} ids per call`, async () => {
    const { manager } = fakeManager({ ok: true, missing: [], inserted: [] });
    await expect(enabled().enqueue(manager, Array.from({ length: MAX_ENQUEUE_BATCH + 1 }, (_, i) => String(i + 1)))).rejects.toThrow('at most');
  });

  it('disabled by configuration: no-op, nothing written, explicit PUSH_DISABLED result', async () => {
    const { manager, query } = fakeManager({ ok: true, missing: [], inserted: [] });
    const svc = new PushOutboxService(config({}));
    await expect(svc.enqueue(manager, ['1', '2'])).resolves.toEqual({ enqueued: [], alreadyQueued: [], skipped: 'PUSH_DISABLED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('empty input: no query', async () => {
    const { manager, query } = fakeManager({ ok: true, missing: [], inserted: [] });
    await expect(enabled().enqueue(manager, [])).resolves.toEqual({ enqueued: [], alreadyQueued: [], skipped: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('one statement on the caller manager; input de-duplicated; TTL passed; enqueued vs already queued split', async () => {
    const { manager, query } = fakeManager({ ok: true, missing: [], inserted: ['7'] });
    await expect(enabled().enqueue(manager, ['7', '8', '7'])).resolves.toEqual({ enqueued: ['7'], alreadyQueued: ['8'], skipped: null });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([['7', '8'], 600]);
    expect(sql).toMatch(/ON CONFLICT \(notification_id\) DO NOTHING/);
    expect(sql).toMatch(/WHERE c\.ok/);
    expect(sql).toMatch(/ORDER BY f\.id\s/); // deterministic insert order (deadlock freedom)
  });

  it('missing notification: OutboxNotificationNotFoundError with the missing ids', async () => {
    const { manager } = fakeManager({ ok: false, missing: ['9'], inserted: [] });
    const error = await enabled().enqueue(manager, ['8', '9']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboxNotificationNotFoundError);
    expect((error as OutboxNotificationNotFoundError).missingIds).toEqual(['9']);
  });
});
