import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { type App, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';

import { loadPushDeliveryConfig, type PushDeliveryConfig } from '../push-delivery.config';
import { buildFcmMessage, FCM_MAX_PAYLOAD_BYTES } from './fcm-message';
import { classifyFirebaseError, retryAfterMs } from './firebase-error';
import type { PushDestination, PushMessage } from './push-provider.types';
import {
  createPushProvider,
  DisabledPushProvider,
  FIREBASE_PUSH_APP_NAME,
  FirebaseMessagingFactory,
  FirebasePushProvider,
  type FirebaseSdk,
  type MessagingClient,
  MockPushProvider,
} from './push-providers';

/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http') as typeof import('node:http');
const https = require('node:https') as typeof import('node:https');
const http2 = require('node:http2') as typeof import('node:http2');
const net = require('node:net') as typeof import('node:net');
/* eslint-enable @typescript-eslint/no-require-imports */

const FID = 'cVxq3f8mT0uYhL2s9pQ1zA';
const TOKEN = `fGk2:APA91b${'x7Yz'.repeat(30)}`;
const fid = (value = FID): PushDestination => ({ kind: 'FID', value });
const token = (value = TOKEN): PushDestination => ({ kind: 'FCM_TOKEN', value });
const msg = (patch: Partial<PushMessage> = {}): PushMessage => ({
  notificationId: '42',
  type: 'BOOKING_CONFIRMED',
  title: 'Booking confirmed',
  body: 'Your Grooming booking for Milo on 2026-12-12 at 09:00 was confirmed.',
  target: { type: 'BOOKING', id: '9' },
  ...patch,
});
const cfg = (v: Record<string, string | undefined>) => ({ get: (k: string) => v[k] }) as unknown as ConfigService;
const firebaseError = (code: string, headers?: Record<string, string>) => Object.assign(new Error(`FCM failure for ${FID} / ${TOKEN}`), { code, ...(headers ? { httpResponse: { status: 0, headers } } : {}) });

function fakeClient(impl: (m: Message) => Promise<string> = () => Promise.resolve('projects/pawflow-dev/messages/0:1234')) {
  const sent: Message[] = [];
  const client: MessagingClient = { send: jest.fn((m: Message) => (sent.push(m), impl(m))) };
  return { client, sent, provider: new FirebasePushProvider({ get: () => client }, 1_000, () => 1_800_000_000_000) };
}

function spySdk(): FirebaseSdk & { calls: string[] } {
  const calls: string[] = [];
  const fail = (name: string) => () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };
  return { calls, getApps: fail('getApps'), initializeApp: fail('initializeApp') as never, applicationDefault: fail('applicationDefault') as never, getMessaging: fail('getMessaging') };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  }
});
afterEach(() => jest.restoreAllMocks());

describe('configuration (shared PUSH_DELIVERY_MODE)', () => {
  it('19. deployed environments reject mock and implicit modes; firebase needs a valid project id', () => {
    for (const env of ['production', 'staging']) {
      expect(() => loadPushDeliveryConfig(cfg({ NODE_ENV: env, PUSH_DELIVERY_MODE: 'mock' }))).toThrow('not allowed');
      expect(() => loadPushDeliveryConfig(cfg({ NODE_ENV: env }))).toThrow('must be set explicitly');
      expect(() => loadPushDeliveryConfig(cfg({ NODE_ENV: env, PUSH_DELIVERY_MODE: 'firebase' }))).toThrow('FIREBASE_PROJECT_ID is required');
      expect(loadPushDeliveryConfig(cfg({ NODE_ENV: env, PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: 'pawflow-prod' })).firebaseProjectId).toBe('pawflow-prod');
    }
    for (const bad of ['Pawflow', 'pf', 'pawflow_prod', 'pawflow-', '1pawflow', 'a'.repeat(31)]) {
      expect(() => loadPushDeliveryConfig(cfg({ PUSH_DELIVERY_MODE: 'firebase', FIREBASE_PROJECT_ID: bad }))).toThrow('not a valid Firebase project id');
    }
    expect(() => loadPushDeliveryConfig(cfg({ PUSH_SEND_TIMEOUT_MS: '999' }))).toThrow('PUSH_SEND_TIMEOUT_MS');
    expect(loadPushDeliveryConfig(cfg({ PUSH_DELIVERY_MODE: 'mock' })).sendTimeoutMs).toBe(10_000);
  });

  it('createPushProvider selects the implementation by mode', () => {
    const base = loadPushDeliveryConfig(cfg({}));
    expect(createPushProvider(base, spySdk()).name).toBe('disabled');
    expect(createPushProvider({ ...base, mode: 'mock' }, spySdk()).name).toBe('mock');
    expect(createPushProvider({ ...base, mode: 'firebase', firebaseProjectId: 'pawflow-dev' }, spySdk()).name).toBe('firebase');
  });
});

