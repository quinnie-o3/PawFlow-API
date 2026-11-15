# P3-BE06-04 — Firebase Provider Adapter

Status: **implemented and unit-tested (BE06-04)**.

- The adapter is **not yet used by any worker** (that is BE06-05).
- No live Firebase call was made, and no Firebase project or credentials are needed for tests.
- No migration.

Code: `src/push-delivery/provider/`:

- `push-provider.types.ts`
- `fcm-message.ts`
- `firebase-error.ts`
- `push-providers.ts`
- `push-provider.spec.ts`

Wiring: `PushDeliveryModule` exports the `PUSH_PROVIDER` token. Configuration: `src/push-delivery/push-delivery.config.ts`, the same loader the outbox uses.

## 1. Provider interface

```ts
interface PushProvider {
  readonly name: 'disabled' | 'mock' | 'firebase';
  send(destination: PushDestination, message: PushMessage): Promise<DeliveryResult>; // never throws
}
interface PushDestination { kind: 'FID' | 'FCM_TOKEN'; value: string }  // P3-BE05 RegistrationKind; value = decrypted registration
interface PushMessage {
  notificationId: string; type: NotificationType; title: string; body: string;
  target: { type: NotificationTargetType; id: string } | null;
  data?: Record<string, string>;   // optional extra navigation metadata
  ttlSeconds?: number;             // optional FCM TTL (e.g. the job's remaining window)
}
```

**The caller selects and checks the destination.** That means P3-BE05 `findSendTargets` plus a per-device eligibility re-check, done in BE06-05/06. The provider never reads the database, never decides eligibility, never changes device or job state, and never calls `markInvalid`.

### Results (`DeliveryResult`)

| outcome | Meaning | What the caller (BE06-05) should do |
|---|---|---|
| `ACCEPTED` (+ `providerMessageId`) | FCM accepted the message. This is **not** proof of device delivery: the device may be offline, the message may expire or be collapsed. | Record a final success for this device. |
| `INVALID_DESTINATION` (+ `code`) | FID/token no longer registered (`UNREGISTERED`, `UNREGISTERED_FID`, HTTP 404). | The **only** outcome that justifies `markInvalid(deviceId, attemptedAt)`. |
| `INVALID_REQUEST` (+ `code`) | Generic `INVALID_ARGUMENT`-style rejection, or a malformed destination given by the caller. Could be the payload **or** the destination. | Final failure for this device. **Never revoke** the device. |
| `INVALID_PAYLOAD` (+ `code`) | The message itself is invalid (rejected locally before any call, or by FCM). | Final failure; retrying the same content will not help. |
| `RATE_LIMITED` (+ `retryAfterMs`) | Quota exceeded. | Retry later: `≥ retryAfterMs` when given, and at least 1 minute (FCM guidance). |
| `TRANSIENT` (+ `ambiguous`, `retryAfterMs`) | Temporary failure. `ambiguous: true` means FCM **may have accepted** the message (timeouts, transport errors, unknown errors). | Retry with backoff. When `ambiguous`, a retry may duplicate the push; the device de-duplicates via the tag (§4). |
| `CONFIGURATION` (+ `code`) | Credentials, project, permission, APNs/web-push credentials, or app setup. Affects all sends. | Stop or slow down and alert an operator. **Never revoke** devices. |
| `DISABLED` | Push is disabled by configuration; nothing was sent. | Nothing. Never treat as sent. |

`code` is a sanitized code token such as `messaging/server-unavailable` or `pawflow/payload-too-large`. It is never an SDK message, a destination or a credential: anything that does not match the code pattern becomes `pawflow/unknown-error`.

## 2. Modes (single `PUSH_DELIVERY_MODE`)

