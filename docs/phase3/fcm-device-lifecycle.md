# PawFlow — FCM Device Registration & Lifecycle (P3-BE05)

Storage and lifecycle of push destinations (Firebase Cloud Messaging) for authenticated users, including logout and account-switch cleanup.
**No push is sent here** (P3-BE06), and the backend has **no Firebase SDK or credentials** for this task.
Verified by `npm test` (unit) and `npm run qa:push-devices` (real HTTP + PostgreSQL, two instances, 49 checks).
Source: `src/push-devices/*`, migration `1796000000000-CreatePushDevices`.

## 1. Identity contract (decision)

- **FID first.** Firebase is moving FCM from registration tokens to **Firebase Installation IDs** (FIDs). The web SDK's `register()` / `onRegistered()` / `onUnregistered()` / `unregister()` are the current API; `getToken()` / `deleteToken()` are deprecated ("will be removed in a future release"). FE-048 has not started (`pet-care-web` has no Firebase code), so there is no legacy client to stay compatible with. **New clients must register `registrationKind: "FID"`.**
- **Legacy tokens only explicitly.** `registrationKind: "FCM_TOKEN"` is accepted for a client that cannot use FIDs yet. The kind is part of the identity: the same string as an FID and as a token are different registrations. P3-BE06 sends `fid` for FID rows and `token` for token rows.
- **One destination per installation.** Firebase says not to use the FID APIs and the token APIs at the same time. The backend enforces **one active registration per auth session** (one login on one browser/app), so registering an FID from a session that had a token replaces the token (`ROTATED`).
- **Migration path for a token client:** switch to `register()`/`onRegistered()` and POST the FID; the token row is revoked automatically.
- Value formats are not specified by Firebase. The backend checks defensive bounds only: FID `[A-Za-z0-9_-]{16,64}`, token `[A-Za-z0-9_:-]{64,4096}`.

## 2. Data model (`push_devices`)

| Column | Notes |
|---|---|
| `id` | BIGINT |
| `user_id`, `auth_session_id` | Composite FK to `auth_sessions(id, user_id)`, ON DELETE CASCADE: a device always belongs to the account of the session that registered it. |
| `registration_kind` | `FID` \| `FCM_TOKEN` |
| `registration_hash` | HMAC-SHA256 of `kind:value` (lookup and uniqueness without decrypting) |
| `registration_ciphertext` | AES-256-GCM `v1:<keyId>:<iv>:<ct>:<tag>`; plaintext is never stored, logged or returned |
| `platform` | `WEB` \| `ANDROID` \| `IOS` |
| `registered_at`, `last_seen_at` | `last_seen_at` is updated on every re-registration (Firebase recommends a timestamp per upload) |
| `revoked_at`, `revocation_reason` | `USER_REVOKED`, `SESSION_REVOKED`, `ROTATED`, `TRANSFERRED`, `INVALID_REGISTRATION`, `STALE` |

Database rules:
- Partial unique **one active row per (kind, hash)** and **one active row per session**.
- `auth_sessions` gets an additive `UNIQUE (id, user_id)`.
- **Trigger `trg_auth_sessions_revoke_push_devices`:** when any code path revokes a session, its active devices are revoked (`SESSION_REVOKED`) **in the same transaction**. This covers logout, logout-all, `DELETE /auth/sessions/:id`, refresh-token reuse, suspension, password change and password reset.
- **Trigger `trg_push_devices_guard_update`:** only `last_seen_at` and a one-way revocation can change; a revoked row can never be re-activated.
- No device fingerprint, IP, user agent or location is stored.