describe('disabled provider', () => {
  it('1 + 21. answers DISABLED, never initializes or contacts Firebase', async () => {
    const sdk = spySdk();
    const provider = createPushProvider(loadPushDeliveryConfig(cfg({})), sdk);
    await expect(provider.send(fid(), msg())).resolves.toEqual({ outcome: 'DISABLED' });
    await expect(new DisabledPushProvider().send()).resolves.toEqual({ outcome: 'DISABLED' });
    expect(sdk.calls).toEqual([]);
    expect(getApps()).toHaveLength(0);
  });

  it('21. firebase mode initializes nothing until the first send', () => {
    const sdk = spySdk();
    createPushProvider({ ...loadPushDeliveryConfig(cfg({})), mode: 'firebase', firebaseProjectId: 'pawflow-dev' } as PushDeliveryConfig, sdk);
    expect(sdk.calls).toEqual([]);
  });
});

describe('mock provider', () => {
  it('2. success: ACCEPTED with a deterministic id, records the FCM message without the destination', async () => {
    const mock = new MockPushProvider();
    await expect(mock.send(fid(), msg())).resolves.toEqual({ outcome: 'ACCEPTED', providerMessageId: 'mock/42/1' });
    await expect(mock.send(fid(), msg())).resolves.toEqual({ outcome: 'ACCEPTED', providerMessageId: 'mock/42/2' });
    const [rec] = mock.history();
    expect(rec).toMatchObject({ field: 'fid', kind: 'FID', notificationId: '42' });
    expect(rec.destinationFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(mock.history())).not.toContain(FID);
  });

  it('3. invalid destination (FID and legacy token codes)', async () => {
    const mock = new MockPushProvider();
    await expect(mock.send(fid('mockUnregABCDEFGHIJ'), msg())).resolves.toEqual({ outcome: 'INVALID_DESTINATION', code: 'messaging/installation-id-not-registered' });
    await expect(mock.send(token(`mockUnreg${'A'.repeat(64)}`), msg())).resolves.toEqual({ outcome: 'INVALID_DESTINATION', code: 'messaging/registration-token-not-registered' });
  });

  it.each([
    ['mockUnavailABCDEFGH', { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: false, retryAfterMs: null }],
    ['mockTimeoutABCDEFGH', { outcome: 'TRANSIENT', code: 'app/network-timeout', ambiguous: true, retryAfterMs: null }],
    ['mockRateABCDEFGHIJK', { outcome: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 60_000 }],
    ['mockInvArgABCDEFGHI', { outcome: 'INVALID_REQUEST', code: 'messaging/invalid-argument' }],
    ['mockPayloadABCDEFGH', { outcome: 'INVALID_PAYLOAD', code: 'messaging/payload-size-limit-exceeded' }],
    ['mockAuthABCDEFGHIJK', { outcome: 'CONFIGURATION', code: 'messaging/third-party-auth-error' }],
  ])('4. %s -> %j', async (value, expected) => {
    await expect(new MockPushProvider().send(fid(value), msg())).resolves.toEqual(expected);
  });

  it('5 + 6. records which FCM field the real provider would use (fid vs token)', async () => {
    const mock = new MockPushProvider();
    await mock.send(fid(), msg());
    await mock.send(token(), msg());
    expect(mock.history().map((r) => [r.kind, r.field])).toEqual([['FID', 'fid'], ['FCM_TOKEN', 'token']]);
  });

  it('validates payloads exactly like the Firebase provider; history is bounded', async () => {
    const mock = new MockPushProvider(3);
    await expect(mock.send(fid(), msg({ title: ' ' }))).resolves.toEqual({ outcome: 'INVALID_PAYLOAD', code: 'pawflow/invalid-title-or-body' });
    for (let i = 0; i < 5; i++) await mock.send(fid(), msg());
    expect(mock.history()).toHaveLength(3);
    mock.reset();
    expect(mock.history()).toHaveLength(0);
  });

  it('22. no network access while sending through the mock and the injected Firebase client', async () => {
    const spies = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request'), jest.spyOn(http2, 'connect'), jest.spyOn(net, 'connect')];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const mock = new MockPushProvider();
    for (const v of [FID, 'mockUnregABCDEFGHIJ', 'mockUnavailABCDEFGH']) await mock.send(fid(v), msg());
    await fakeClient().provider.send(fid(), msg());
    for (const s of [...spies, fetchSpy]) expect(s).not.toHaveBeenCalled();
  });
});