| Mode | Provider | Behaviour |
|---|---|---|
| `disabled` (default when unset outside deployed environments) | `DisabledPushProvider` | Returns `DISABLED`. Never builds a message, initializes Firebase or contacts the network. The outbox writes no jobs in this mode (BE06-02), so nothing accumulates. |
| `mock` (development/QA; **refused** when `NODE_ENV` is `production` or `staging`) | `MockPushProvider` | Deterministic and in-memory, with no network. Validates and builds the exact FCM message (same code path as Firebase). The outcome is chosen by the destination value prefix (§2.1). Keeps a bounded history (default 200) of built messages with the destination **fingerprint** (a SHA-256 prefix), never the value. There is no HTTP control endpoint. |
| `firebase` | `FirebasePushProvider` | Firebase Admin SDK `messaging.send()`. Requires `FIREBASE_PROJECT_ID`. The Firebase app is **created lazily on the first send**; the app boots without contacting Google. |

### 2.1 Mock outcomes by destination prefix

| Prefix | Result |
|---|---|
| `mockUnreg` | `INVALID_DESTINATION` (`installation-id-not-registered` for FIDs, `registration-token-not-registered` for tokens) |
| `mockInvArg` | `INVALID_REQUEST` |
| `mockPayload` | `INVALID_PAYLOAD` |
| `mockUnavail` | `TRANSIENT`, not ambiguous |
| `mockTimeout` | `TRANSIENT`, ambiguous (returns immediately) |
| `mockRate` | `RATE_LIMITED`, 60 s |
| `mockAuth` | `CONFIGURATION` |
| anything else | `ACCEPTED`, `mock/<notificationId>/<n>` |

### 2.2 Deployed environments

`NODE_ENV=production` **or `staging`**:

- `PUSH_DELIVERY_MODE` must be explicit (`firebase` or `disabled`);
- `mock` is refused;
- `firebase` without a valid `FIREBASE_PROJECT_ID` is refused.

The application fails at startup and never falls back to mock. The rest of the codebase only knows `production`; `staging` is recognised here because this subtask requires it.

## 3. Configuration and credentials

| Variable | Default | Notes |
|---|---|---|
| `PUSH_DELIVERY_MODE` | `disabled` | See §2 |
| `PUSH_DELIVERY_TTL_SECONDS` | 86400 | Outbox delivery deadline (BE06-02) |
| `FIREBASE_PROJECT_ID` | none | Required for `firebase`. Pattern `^[a-z][a-z0-9-]{4,28}[a-z0-9]$`. Use one project per environment. |
| `PUSH_SEND_TIMEOUT_MS` | 10000 (1000–60000) | Bounds one provider call, **including the SDK's own retries** |

**Credentials:**

- Application Default Credentials only: `initializeApp({ credential: applicationDefault(), projectId }, 'pawflow-push')`.
- In deployment, use the runtime's attached service account or workload identity. Alternatively, Google's library can read `GOOGLE_APPLICATION_CREDENTIALS`, set by the runtime to a key file **outside the repository**.
- PawFlow code never reads a credential path, file or JSON, and never accepts credentials from callers or requests.
- `.gitignore` now ignores `*-firebase-adminsdk-*.json`, `service-account*.json`, `serviceAccount*.json` and `google-application-credentials*.json`.

**Re-initialization safety.** The named app `pawflow-push` is reused if it already exists (Nest module re-creation, tests), so there is no `app/duplicate-app`. An existing app bound to another project gives `CONFIGURATION` (`pawflow/firebase-app-conflict`).

## 4. Targeting and payload contract