## 3. API (all require `Authorization: Bearer <accessToken>`; any role)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/api/push-devices` | `{ registrationKind, registrationValue, platform }` | `200 { result, device }` | 400 invalid / unknown fields; 401; 409 `REGISTRATION_TRANSFERRED` |
| GET | `/api/push-devices` | — | `200 device[]` (active devices of all my sessions, newest first) | 401 |
| DELETE | `/api/push-devices/:id` | — | `204` (idempotent for my own device) | 400 bad id; 401; 404 (also for another user's device) |

`device` = `{ id, platform, registrationKind, current, stale, registeredAt, lastSeenAt }`. Neither the value nor its hash is ever returned. `current` = registered by this session; `stale` = not re-registered within the stale threshold.

The user and session always come from the access token. A `userId` or `sessionId` in the body is rejected (400).

### `result` of POST (deterministic duplicate handling)

| Situation | Result |
|---|---|
| New destination for this session | `CREATED` |
| Same destination again (same session, same platform) | `REFRESHED` (same `id`, `lastSeenAt` updated) |
| This session registers a different value (new FID, or token → FID) | `ROTATED` (previous row revoked `ROTATED`) |
| Destination currently active for **another** session or account | `TRANSFERRED` (the other row revoked `TRANSFERRED`) |
| This session **lost** this destination to another account earlier | **409 `REGISTRATION_TRANSFERRED`**: a delayed request from the previous account cannot reclaim it |

## 4. Logout and account switching (backend guarantees)

- **Logout / logout-all / session revoke / password change / password reset / suspension:** the affected sessions' devices are revoked atomically by the trigger. Other sessions' devices are untouched by a single logout. Reactivation does not resurrect devices.
- **Shared browser, A logs out, then B logs in:** A's device was revoked at logout. A's old token gets 401. B's registration of the same FID is a plain `CREATED`.
- **Shared browser, A never logged out:** B's registration of the same FID is `TRANSFERRED`, A's row is revoked, and A's stale requests get 409. Only B can be targeted.
- **Send eligibility** (`findSendTargets`) additionally requires a live session (not revoked, not expired), an ACTIVE account and freshness. A missing or failed client-side cleanup therefore cannot leave a cross-account destination.
- Inbox notifications (P3-BE04) are never touched by device changes, and the inbox works without any push registration.

## 5. Concurrency

`POST` is one transaction:
1. Lock the caller's `auth_sessions` row `FOR UPDATE` (live session and ACTIVE account required).
2. `pg_advisory_xact_lock` on the destination hash.
3. Resolve refresh, transfer or rotation.
4. Insert.

Logout and other revocations update the same session row, so they serialize with registration. Either the registration commits first and the revocation trigger then revokes it, or the revocation commits first and the registration gets 401. Suspension takes user → sessions → devices; registration takes session → devices and never the user row, so the lock orders cannot form a cycle.

Verified on PostgreSQL across 2 instances:
- 10 concurrent identical registrations → 1 row;
- 2 accounts × 10 concurrent registrations of one FID (4 rounds) → never 2 active rows;
- registration racing logout, logout-all, password change, password reset and suspension (6 rounds each, both commit orders) → never an active device left on a revoked session;
- 0 deadlocks.

## 6. Stale and invalid destinations

- **Stale:** `PUSH_DEVICE_STALE_DAYS` (default **30**, matching FCM's default staleness of about a month). Devices not re-registered within it are shown `stale: true` and excluded from send targets. `revokeStale()` revokes them (`STALE`), but **no scheduler is installed**; run it from a job later if wanted. Clients should re-register on every start-up. Revoked rows older than 30 days are pruned on the user's next registration.
- **Invalid:** `markInvalid(deviceId, attemptedAt)` (for P3-BE06) revokes `INVALID_REGISTRATION` only if the row is still active and **was not re-registered after `attemptedAt`**. A rotated registration is a new row, so a late failure for an old id can never revoke a newer destination. It is idempotent.

### Firebase error handling rules for P3-BE06
| FCM HTTP v1 error | Action |
|---|---|
| `UNREGISTERED` (404) | `markInvalid(deviceId, attemptedAt)` |
| `INVALID_ARGUMENT` (400) | **Do not revoke** unless the same payload was accepted for other devices (the payload itself may be malformed); log and fix. |
| `SENDER_ID_MISMATCH`, `THIRD_PARTY_AUTH_ERROR` | Configuration problem: do not revoke; alert. |
| `QUOTA_EXCEEDED`, `UNAVAILABLE`, `INTERNAL`, timeouts | Transient: retry with backoff; **never revoke**. |

Push is best effort: a push may be missed or delivered more than once. The inbox row (P3-BE04) is the source of truth.

## 7. Internal API (P3-BE06)

Import `PushDevicesModule` and inject `PushDevicesService`:
- `findSendTargets(userId)` → `[{ deviceId, registrationKind, registrationValue, platform, lastSeenAt }]`. The value is decrypted; never log it. Send with `fid` for `FID` and `token` for `FCM_TOKEN`.
- `markInvalid(deviceId, attemptedAt, reason = 'INVALID_REGISTRATION')` → `{ revoked }`.
- `revokeStale(olderThanDays?)` → number revoked.

Registering a device never creates notifications.

## 8. Configuration and secrets

| Variable | Notes |
|---|---|
| `PUSH_REGISTRATION_KEYS` | `id2:<base64 32 bytes>,id1:<base64 32 bytes>`. The first key encrypts and every listed key decrypts. **Rotation:** prepend a new key and keep the old ones until every row has re-registered (rows show the key id). |
| `PUSH_REGISTRATION_HASH_KEY` | base64, ≥ 32 bytes. **Never rotate** (lookups and uniqueness depend on it); changing it requires a re-registration of all devices. |
| `PUSH_DEVICE_STALE_DAYS` | default 30 (1–365) |

- Both keys are **required when `NODE_ENV=production`**. In development and QA, when unset, they are derived from `JWT_SECRET` (startup warning). Generate keys with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- Never commit them; keep them separate per environment.
- **Firebase projects:** use one project per environment (dev / staging / prod). FE-048 needs the web config and VAPID key of its environment's project. P3-BE06 will need a service-account credential (environment secret or workload identity, never a committed JSON) for that same project. FIDs from one project are not valid in another.

## 9. Frontend handoff (FE-048)
Frontend responsibilities (the backend does not rely on them for security):
1. **Requirements:** HTTPS (or `localhost`), a `firebase-messaging-sw.js` at the site root, and the FCM Registration API enabled in the Google Cloud project.
2. **Flow:** after login, if the user enables notifications, call `Notification.requestPermission()`. If granted, `onRegistered(messaging, fid => POST /api/push-devices { registrationKind: "FID", registrationValue: fid, platform: "WEB" })` and `register(messaging, { vapidKey })`. On every app start-up while logged in, call `register()` again; the backend refreshes `lastSeenAt`.
3. **Permission denied or unsupported browser:** do nothing; the inbox and the unread badge work without push.
4. `onUnregistered` → `DELETE /api/push-devices/:id`, using the id from the last POST response.
5. **Logout:** call `POST /auth/logout` (the backend revokes the device). Optionally call `unregister(messaging)` so the browser stops receiving. Always log out before switching accounts.
6. **409 `REGISTRATION_TRANSFERRED`:** another account took over this browser. Clear local auth state and require login.
7. **Device management screen:** `GET /api/push-devices` with `current`, `stale`, `platform` and dates; "remove" = `DELETE /api/push-devices/:id`.
8. Never send `getToken()` and FID registrations from the same installation.

## 10. Deployment
- Migration `CreatePushDevices1796000000000` is additive: the table, indexes and triggers, plus `UNIQUE (id, user_id)` on `auth_sessions`. `down` removes all of it (registrations are lost; clients re-register on next start-up).
- Run the migration **before** starting the new build: the new code needs the table for `/api/push-devices`. The trigger is harmless for older builds.
- Production needs `PUSH_REGISTRATION_KEYS` and `PUSH_REGISTRATION_HASH_KEY`, or the app refuses to start.

## 11. Known limits
- No real Firebase project was used: registrations are format-checked, not verified with Firebase. Validity is learned at send time (P3-BE06).
- No cap on active devices per user (bounded by sessions: one per session).
- `revokeStale()` is not scheduled.
- A session that never logs out keeps its device until the session expires (30 days) or the device goes stale.