describe('FCM message builder', () => {
  it('5. FID destination -> `fid` only', () => {
    const r = buildFcmMessage(fid(), msg());
    expect(r.ok && r.message).toMatchObject({ fid: FID });
    expect(r.ok && r.message).not.toHaveProperty('token');
  });

  it('6. legacy token destination -> `token` only', () => {
    const r = buildFcmMessage(token(), msg());
    expect(r.ok && r.message).toMatchObject({ token: TOKEN });
    expect(r.ok && r.message).not.toHaveProperty('fid');
  });

  it('7. structure: notification, minimal data, per-notification tag / collapse id, no URL or link', () => {
    const r = buildFcmMessage(fid(), msg());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toEqual({
      fid: FID,
      notification: { title: 'Booking confirmed', body: 'Your Grooming booking for Milo on 2026-12-12 at 09:00 was confirmed.' },
      data: { notificationId: '42', type: 'BOOKING_CONFIRMED', targetType: 'BOOKING', targetId: '9' },
      android: { notification: { tag: 'pawflow-42' } },
      apns: { headers: { 'apns-collapse-id': 'pawflow-42' } },
      webpush: { notification: { tag: 'pawflow-42' } },
    });
    expect(JSON.stringify(r.message)).not.toMatch(/https?:|link|fcmOptions/);
  });

  it('7. optional TTL is applied to Android (ms), Web Push (TTL header) and APNs (absolute expiration)', () => {
    const r = buildFcmMessage(fid(), msg({ ttlSeconds: 3600 }), 1_800_000_000_000);
    expect(r.ok && r.message).toMatchObject({
      android: { ttl: 3_600_000 },
      webpush: { headers: { TTL: '3600' } },
      apns: { headers: { 'apns-expiration': String(1_800_000_000 + 3600) } },
    });
    expect(buildFcmMessage(fid(), msg({ ttlSeconds: -1 }))).toMatchObject({ ok: false, code: 'pawflow/invalid-ttl' });
  });

  it('8. every data value is a string; target-less notifications omit target keys; extra metadata is kept', () => {
    const r = buildFcmMessage(fid(), msg({ type: 'SYSTEM_ANNOUNCEMENT', target: null, data: { screen: 'inbox', section: 'unread' } }));
    expect(r.ok && r.message.data).toEqual({ notificationId: '42', type: 'SYSTEM_ANNOUNCEMENT', screen: 'inbox', section: 'unread' });
    expect(Object.values((r.ok && r.message.data) || {}).every((v) => typeof v === 'string')).toBe(true);
  });

  it.each([
    [{ notificationId: '0' }, 'pawflow/invalid-notification-id'],
    [{ notificationId: 42 as unknown as string }, 'pawflow/invalid-notification-id'],
    [{ type: 'BOOKING_ARCHIVED' as never }, 'pawflow/invalid-notification-type'],
    [{ title: '' }, 'pawflow/invalid-title-or-body'],
    [{ body: 'x'.repeat(1001) }, 'pawflow/invalid-title-or-body'],
    [{ title: 'bad\u0007bell' }, 'pawflow/invalid-title-or-body'],
    [{ target: { type: 'PAYMENT' as never, id: '9' } }, 'pawflow/invalid-target'],
    [{ target: { type: 'BOOKING', id: 'nine' } }, 'pawflow/invalid-target'],
    [{ data: { screen: 7 as unknown as string } }, 'pawflow/non-string-data-value'],
    [{ data: { screen: 'https://evil.example/x' } }, 'pawflow/invalid-data-value'],
    [{ data: { screen: 'www.evil.example' } }, 'pawflow/invalid-data-value'],
    [{ data: { refreshToken: 'abc' } }, 'pawflow/sensitive-data-key'],
    [{ data: { rejectReason: 'call me' } }, 'pawflow/sensitive-data-key'],
    [{ data: { contactEmail: 'a@b.c' } }, 'pawflow/sensitive-data-key'],
    [{ data: { password: 'x' } }, 'pawflow/sensitive-data-key'],
    [{ data: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])) }, 'pawflow/too-many-data-keys'],
  ] as [Partial<PushMessage>, string][])('9. invalid payload %j -> INVALID_PAYLOAD %s (nothing sent)', async (patch, code) => {
    const { provider, client } = fakeClient();
    await expect(provider.send(fid(), msg(patch))).resolves.toEqual({ outcome: 'INVALID_PAYLOAD', code });
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each(['from', 'notification', 'message_type', 'collapse_key', 'google_sent_time', 'gcmId', 'GoogleX', 'notificationId', 'targetId'])('10. reserved / own data key "%s" is rejected', (key) => {
    const r = buildFcmMessage(fid(), msg({ data: { [key]: 'v' } }));
    expect(r).toMatchObject({ ok: false, outcome: 'INVALID_PAYLOAD' });
    expect(['pawflow/reserved-data-key', 'pawflow/invalid-data-key']).toContain(!r.ok && r.code);
  });

  it(`11. payload above ${FCM_MAX_PAYLOAD_BYTES} bytes is rejected before sending; a large but valid one passes`, async () => {
    const { provider, client } = fakeClient();
    const emoji = '\u{1F43E}'; // 4 bytes in UTF-8, 2 UTF-16 code units
    await expect(provider.send(fid(), msg({ body: emoji.repeat(500) + 'x'.repeat(0) }))).resolves.toEqual({ outcome: 'ACCEPTED', providerMessageId: 'projects/pawflow-dev/messages/0:1234' });
    const big = msg({ body: emoji.repeat(500), data: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, emoji.repeat(150)])) });
    await expect(provider.send(fid(), big)).resolves.toEqual({ outcome: 'INVALID_PAYLOAD', code: 'pawflow/payload-too-large' });
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('malformed or mislabelled destinations are a caller error (INVALID_REQUEST), never INVALID_DESTINATION', async () => {
    const { provider, client } = fakeClient();
    for (const d of [fid('short'), fid(TOKEN), token(FID), { kind: 'APNS', value: FID } as unknown as PushDestination]) {
      await expect(provider.send(d, msg())).resolves.toEqual({ outcome: 'INVALID_REQUEST', code: 'pawflow/invalid-destination-format' });
    }
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('Firebase provider (injected Messaging client)', () => {
  it('12. accepted: returns the FCM message id; sends exactly the built message once', async () => {
    const { provider, sent } = fakeClient();
    await expect(provider.send(fid(), msg())).resolves.toEqual({ outcome: 'ACCEPTED', providerMessageId: 'projects/pawflow-dev/messages/0:1234' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual((buildFcmMessage(fid(), msg()) as { message: Message }).message);
  });

  it('5 + 6. FID and legacy token reach the SDK as `fid` / `token`', async () => {
    const { provider, sent } = fakeClient();
    await provider.send(fid(), msg());
    await provider.send(token(), msg());
    expect(sent.map((m) => ('fid' in m ? 'fid' : 'token' in m ? 'token' : '?'))).toEqual(['fid', 'token']);
  });

  it.each([
    ['messaging/installation-id-not-registered', 'INVALID_DESTINATION'],
    ['messaging/registration-token-not-registered', 'INVALID_DESTINATION'],
  ])('13. %s -> %s', async (code, outcome) => {
    const { provider } = fakeClient(() => Promise.reject(firebaseError(code)));
    await expect(provider.send(fid(), msg())).resolves.toEqual({ outcome, code });
  });

  it('14. INVALID_ARGUMENT is ambiguous (payload or destination): INVALID_REQUEST, never INVALID_DESTINATION', async () => {
    for (const code of ['messaging/invalid-argument', 'messaging/invalid-registration-token', 'messaging/invalid-recipient']) {
      const { provider } = fakeClient(() => Promise.reject(firebaseError(code)));
      await expect(provider.send(fid(), msg())).resolves.toEqual({ outcome: 'INVALID_REQUEST', code });
    }
  });

  it('15. server unavailable / internal -> TRANSIENT, not ambiguous; Retry-After honoured', async () => {
    const a = fakeClient(() => Promise.reject(firebaseError('messaging/server-unavailable', { 'retry-after': '120' })));
    await expect(a.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: false, retryAfterMs: 120_000 });
    const b = fakeClient(() => Promise.reject(firebaseError('messaging/internal-error')));
    await expect(b.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'TRANSIENT', code: 'messaging/internal-error', ambiguous: false, retryAfterMs: null });
  });

  it('16. quota exceeded -> RATE_LIMITED with Retry-After (seconds or HTTP date)', async () => {
    const a = fakeClient(() => Promise.reject(firebaseError('messaging/message-rate-exceeded', { 'retry-after': '60' })));
    await expect(a.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 60_000 });
    expect(retryAfterMs(firebaseError('x', { 'retry-after': new Date(1_800_000_090_000).toUTCString() }), 1_800_000_000_000)).toBe(90_000);
    expect(retryAfterMs(firebaseError('x', { 'retry-after': 'soon' }))).toBeNull();
    const b = fakeClient(() => Promise.reject(firebaseError('messaging/device-message-rate-exceeded')));
    await expect(b.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'RATE_LIMITED', code: 'messaging/device-message-rate-exceeded', retryAfterMs: null });
  });

  it('17. project / sender mismatch and permission errors -> CONFIGURATION', async () => {
    for (const code of ['messaging/mismatched-credential', 'messaging/third-party-auth-error', 'messaging/authentication-error']) {
      const { provider } = fakeClient(() => Promise.reject(firebaseError(code)));
      await expect(provider.send(fid(), msg())).resolves.toEqual({ outcome: 'CONFIGURATION', code });
    }
  });

  it('18. missing / invalid credentials -> CONFIGURATION (from send and from app initialization)', async () => {
    const a = fakeClient(() => Promise.reject(firebaseError('app/invalid-credential')));
    await expect(a.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'CONFIGURATION', code: 'app/invalid-credential' });
    const sdk: FirebaseSdk = {
      getApps: () => [],
      initializeApp: (() => {
        throw firebaseError('app/invalid-app-options');
      }) as never,
      applicationDefault: (() => ({})) as never,
      getMessaging: () => ({ send: () => Promise.resolve('never') }),
    };
    const provider = new FirebasePushProvider(new FirebaseMessagingFactory('pawflow-dev', sdk), 1_000);
    await expect(provider.send(fid(), msg())).resolves.toEqual({ outcome: 'CONFIGURATION', code: 'app/invalid-app-options' });
  });

  it('transport errors and timeouts -> TRANSIENT + ambiguous (FCM may have accepted)', async () => {
    for (const code of ['app/network-timeout', 'app/network-error']) {
      const { provider } = fakeClient(() => Promise.reject(firebaseError(code)));
      await expect(provider.send(fid(), msg())).resolves.toMatchObject({ outcome: 'TRANSIENT', code, ambiguous: true });
    }
    const hung = fakeClient(() => new Promise<string>(() => undefined));
    const t = Date.now();
    await expect(hung.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'TRANSIENT', code: 'pawflow/send-timeout', ambiguous: true, retryAfterMs: null });
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it('23. unknown SDK codes and non-Firebase errors -> TRANSIENT + ambiguous (conservative); codes sanitized', async () => {
    const cases: [unknown, string][] = [
      [firebaseError('messaging/unknown-error'), 'messaging/unknown-error'],
      [firebaseError('messaging/something-new'), 'messaging/something-new'],
      [new TypeError('boom'), 'pawflow/unknown-error'],
      ['string error', 'pawflow/unknown-error'],
      [firebaseError(`messaging/leak ${FID}`), 'pawflow/unknown-error'],
    ];
    for (const [error, code] of cases) expect(classifyFirebaseError(error)).toEqual({ outcome: 'TRANSIENT', code, ambiguous: true, retryAfterMs: null });
    const sync = fakeClient(() => {
      throw firebaseError('messaging/invalid-payload');
    });
    await expect(sync.provider.send(fid(), msg())).resolves.toEqual({ outcome: 'INVALID_PAYLOAD', code: 'messaging/invalid-payload' });
    expect(classifyFirebaseError({ errorInfo: { code: 'messaging/server-unavailable' } })).toMatchObject({ outcome: 'TRANSIENT', ambiguous: false });
    expect(classifyFirebaseError({ code: 'registration-token-not-registered' })).toMatchObject({ outcome: 'INVALID_DESTINATION', code: 'messaging/registration-token-not-registered' });
  });

  it('20. no destination value, SDK message or secret appears in results, logs or mock history', async () => {
    const errors = ['messaging/registration-token-not-registered', 'messaging/invalid-argument', 'app/invalid-credential', 'messaging/server-unavailable'];
    const outcomes: unknown[] = [];
    for (const code of errors) {
      const { provider } = fakeClient(() => Promise.reject(firebaseError(code)));
      outcomes.push(await provider.send(fid(), msg()), await provider.send(token(), msg()));
    }
    const mock = new MockPushProvider();
    outcomes.push(await mock.send(fid(), msg()), await mock.send(token('mockUnreg' + 'B'.repeat(70)), msg()));
    const resultsAndLogs = JSON.stringify(outcomes) + logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    // Results and logs: no destination, no SDK error message, no notification content.
    for (const secret of [FID, TOKEN, 'B'.repeat(70), 'FCM failure for', 'Booking confirmed', 'Grooming']) expect(resultsAndLogs).not.toContain(secret);
    // Mock history keeps the built message for inspection, but never the destination value.
    for (const secret of [FID, TOKEN, 'B'.repeat(70)]) expect(JSON.stringify(mock.history())).not.toContain(secret);
    expect(logged.every((l) => /^push [A-Z_]+( code=[a-z0-9/-]+)?( ambiguous)? kind=(FID|FCM_TOKEN) notification=42$/.test(l))).toBe(true);
  });
});

describe('Firebase app initialization (real Admin SDK, fake credential, no network)', () => {
  const credential = { getAccessToken: () => Promise.resolve({ access_token: 'not-a-real-token', expires_in: 3600 }) };
  let initCalls = 0;
  const realSdk: FirebaseSdk = {
    getApps,
    initializeApp: ((...args: Parameters<typeof initializeApp>) => (initCalls++, initializeApp(...args))) as typeof initializeApp,
    applicationDefault: (() => credential) as never,
    getMessaging,
  };

  afterAll(async () => {
    await Promise.all(getApps().map((app: App) => deleteApp(app)));
  });

  it('24. repeated module initialization reuses the one named app (no duplicate-app); another project is refused', async () => {
    const first = new FirebaseMessagingFactory('pawflow-dev', realSdk);
    const second = new FirebaseMessagingFactory('pawflow-dev', realSdk);
    expect(first.get()).toBe(first.get());
    second.get();
    expect(initCalls).toBe(1);
    expect(getApps().map((a) => a.name)).toEqual([FIREBASE_PUSH_APP_NAME]);
    expect(getApps()[0].options.projectId).toBe('pawflow-dev');

    const other = new FirebasePushProvider(new FirebaseMessagingFactory('pawflow-other', realSdk), 1_000);
    await expect(other.send(fid(), msg())).resolves.toEqual({ outcome: 'CONFIGURATION', code: 'pawflow/firebase-app-conflict' });
    expect(initCalls).toBe(1);
  });
});