**Targeting.** `FID → { fid }` (the SDK's `FidMessage`, the preferred API). `FCM_TOKEN → { token }` (`TokenMessage`, deprecated by Firebase, compatibility only). Exactly one of the two, never interchanged. The value must match the P3-BE05 pattern for its kind; otherwise the result is `INVALID_REQUEST` (`pawflow/invalid-destination-format`) and nothing is sent.

**Message built** (`buildFcmMessage`; FCM HTTP v1 shape, typed as the SDK's `Message`, no casts):

```json
{
  "fid": "<value>",
  "notification": { "title": "...", "body": "..." },
  "data": { "notificationId": "42", "type": "BOOKING_CONFIRMED", "targetType": "BOOKING", "targetId": "9" },
  "android": { "notification": { "tag": "pawflow-42" }, "ttl": 3600000 },
  "apns": { "headers": { "apns-collapse-id": "pawflow-42", "apns-expiration": "<epoch>" } },
  "webpush": { "headers": { "TTL": "3600" }, "notification": { "tag": "pawflow-42" } }
}
```

The TTL fields appear only when `ttlSeconds` is given.

**Validation, enforced locally before any SDK call:**

- `notificationId` and `targetId` are positive bigint strings.
- `type` and target type come from the P3-BE04 catalogue.
- Title is 1–150 characters and body 1–1000, trimmed, with no control characters.
- Every `data` value is a **string**.
- Extra `data`:
  - at most 8 keys; key pattern `^[A-Za-z][A-Za-z0-9_]{0,39}$`;
  - FCM-reserved keys are rejected (`from`, `notification`, `message_type`, `collapse_key`, anything starting with `google` or `gcm`), as are the builder's own keys;
  - sensitive key names are rejected (`password`, `token`, `secret`, `otp`, `credential`, `session`, `cookie`, `auth`, `link`, `url`, `href`, `email`, `phone`, `address`, `reason`, `note`);
  - values are at most 300 characters, with no URLs (`scheme://`, `www.`, `javascript:` and similar) and no control characters.
- `notification` + `data` must be **≤ 4096 bytes** (UTF-8, FCM limit); otherwise `pawflow/payload-too-large`.
- Title and body come from the persisted inbox notification. Since BE06-03 that content excludes reasons, contact data and prices. No entity is ever serialized.
- **No `link` / `fcmOptions.link`** and no URLs: the client navigates from `targetType`/`targetId` through its own authorized routes.

**Display de-duplication.** The tag / `apns-collapse-id` `pawflow-<notificationId>` makes a re-sent push (delivery is at least once) replace the earlier one on the device instead of stacking.

## 5. Failure classification (Admin SDK v14.5.0)

The SDK maps FCM server codes to client codes (`lib/messaging/error.js`):

- `UNREGISTERED` → `registration-token-not-registered`; **with a `fid` target** → `installation-id-not-registered`;
- `QUOTA_EXCEEDED` → `message-rate-exceeded`;
- `SENDER_ID_MISMATCH` / `PERMISSION_DENIED` → `mismatched-credential`;
- `UNAUTHENTICATED` / `APNS_AUTH_ERROR` → `third-party-auth-error`.

`classifyFirebaseError` (`firebase-error.ts`) maps:

| Codes | Outcome |
|---|---|
| `messaging/registration-token-not-registered`, `messaging/installation-id-not-registered` | `INVALID_DESTINATION` |
| `messaging/invalid-argument`, `invalid-recipient`, `invalid-registration-token`, `invalid-package-name` | `INVALID_REQUEST` (**not** destination proof) |
| `messaging/invalid-payload`, `invalid-data-payload-key`, `payload-size-limit-exceeded`, `invalid-options` | `INVALID_PAYLOAD` |
| `messaging/message-rate-exceeded`, `device-message-rate-exceeded`, `topics-message-rate-exceeded` | `RATE_LIMITED` (+ Retry-After) |
| `messaging/server-unavailable`, `messaging/internal-error` | `TRANSIENT`, not ambiguous (+ Retry-After) |
| `app/network-timeout`, `app/network-error`, `pawflow/send-timeout`, `messaging/unknown-error`, `app/internal-error`, `app/unable-to-parse-response` | `TRANSIENT`, **ambiguous** |
| `messaging/mismatched-credential`, `third-party-auth-error`, `authentication-error`, `app/invalid-credential`, `app/invalid-app-options`, `app/no-app`, `app/app-deleted`, `app/duplicate-app`, `app/invalid-app-name`, `pawflow/firebase-app-conflict` | `CONFIGURATION` |
| anything else (new SDK codes, non-Firebase errors) | `TRANSIENT`, **ambiguous**: conservative, never revoke |

`Retry-After` is read from the SDK error's `httpResponse` headers, in seconds or as an HTTP date, and capped at 24 h. Errors thrown **synchronously** by `send()` (SDK-side validation) are caught and classified the same way.

## 6. Firebase SDK behaviour the worker must know

- **One adapter call can be several network attempts.** The SDK's HTTP client (`lib/utils/api-request.js`, `defaultRetryConfig`) retries HTTP **503** and I/O errors **`ECONNRESET` / `ETIMEDOUT`** up to **4 times**, with exponential backoff (factor 0.5, max 60 s), honouring `Retry-After`. 429 and 500 are **not** retried by the SDK.
- `PUSH_SEND_TIMEOUT_MS` bounds the whole call. On timeout the SDK call keeps running in the background; its late result is ignored, and a late rejection is swallowed so it never becomes an unhandled rejection. The outcome is reported as ambiguous.
- The adapter has **no retry loop of its own**. Retries, backoff, attempt counting and deadlines belong to the BE06-05 worker and the outbox.

## 7. Security considerations

- Destination values are secret-like:
  - never logged, returned or stored by the provider;
  - mock history keeps a 12-hex SHA-256 fingerprint only;
  - SDK error messages, which can contain request details, are never logged or returned, only the sanitized code.
- Each log line has exactly this shape: `push <OUTCOME> [code=<code>] [ambiguous] kind=<FID|FCM_TOKEN> notification=<id>`. Failures are logged at `warn`, acceptances at `debug`. There is no content and no destination.
- Payload whitelist and size limit as in §4. No URLs, no secrets, no free-text reasons, no contact data.
- No public endpoint controls the mock. Mock is refused in deployed environments.
- No credentials in the repository, and key-file name patterns are git-ignored.
- Dependency: `firebase-admin@^14.5.0` (installed 14.5.0). `npm audit` goes from 33 to 36: 3 **moderate** findings in transitive Google libraries (`gaxios`, `gcp-metadata`, `google-gax`, through `rimraf`→`glob`) pulled in by `firebase-admin`. There is no direct exposure through the messaging path we use. Track for an upstream fix.

## 8. Verification (BE06-04)

| Check | Result |
|---|---|
| `src/push-delivery/provider/push-provider.spec.ts` | **60/60** (covers all 24 required cases) |
| `src/push-delivery/push-outbox.spec.ts` (config expectations updated for the 2 new fields and `firebase` requiring a project id) | 22/22 |
| Boot smoke on a disposable database (disabled / mock / firebase with a fake project and no credentials: boots, no Firebase initialization; production + mock refuses to start with the push-config error) | 7/7 |
| `qa:push-outbox` / `qa:booking-events` (unchanged behaviour) | 28/28, 32/32 |
| tsc, nest build | clean |
| lint | 0 errors; 1 pre-existing warning |

Test highlights:

- no network calls (spies on `http`, `https`, `http2`, `net` and `fetch`);
- no Firebase initialization in disabled/mock mode, nor in firebase mode before the first send;
- repeated initialization with the real Admin SDK (fake credential, no network) creates the named app once;
- hung sends time out within the bound as ambiguous;
- nothing leaks into results or logs.

## 9. Limitations and BE06-05 requirements

- **No live Firebase verification yet.** Only SDK-shaped errors and an injected client were tested. A controlled end-to-end check against a real **non-production** Firebase project, with a real web-client FID, is needed before production (BE06-08 or later). It needs operator-provided credentials.
- `ACCEPTED` ≠ delivered. FCM delivery receipts and analytics are out of scope.
- **The BE06-05 worker must:**
  - claim jobs (`SKIP LOCKED` + lease);
  - expire past-deadline jobs;
  - re-read the notification;
  - select destinations via `findSendTargets` and re-check each device;
  - call `provider.send` per device with `ttlSeconds` = remaining window;
  - persist per-device final outcomes;
  - call `markInvalid` **only** on `INVALID_DESTINATION`;
  - schedule retries for `TRANSIENT` / `RATE_LIMITED` (≥ `retryAfterMs`, quota ≥ 60 s);
  - treat `CONFIGURATION` as a global, alertable condition;
  - treat `DISABLED` as "do not process".
  - It must also assume one call may be several network attempts and that ambiguous outcomes can duplicate.
