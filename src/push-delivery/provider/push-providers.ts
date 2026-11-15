import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { type App, applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';

import type { PushDeliveryConfig } from '../push-delivery.config';
import { buildFcmMessage } from './fcm-message';
import { classifyFirebaseError } from './firebase-error';
import type { DeliveryResult, PushDestination, PushMessage, PushProvider } from './push-provider.types';

/** Safe log line: outcome, code, destination kind, notification id. Never the destination value or the content. */
function describe(result: DeliveryResult, destination: PushDestination, message: PushMessage): string {
  const code = 'code' in result ? ` code=${result.code}` : '';
  const ambiguous = result.outcome === 'TRANSIENT' && result.ambiguous ? ' ambiguous' : '';
  return `push ${result.outcome}${code}${ambiguous} kind=${destination?.kind} notification=${message?.notificationId}`;
}

// --------------------------------------------------------------------- disabled

/** PUSH_DELIVERY_MODE=disabled: never contacts anything, never pretends to send. */
export class DisabledPushProvider implements PushProvider {
  readonly name = 'disabled' as const;

  send(): Promise<DeliveryResult> {
    return Promise.resolve({ outcome: 'DISABLED' });
  }
}

// ------------------------------------------------------------------------ mock

export interface MockSendRecord {
  /** The FCM target field the real provider would use. */
  field: 'fid' | 'token';
  kind: PushDestination['kind'];
  /** SHA-256 prefix of the destination value (the value itself is never kept). */
  destinationFingerprint: string;
  notificationId: string;
  /** The FCM message as built for Firebase, with the destination removed. */
  message: Omit<Message, 'fid' | 'token' | 'topic' | 'condition'>;
  result: DeliveryResult;
}

/**
 * PUSH_DELIVERY_MODE=mock (development / QA; refused in deployed
 * environments). Deterministic, in memory, no network. The outcome is
 * chosen by the destination value prefix:
 *   mockUnreg   INVALID_DESTINATION  (messaging/registration-token-not-registered,
 *                                     or installation-id-not-registered for FIDs)
 *   mockInvArg  INVALID_REQUEST      (messaging/invalid-argument)
 *   mockPayload INVALID_PAYLOAD      (messaging/payload-size-limit-exceeded)
 *   mockUnavail TRANSIENT            (messaging/server-unavailable, not ambiguous)
 *   mockTimeout TRANSIENT ambiguous  (app/network-timeout; returns immediately)
 *   mockRate    RATE_LIMITED         (messaging/message-rate-exceeded, retryAfterMs 60000)
 *   mockAuth    CONFIGURATION        (messaging/third-party-auth-error)
 *   anything else ACCEPTED           (providerMessageId mock/<notificationId>/<n>)
 * The message is built and validated exactly as for Firebase, so payload
 * errors are identical. Outcomes are controlled only by test data; there is
 * no HTTP control endpoint.
 */
export class MockPushProvider implements PushProvider {
  readonly name = 'mock' as const;
  private readonly logger = new Logger('MockPushProvider');
  private readonly records: MockSendRecord[] = [];
  private seq = 0;

  constructor(private readonly maxHistory = 200) {}

  send(destination: PushDestination, message: PushMessage): Promise<DeliveryResult> {
    const built = buildFcmMessage(destination, message);
    if (!built.ok) {
      const result: DeliveryResult = { outcome: built.outcome, code: built.code };
      this.logger.warn(describe(result, destination, message));
      return Promise.resolve(result);
    }
    const result = this.outcomeFor(destination, message.notificationId);
    const { fid: _fid, token: _token, ...rest } = built.message as Message & { fid?: string; token?: string };
    this.records.push({
      field: destination.kind === 'FID' ? 'fid' : 'token',
      kind: destination.kind,
      destinationFingerprint: createHash('sha256').update(destination.value).digest('hex').slice(0, 12),
      notificationId: message.notificationId,
      message: rest as MockSendRecord['message'],
      result,
    });
    if (this.records.length > this.maxHistory) this.records.shift();
    if (result.outcome === 'ACCEPTED') this.logger.debug(describe(result, destination, message));
    else this.logger.warn(describe(result, destination, message));
    return Promise.resolve(result);
  }

  /** Recorded sends (oldest first; bounded). For tests and QA only. */
  history(): readonly MockSendRecord[] {
    return [...this.records];
  }

  reset(): void {
    this.records.length = 0;
  }

  private outcomeFor(destination: PushDestination, notificationId: string): DeliveryResult {
    const v = destination.value;
    if (v.startsWith('mockUnreg')) {
      return { outcome: 'INVALID_DESTINATION', code: destination.kind === 'FID' ? 'messaging/installation-id-not-registered' : 'messaging/registration-token-not-registered' };
    }
    if (v.startsWith('mockInvArg')) return { outcome: 'INVALID_REQUEST', code: 'messaging/invalid-argument' };
    if (v.startsWith('mockPayload')) return { outcome: 'INVALID_PAYLOAD', code: 'messaging/payload-size-limit-exceeded' };
    if (v.startsWith('mockUnavail')) return { outcome: 'TRANSIENT', code: 'messaging/server-unavailable', ambiguous: false, retryAfterMs: null };
    if (v.startsWith('mockTimeout')) return { outcome: 'TRANSIENT', code: 'app/network-timeout', ambiguous: true, retryAfterMs: null };
    if (v.startsWith('mockRate')) return { outcome: 'RATE_LIMITED', code: 'messaging/message-rate-exceeded', retryAfterMs: 60_000 };
    if (v.startsWith('mockAuth')) return { outcome: 'CONFIGURATION', code: 'messaging/third-party-auth-error' };
    return { outcome: 'ACCEPTED', providerMessageId: `mock/${notificationId}/${++this.seq}` };
  }
}

// -------------------------------------------------------------------- firebase

/** The part of the Admin SDK Messaging client the provider uses. */
export interface MessagingClient {
  send(message: Message): Promise<string>;
}

/** Admin SDK entry points (injectable so tests never touch real credentials or the network). */
export interface FirebaseSdk {
  getApps: () => App[];
  initializeApp: typeof initializeApp;
  applicationDefault: typeof applicationDefault;
  getMessaging: (app: App) => MessagingClient;
}

export const DEFAULT_FIREBASE_SDK: FirebaseSdk = { getApps, initializeApp, applicationDefault, getMessaging };

/** Name of the one Firebase app PawFlow creates (reused across module re-initialization). */
export const FIREBASE_PUSH_APP_NAME = 'pawflow-push';

/**
 * Creates (once) the named Firebase app with Application Default
 * Credentials and the configured project, and returns its Messaging client.
 * Lazy: nothing is initialized until the first send. Re-creating the Nest
 * module (tests, hot reload) reuses the existing named app instead of
 * failing with app/duplicate-app; an existing app bound to a different
 * project is refused (CONFIGURATION).
 */
export class FirebaseMessagingFactory {
  private client: MessagingClient | null = null;

  constructor(
    private readonly projectId: string,
    private readonly sdk: FirebaseSdk = DEFAULT_FIREBASE_SDK,
  ) {}

  get(): MessagingClient {
    if (!this.client) {
      const existing = this.sdk.getApps().find((app) => app.name === FIREBASE_PUSH_APP_NAME);
      if (existing && existing.options.projectId !== this.projectId) {
        throw Object.assign(new Error('Firebase app already initialized for another project'), { code: 'pawflow/firebase-app-conflict' });
      }
      const app = existing ?? this.sdk.initializeApp({ credential: this.sdk.applicationDefault(), projectId: this.projectId }, FIREBASE_PUSH_APP_NAME);
      this.client = this.sdk.getMessaging(app);
    }
    return this.client;
  }
}

/**
 * PUSH_DELIVERY_MODE=firebase. One `messaging.send()` per call (no own
 * retry loop). Note: the Admin SDK itself retries some failures inside one
 * call (HTTP 503 and ECONNRESET / ETIMEDOUT, up to 4 retries with
 * exponential backoff, honouring Retry-After), so one call may be several
 * network attempts; PUSH_SEND_TIMEOUT_MS bounds the whole call and a
 * timeout is reported as ambiguous.
 */
export class FirebasePushProvider implements PushProvider {
  readonly name = 'firebase' as const;
  private readonly logger = new Logger('FirebasePushProvider');

  constructor(
    private readonly messaging: Pick<FirebaseMessagingFactory, 'get'>,
    private readonly timeoutMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async send(destination: PushDestination, message: PushMessage): Promise<DeliveryResult> {
    const built = buildFcmMessage(destination, message, this.clock());
    if (!built.ok) {
      const result: DeliveryResult = { outcome: built.outcome, code: built.code };
      this.logger.warn(describe(result, destination, message));
      return result;
    }

    let timer: NodeJS.Timeout | undefined;
    let result: DeliveryResult;
    try {
      const client = this.messaging.get();
      // send() can also throw synchronously (SDK-side validation).
      const sending = Promise.resolve().then(() => client.send(built.message));
      sending.catch(() => undefined); // a late failure after a timeout must not become an unhandled rejection
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('send timeout'), { code: 'pawflow/send-timeout' })), this.timeoutMs);
      });
      const id = await Promise.race([sending, timeout]);
      result = { outcome: 'ACCEPTED', providerMessageId: typeof id === 'string' ? id.slice(0, 200) : '' };
    } catch (error) {
      result = classifyFirebaseError(error, this.clock());
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result.outcome === 'ACCEPTED') this.logger.debug(describe(result, destination, message));
    else this.logger.warn(describe(result, destination, message));
    return result;
  }
}

// --------------------------------------------------------------------- factory

/**
 * The provider for the configured mode. Only `firebase` creates a Firebase
 * factory, and even then nothing is initialized or contacted until the
 * first send. `mock` is refused in deployed environments by the config.
 */
export function createPushProvider(config: PushDeliveryConfig, sdk: FirebaseSdk = DEFAULT_FIREBASE_SDK): PushProvider {
  switch (config.mode) {
    case 'firebase':
      return new FirebasePushProvider(new FirebaseMessagingFactory(config.firebaseProjectId!, sdk), config.sendTimeoutMs);
    case 'mock':
      return new MockPushProvider();
    default:
      return new DisabledPushProvider();
  }
}
