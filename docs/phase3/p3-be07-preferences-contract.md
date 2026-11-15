# P3-BE07-01 — Notification Preferences: Policy & API Contract

Status: **design only (BE07-01)**. No application code, migration, Firebase or frontend change.

**Product decisions approved by the user (2026-11-09):**

- a global push preference per user;
- push disabled by default;
- no per-type preferences yet;
- opting in does not require a registered device;
- opting out does not delete device records;
- opting in again does not send older notifications;
- `pushAvailable` is exposed as a boolean;
- the inbox stays independent of push;
- in-flight Firebase sends cannot be recalled, and no bound is claimed on how many may still arrive.

The former open questions Q1–Q6 are therefore resolved (§10).

Roadmap requirements (P3-BE07, P1):

1. Persist user push opt-in/opt-out preferences.
2. Secure preference-management APIs.
3. Push delivery respects preferences.
4. The inbox is preserved even when push is disabled, denied or unsupported.

---

## 0. Repository state (blocking prerequisite for BE07-02)

| Ref | Commit | Contains P3-BE04 to BE06? |
|---|---|---|
| Working branch `feature/notification-preferences` (local) | `a66a59f` | **No.** `src/notifications`, `src/push-devices`, `src/push-delivery` do not exist |
| `origin/feature/notification-preferences` | `38c97ad` | No |
| `origin/dev` (verified with `git ls-remote`) | `a66a59f` | **No** |
| `origin/main` | `060f6c2` | No |
| `origin/feature/notification-inbox` | **`e06c6c8`** | **Yes** (BE04 `425daf5`, BE05 `a135ed7`, BE06 `90b0012` + `e06c6c8`) |

- The brief states BE06 was merged into the development branch. The repository does not reflect that yet: `feature/notification-inbox` is pushed but **not merged into `dev`**.
- `pet_care_db` (15 migrations, BE06 deployed) is therefore **ahead of this branch's code**. A backend built from `a66a59f` must not be run against it.
- **This audit was done read-only against `e06c6c8`** (`git show`), which is the code that is actually deployed to development.
- **Before BE07-02:**
  1. merge `feature/notification-inbox` into `dev` (PR);
  2. bring this branch up to date with `dev`;
  3. confirm `src/push-delivery` and the 15 migrations are present.

  This needs the user (branch operations are out of scope here).

## 1. Existing architecture audit (at `e06c6c8`)

| Area | Finding | Relevance for BE07 |
|---|---|---|
| **Inbox** (`NotificationsService`, `/notifications`, P3-BE04) | Rows created inside business transactions; recipient-scoped API (`list`, `unread-count`, `:id`, `:id/read`, `read-all`); no public create endpoint; content immutable | **Unchanged.** Preferences never touch inbox rows, unread counts or read state. |
| **Booking events** (`BookingEventsService`, BE06-03) | Writes inbox rows, then `PushOutboxService.enqueue` in the same transaction; enqueue is a no-op when `PUSH_DELIVERY_MODE=disabled` | **Unchanged** (§4.5). |
| **Push devices** (`PushDevicesService`, P3-BE05) | One active registration per auth session; FID / legacy token; rotation and transfer create new rows; logout / suspension / password reset revoke via trigger. `findSendTargets` and `isSendEligible` share one eligibility SQL (`SEND_ELIGIBLE_FROM_WHERE`: active device, live session of the same user, ACTIVE account, not stale). | Registration ≠ consent (§3.2). Eligibility rules stay; the preference is an **additional** gate. |
| **Outbox / worker** (BE06-02 / 05) | One job per notification; `JobExecutionOutcome` union `DELIVERED / NO_DESTINATIONS / RETRY / CONFIGURATION / TERMINAL / DISABLED`; retry policy in `decideTransition` | One new outcome kind (§4.2) |
| **Executor** (`PushDispatchExecutor`, BE06-06) | Per attempt: (1) provider disabled → DISABLED; (2) re-read the notification; (3) `finalizedDevices`; (4) `findSendTargets`; (5) per device: abort / deadline check → `isSendEligible` → `renewLease` → `provider.send` → fenced per-device row | **The integration point** (§4) |
| **Auth** | `JwtAuthGuard` checks the session on every request (P3-BE01); `@CurrentUser()` gives `{ id, role, sessionId }`; suspended or revoked sessions get 401 | Reused as is |
| **Conventions** | Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`; resources under `/api`; Swagger `@ApiTags` / `@ApiBearerAuth('access-token')`; the caller's identity only (no user ids in routes) | Followed by §5 |
| **Notification types** | 14 types (6 booking + payment / review / complaint / provider / system); **only the 6 booking types are produced today** | Per-type preferences are not needed now (§3.1) |
| **Users table** | Auth-critical row: role/status checks, row locks in suspension and session flows (P3-BE01 lock order user → sessions → tokens), safe admin projections | Do **not** add preference columns there (§6.1) |
| **Frontend** | `pet-care-web` has no Firebase code yet (FE-048 not started); the BE05 handoff tells the frontend to register a device once the user enables notifications | §7 replaces "enabling" with an explicit preference call |

**Smallest change set for BE07:**

- one table;
- one small module (service + controller, 2 endpoints);
- one executor gate (start of attempt + before each send);
- one new outcome kind;
- no change to the inbox, booking events, the outbox, device lifecycle, the provider or the retry/lease logic.

## 2. Four independent states

| # | State | Owner | Meaning | Authoritative for |
|---|---|---|---|---|
| 1 | **User preference** (`notification_preferences.push_enabled`) | Backend, per **user** | The user explicitly wants push | **Consent.** Without it, no push is sent, even if a device is registered and the browser allows it. |
| 2 | **Browser notification permission** (`Notification.permission`) | Browser, per **origin + browser profile** (shared by all accounts in that profile) | The browser may display notifications | Display capability only. The backend cannot see it; the frontend reflects it (§7). |
| 3 | **FCM device registration** (`push_devices`) | Backend, per **auth session** | A technical destination | Where to send, never whether. **A registration is not consent.** |
| 4 | **System push mode** (`PUSH_DELIVERY_MODE`, `PUSH_WORKER_ENABLED`) | Operator, per **environment** | Push delivery exists at all | Global availability. When disabled, no jobs are created and nothing is sent. |

A device receives a given notification **only if all of these hold at send time:**

1. **(4)** delivery is enabled;
2. **(1)** the recipient has `push_enabled = true`, **and** the notification was created at or after the latest opt-in (`notification.created_at >= push_enabled_at`);
3. **(3)** the device is send-eligible under the existing P3-BE05 rules.

State (2) is enforced by the browser and FCM; the frontend keeps (3) consistent with (2) (§7).

## 3. Preference policy

### 3.1 Scope: one global push switch per user

- `pushEnabled: boolean`, per user, covering all notification types.
- **No per-type preferences in BE07.** Only booking events produce notifications today. Per-type settings would add schema, UI and test surface without a product requirement.
- **Extension path:** a separate `notification_type_preferences (user_id, category, push_enabled)` table with categories (`BOOKING`, `PAYMENT`, …) mapped from `NOTIFICATION_TYPE_TARGETS`, evaluated after the global switch. No change to this contract.
- **Out of scope:** e-mail / SMS channels, quiet hours, digests.

### 3.2 Defaults: explicit opt-in

| Case | Default | Rationale |
|---|---|---|
| New users | `pushEnabled = false` | Push is consent-based. The browser asks for permission anyway, so asking is part of the same UI step (§7). Avoids treating a device registration as consent. |
| Existing users (migration) | `pushEnabled = false` — **no backfill rows**; a missing row means the default | At `e06c6c8` no client registers devices yet (FE-048 not started); `pet_care_db` has 0 active devices. Nobody is currently receiving push, so nobody silently loses it. |
| Device registered, no opt-in | No push | Rule (1) |
| Opt-in without a device | Stored; nothing sent until a device registers | Preferences and devices are independent |

**Decision (approved):** push is disabled by default (explicit opt-in).

### 3.3 Opt-in / opt-out semantics

- **Opt-in** (`false → true`):
  - sets `push_enabled = true` and `push_enabled_at = now()`;
  - **not retroactive:** notifications created before `push_enabled_at` are never pushed, including still-pending jobs (§4.3).
- **Repeated opt-in** (`true → true`): no change; `push_enabled_at` keeps its original value (idempotent).
- **Opt-out** (`→ false`):
  - sets `push_enabled = false` and `push_enabled_at = NULL`;
  - effective for every send that has not started (§4.4);
  - **does not revoke or delete devices.** The installation keeps its registration, so opting in again works immediately without re-registering. Logout still revokes devices (P3-BE05).
- **Inbox:** opting in or out never deletes, hides, or changes the read state or unread count of any notification.

### 3.4 Account switching and shared browsers

- **The preference belongs to the user** (`user_id`), not to the browser, installation or session.
- **Switching accounts never copies a preference.** User B starts with B's own stored value (default `false`), even though the browser permission (state 2) is shared and already granted by user A.
- P3-BE05 already guarantees that A's devices are revoked or transferred on logout or re-registration. Combined with rule (1), B gets no push until **B** opts in. A's pending jobs can never reach B's installation (BE06-06, verified).

## 4. Dispatcher integration (BE07-03 design; no worker change in BE07-01)

### 4.1 Where the gate is checked

Inside `PushDispatchExecutor.execute`, using a new read-only `NotificationPreferencesService.pushAllowed(userId, notificationCreatedAt): Promise<boolean>`:

```text
SELECT 1 FROM notification_preferences
 WHERE user_id = $1 AND push_enabled AND push_enabled_at <= $2
```

1. **At the start of every attempt**, after re-reading the notification (its `created_at` is added to that SELECT). Not allowed → return `SUPPRESSED`; no device lookup, no send.
2. **Immediately before each device send**, together with the existing `isSendEligible` (same position in `dispatchOne`, before `renewLease`). Not allowed → stop new sends this attempt; the aggregate is `SUPPRESSED`.

Per-device rows already written in the attempt stay (they are facts).

### 4.2 New outcome

- `JobExecutionOutcome` gains `{ kind: 'SUPPRESSED'; reason: 'PUSH_OPTED_OUT' }`.
- `decideTransition` maps it to **DONE** with `last_error_category = 'PUSH_OPTED_OUT'`, code `pawflow/push-opted-out` (category pattern `^[A-Z][A-Z_]{0,31}$` is satisfied).
- **Terminal and never retried:** a later opt-in must not resurrect old notifications.
- **No schema change** to `notification_deliveries`, and nothing in the lease, claim or retry machinery changes.

### 4.3 Scenario behaviour

| Scenario | Behaviour |
|---|---|
| Opted out before the job is claimed | Attempt start → `SUPPRESSED` → DONE. No send. |
| Opt-out between device selection and send | Per-device gate stops the remaining sends. Already-accepted devices stay recorded. Job DONE (`PUSH_OPTED_OUT`). |
| Opt-out during a retry (attempt ≥ 2) | Next attempt start → `SUPPRESSED`. Finalized device rows stay. No further sends. |
| Opt-in after the notification was created | `created_at < push_enabled_at` → `SUPPRESSED`. **No retroactive push**; the inbox already has it. |
| Opt-out then opt-in before a pending job is claimed | `push_enabled_at` moved past `created_at` → suppressed (consistent with "no retroactive sending") |
| Multiple devices, different browser permissions | The backend sends to every eligible device. A browser without permission cannot display it; a revoked web-push subscription ends up as `UNREGISTERED` → `markInvalid` (BE06). The frontend unregisters a device when permission becomes `denied` (§7). |
| Push disabled globally | No jobs are created (BE06-02). Preferences can still be read and changed; `pushAvailable: false` in the API. |
| No registered device | Allowed → `NO_DESTINATIONS` (existing) |
| Concurrent preference update and worker | Single-row upsert (§6.3); the worker reads the latest committed value at each gate (READ COMMITTED). No locks are shared with the worker. |
| Multiple backend instances | Stateless: the preference lives only in PostgreSQL. No process-local cache (or one with TTL ≤ the gate cost; not recommended). |

### 4.4 Unavoidable race

A send whose per-device gate passed before the opt-out committed **cannot be recalled** once it has been handed to Firebase. That includes sends still in flight, and sends FCM has accepted but not yet delivered (an offline device may receive them later, within the message TTL).

- **What is guaranteed:** no new send *starts* after the opt-out commit is visible to the gate (attempt start and per-device pre-send check).
- **What is not claimed:** any upper bound on how many already-dispatched pushes may still reach devices, or when.

This is the same class of limit as the documented BE06 logout race.

### 4.5 Why not filter at enqueue time

Enqueue runs inside the booking transaction; adding a preference read there couples booking writes to push consent. Filtering at send time alone is sufficient (the gate runs anyway on every attempt) and keeps the BE06-02/03 contract unchanged.

**Cost:** opted-out recipients still get a job that completes as `SUPPRESSED` on its first claim (a few cheap statements). Revisit only if job volume matters (retention, BE06-07 §7C).

## 5. API contract (BE07-02)

**Common to both endpoints:**

- **Auth:** `JwtAuthGuard` (Bearer, live session), any role. The identity comes **only** from the token.
- No user id in the path, query or body. Unknown fields get 400 (global `forbidNonWhitelisted`).
- Swagger: `@ApiTags('Notification preferences')`, `@ApiBearerAuth('access-token')`.

### `GET /api/notification-preferences`

Returns the caller's preferences. **Writes nothing:** a missing row is reported as the default.

`200`:

```json
{
  "pushEnabled": false,
  "pushEnabledAt": null,
  "pushAvailable": true,
  "updatedAt": null
}
```

| Field | Type | Meaning |
|---|---|---|
| `pushEnabled` | boolean | Stored consent (default `false`) |
| `pushEnabledAt` | string (ISO-8601) \| null | Instant of the current opt-in; null when disabled |
| `pushAvailable` | boolean | **As implemented (BE07-02):** `PUSH_DELIVERY_MODE === 'firebase'` **and** `PUSH_WORKER_ENABLED === true` on the serving instance. Mock and disabled modes, or a worker switched off, give `false`; mock is not real push. Lets the frontend hide or disable the toggle. Exposes no mode name, project id or other configuration. (BE07-01 had proposed `mode !== 'disabled'`; superseded, see §11.4.) |
| `updatedAt` | string \| null | Last change; null when never set |

Errors: `401` (missing / invalid / expired token or revoked session).

### `PATCH /api/notification-preferences`

Body (`UpdateNotificationPreferencesDto`):

```json
{ "pushEnabled": true }
```

- `pushEnabled`: **required** boolean (`@IsBoolean()`).
- No other fields. Strings like `"true"` are rejected (no implicit conversion).
- Response: `200`, the same body as GET (after the change).
- **Idempotent:** repeating the same value changes nothing (`pushEnabledAt` / `updatedAt` stay as they were when the value is unchanged).
- **Last write wins** across concurrent requests.

| Status | When |
|---|---|
| 200 | Updated, or already in the requested state |
| 400 | Missing or non-boolean `pushEnabled`, unknown fields (e.g. `userId`), invalid JSON |
| 401 | Not authenticated / session revoked |

- `PATCH` is allowed even when `pushAvailable` is false; the value applies once push is enabled.
- **Rate limiting:** not needed (cheap, idempotent, authenticated). Can be added with the existing P3-BE03 limiter if abuse appears.
- **Not provided:** admin endpoints to read or change other users' preferences.

## 6. Database design (migration in BE07-02; not created here)

### 6.1 Dedicated table vs `users` columns

| | `notification_preferences` table | Columns on `users` |
|---|---|---|
| Lock contention | Own row; never blocks the auth / suspension paths, which `FOR UPDATE` the user row | Each preference write locks the user row (P3-BE01 lock order) |
| Projections | Nothing to hide | Every user projection (admin lists, `/auth/me`) must be reviewed |
| Defaults for existing users | No backfill (missing row = default) | Column default + rewrite or validation on a hot table |
| Extensibility (per type, channels) | Natural | Grows the auth table |

→ **Dedicated table.**

### 6.2 Schema (proposed migration timestamp after `1796500000000`, e.g. `1797000000000-CreateNotificationPreferences`)

```sql
CREATE TABLE notification_preferences (
  user_id         bigint      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled    boolean     NOT NULL DEFAULT false,
  push_enabled_at timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_preferences_push_enabled_at
    CHECK (push_enabled = (push_enabled_at IS NOT NULL))
);
```

- **PK `user_id`:** one row per user (uniqueness), and the only lookup path. **No extra index.**
- **No backfill.** `down` drops the table (preferences lost; delivery falls back to "no push", the safe default).
- An entity with the same name, check and FK so the schema builder reports 0 pending DDL.

### 6.3 Update semantics

**As implemented (BE07-02):** one conditional atomic statement per request, plus a fresh read. This supersedes the single combined upsert proposed in BE07-01: a disable on a missing row must write nothing, and a repeated request must never touch `updated_at`.

```sql
-- enable: OFF/missing -> ON only; a repeated enable writes nothing
INSERT INTO notification_preferences AS p (user_id, push_enabled, push_enabled_at, updated_at)
VALUES ($1, true, now(), now())
ON CONFLICT (user_id) DO UPDATE
   SET push_enabled = true, push_enabled_at = now(), updated_at = now()
 WHERE NOT p.push_enabled
RETURNING p.user_id;

-- disable: ON -> OFF only; a repeated disable (or no row) writes nothing
UPDATE notification_preferences
   SET push_enabled = false, push_enabled_at = NULL, updated_at = now()
 WHERE user_id = $1 AND push_enabled
RETURNING user_id;

-- then: SELECT push_enabled, push_enabled_at, updated_at ... WHERE user_id = $1   (latest committed state)
```

- **Atomic and idempotent.** Concurrent PATCHes serialize on the primary-key row lock: **the last write applied by PostgreSQL wins**. `ON CONFLICT` prevents duplicate rows.
- No explicit transaction, advisory lock or distributed lock.
- The response is the latest committed state, which may already include a concurrent request's effect. It is always internally consistent (CHECK).
- A user deleted concurrently → FK violation. Practically impossible, because the session check fails first.

## 7. Frontend handoff (FE-048 / settings UI)

1. **Settings toggle "Push notifications":**
   - render from `GET /notification-preferences`;
   - hide or disable it when `pushAvailable` is false, or when the browser lacks `Notification` / service worker / Push API support.
2. **Turning on:**
   - (a) `Notification.requestPermission()`;
   - (b) only if `granted`: `PATCH { pushEnabled: true }`, then register the device (`register()` / `onRegistered()` → `POST /push-devices`, BE05 handoff);
   - (c) if `denied` / `default`: do **not** PATCH true; show "blocked in browser settings".
3. **Turning off:** `PATCH { pushEnabled: false }`. Optionally `unregister()` the device locally. The backend does not require revoking it.
4. **Permission revoked in the browser** (`permission !== 'granted'` on start-up): call `DELETE /push-devices/:id` for the current device (from `GET /push-devices`, `current: true`). Do **not** change the preference automatically; show the mismatch.
5. **Account switching:**
   - always log out first (revokes the device);
   - after the next login, read **that** user's preference;
   - never reuse the previous user's toggle state, even though the browser permission is already granted.
6. **Inbox and badge:** unchanged. Keep polling `unread-count` whether or not push is on.
7. **Never send a user id;** the API ignores and refuses it.

## 8. Security and concurrency considerations

- **Authorization:** caller-only, via the token and a live session. There is no way to read or change another user's preference (no id parameter; unknown fields refused).
- **Consent:** a registration alone never enables push. The default is no push.
- **Privacy:** the preference response holds no device data and no configuration beyond one boolean.
- **Account isolation:** preferences are keyed by user. P3-BE05 handles the shared-installation case. The gate checks the job's recipient.
- **Concurrency:** single-row upserts; the worker gates are read-only and re-checked per attempt and per device. No new locks in the worker path, so no new deadlock surface.
- **Race (documented):** pushes already handed to Firebase before the opt-out may still arrive; no bound is claimed (§4.4). No new send starts after the opt-out is visible to the gate.
- **Failure mode (as built, BE07-03):** if the preference read fails or times out (5 s), the executor returns `RETRY TRANSIENT pawflow/consent-unavailable` (`ambiguous: false`, because nothing was sent). The job stays `PENDING` with the normal backoff and is never sent without a successful gate. **Fail closed.** See `p3-be07-dispatch-integration.md` §3.

## 9. Test acceptance matrix

### BE07-02: API and persistence (unit + PostgreSQL / HTTP QA)

| # | Test | Expected |
|---|---|---|
| A1 | New user `GET` | `pushEnabled false`, `pushEnabledAt null`, `updatedAt null`; **no row written** |
| A2 | Existing user (no row) after migration | Same as A1; migration up/down; 0 pending DDL; other tables unchanged |
| A3 | `PATCH true` | 200; `pushEnabled true`, `pushEnabledAt ≈ now`; row exists |
| A4 | `PATCH true` again | 200; `pushEnabledAt` / `updatedAt` unchanged |
| A5 | `PATCH false` | 200; `pushEnabled false`, `pushEnabledAt null` |
| A6 | Opt out → opt in | New `pushEnabledAt` > previous |
| A7 | Validation | Missing field / `"true"` / `1` / `null` / `userId` / unknown field → 400; nothing written |
| A8 | Authorization | No token / bad token / revoked session / suspended user → 401 |
| A9 | Isolation | A's PATCH never changes B; B's GET shows B's own value |
| A10 | Concurrency | 20 concurrent PATCHes (mixed values, 2 instances) → 200 each; one row; final state equals one of the requests; check constraint holds |
| A11 | Inbox untouched | Opt-out / opt-in leave the notification list, unread count and read state identical |
| A12 | Devices untouched | Opt-out does not revoke `push_devices` rows |
| A13 | `pushAvailable` | false with mode disabled, true with mock |
| A14 | Account switch | A opts in, logs out; B logs in on the same "browser" → B `pushEnabled false` |
| A15 | User deletion | Preference row cascades |

### BE07-03: dispatcher (unit + PostgreSQL QA with the mock provider and controlled clock)

| # | Test | Expected |
|---|---|---|
| D1 | Opted out (or no row) before claim | Job DONE `PUSH_OPTED_OUT`; 0 sends; 0 device rows |
| D2 | Opted in, device eligible | Unchanged BE06 behaviour (`DELIVERED`) |
| D3 | Opt-out between selection and send (gated provider) | Remaining devices not sent; earlier rows kept; DONE `PUSH_OPTED_OUT` |
| D4 | Opt-out during a retry (device B transient on attempt 1) | Attempt 2 suppressed; A's row kept; B never sent again |
| D5 | Opt-in after notification creation | Pending job suppressed; no retroactive push |
| D6 | Opt-out → opt-in before claim | Suppressed (`created_at < push_enabled_at`) |
| D7 | Opted in, no device | `NO_DESTINATIONS` |
| D8 | Push disabled globally | No job; preference API still works |
| D9 | Account switch (A opted in; installation moves to B, who is not opted in) | A's job sends nothing to the installation; B's job suppressed |
| D10 | Two worker instances, mixed preferences | Opted-in recipients delivered once per device; opted-out never; 0 deadlocks |
| D11 | Preference read fails (injected) | Executor error → ambiguous transient retry; no send |
| D12 | In-flight race | Documented; a test asserts no send *starts* after the opt-out commit (beyond the in-flight window) |
| D13 | Inbox | Unaffected in every scenario |
| D14 | Regression | `qa:push-dispatch`, `qa:push-worker`, `qa:push-pipeline`, `qa:booking-events`, `qa:push-devices`, `qa:notifications`, `npm test`; existing suites need the recipient opted in during setup |

**Note for BE07-03:** existing BE06 QA (`push-dispatch`, `push-pipeline`) creates users without preferences. With default false they would all become `SUPPRESSED`, so their setup must opt users in (via API or SQL). This is an expected, documented test change, **not** an assertion weakening.

## 10. Decisions (approved 2026-11-09) and assumptions

| # | Item | Proposed default |
|---|---|---|
| Q1 | Default | **Approved:** push disabled by default (explicit opt-in), for new and existing users (§3.2) |
| Q2 | Per-type preferences | **Approved:** none yet; one global switch per user (§3.1) |
| Q3 | Does opt-in require a registered device? | **Approved:** no (§3.2) |
| Q4 | Does opt-out delete or revoke devices? | **Approved:** no, device records are kept (§3.3) |
| Q5 | Does opting in again send older notifications? | **Approved:** no (§4.3) |
| Q6 | Expose `pushAvailable`? | **Approved:** yes, a boolean only (§5) |
| Q7 | Inbox independence | **Approved:** the inbox never depends on push or preferences (§3.3) |
| Q8 | In-flight sends | **Approved wording:** they cannot be recalled; no maximum is claimed (§4.4) |
| A1 | Branch | BE07-02 starts only after BE04–BE06 are on this branch (§0) |
| A2 | Data | Development has 0 active devices, so the default-false migration changes nobody's current push |

---

## 11. Implementation record (BE07-02, 2026-11-09)

### 11.1 Files

- `src/notification-preferences/`:
  - `entities/notification-preference.entity.ts`
  - `dto/notification-preferences.dto.ts`
  - `notification-preferences.service.ts`
  - `notification-preferences.controller.ts`
  - `notification-preferences.module.ts` (registered in `AppModule`)
  - `notification-preferences.spec.ts`
- Migration `src/database/migrations/1797000000000-CreateNotificationPreferences.ts`, class `CreateNotificationPreferences1797000000000`, ordered after `1796500000000`.
- QA: `test/qa/notification-preferences.cjs` (`npm run qa:notification-preferences`).

### 11.2 Final schema (verified on a disposable database)

| Column | Type | Null | Default |
|---|---|---|---|
| `user_id` | bigint | no | — (PK `pk_notification_preferences`) |
| `push_enabled` | boolean | no | `false` |
| `push_enabled_at` | timestamptz | yes | — |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()` |

Constraints:

- `fk_notification_preferences_user`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`;
- `chk_notification_preferences_push_enabled_at`: `CHECK (push_enabled = (push_enabled_at IS NOT NULL))`.

No other index (the PK is the only access path). **No backfill:** a missing row means OFF. `down` drops the table.

### 11.3 API (as built)

`GET /api/notification-preferences` → 200. Never writes. With no stored preference, in an environment without real push:

```json
{ "pushEnabled": false, "pushEnabledAt": null, "pushAvailable": false, "updatedAt": null }
```

`PATCH /api/notification-preferences` with body `{ "pushEnabled": true }` → 200 with the complete state, e.g.:

```json
{ "pushEnabled": true, "pushEnabledAt": "2026-11-09T15:12:03.512Z", "pushAvailable": false, "updatedAt": "2026-11-09T15:12:03.512Z" }
```

- **Validation (DTO `UpdateNotificationPreferencesDto`):** `@IsDefined() @IsBoolean() pushEnabled`. The global pipe has implicit conversion **disabled**, so these give 400:
  - missing field, `null`, `"true"` / `"false"`, `1` / `0`, an array;
  - unknown properties `userId` / `role` / `pushEnabledAt` (`forbidNonWhitelisted`).
- **Auth:** `JwtAuthGuard` (session checked on every request). 401 for missing, invalid or revoked tokens, and for suspended or inactive accounts (their sessions are rejected). Any role. No admin override. The user id comes only from the token.
- **Swagger:** tag `Notification preferences`, Bearer `access-token`, documented response schema, 400 / 401 descriptions.

### 11.4 `pushAvailable`

`pushAvailable = (PUSH_DELIVERY_MODE === 'firebase') && PUSH_WORKER_ENABLED === true`. Both come from trusted backend config, through the existing BE06 loaders `loadPushDeliveryConfig` / `loadPushWorkerConfig`, evaluated once at start-up.

| Environment | `pushAvailable` |
|---|---|
| unset / `disabled` | false |
| `mock` (with or without worker) | false (mock is not real push) |
| `firebase`, worker off | false |
| `firebase`, worker on | **true** |

- Never inferred from the user's preference, the browser permission, devices or client input.
- The environment never changes the stored preference.
- **Multi-instance caveat:** the value is per serving instance. A deployment that runs the worker only on dedicated instances would report `false` on API-only instances. Keep `PUSH_WORKER_ENABLED` consistent across instances, or add an explicit availability setting if that topology is ever used.

### 11.5 State machine and consent epoch

| Current | Request | Result | Writes |
|---|---|---|---|
| missing / OFF | enable | ON, new `pushEnabledAt = now()` | insert or update |
| ON | enable | ON, **original** `pushEnabledAt` kept | none |
| ON | disable | OFF, `pushEnabledAt = null` | update |
| OFF / missing | disable | OFF | none (no row created) |
| OFF after an earlier opt-in | enable | ON, **new** `pushEnabledAt` | update |

- `pushEnabledAt` is the start of the **current continuous opt-in period**. `updatedAt` changes only on real transitions.
- **Clock:** both `pushEnabledAt` and `notifications.created_at` are PostgreSQL `now()` (the transaction start time of the writing statement or transaction). Neither ever uses the app clock.
- **Boundary rule for BE07-03:** push a notification only if `optedIn && notification.created_at >= optedInSince`.
  - Inclusive `>=`: an exactly equal timestamp counts as inside the period. Microsecond resolution, same clock.
  - Because `created_at` is the **start** of the booking transaction, a notification whose transaction began before the opt-in statement is treated as pre-consent and not pushed, even if it committed later.
  - That is the conservative direction. It is the smallest safe resolution and needs no schema change.

### 11.6 Internal service for BE07-03 (`NotificationPreferencesService`, exported by `NotificationPreferencesModule`)

```ts
getForUser(userId: string): Promise<{ pushEnabled: boolean; pushEnabledAt: Date | null; updatedAt: Date | null }>
updateForUser(userId: string, pushEnabled: boolean): Promise<same>
getPushConsentForDelivery(userId: string): Promise<{ optedIn: boolean; optedInSince: Date | null }>
getPushConsentForNotification(userId: string, notificationId: string): Promise<{ optedIn: boolean; inCurrentEpoch: boolean } | null>  // BE07-03, used by the dispatcher
readonly pushAvailable: boolean
```

- `getPushConsentForDelivery` is a fresh read with no cache. It is intended for the BE07-03 gate (attempt start and before each send; §4).
- The dispatcher is **not** changed in BE07-02.

### 11.7 Verification (BE07-02)

| Check | Result |
|---|---|
| `notification-preferences.spec.ts` (DTO with the real global pipe options, `pushAvailable` matrix, state machine, `now()` usage, consent API, logging, controller mapping) | 24/24 |
| Focused Jest (preferences + notifications + push devices + push delivery) | 7 suites, 217/217 |
| `qa:notification-preferences` (disposable PostgreSQL, 2 instances, all 25 required scenarios + roles + no-5xx + deadlocks) | **30/30** |
| tsc / build | clean |
| lint | 0 errors, 1 pre-existing warning |

The affected-suite results are recorded in `p3-be07-progress.md`.

**QA evidence:**

- 30 concurrent mixed PATCHes: one row, every response consistent with the CHECK, final state equal to GET.
- 20 concurrent enables: one row, one shared consent timestamp.
- Constraints: 23514 both ways (also on UPDATE), 23503 unknown user, 23505 duplicate; cascade on user deletion.
- Validation: 10 invalid bodies → 400.
- Suspended account: token 401 and new login refused.
- Account switch: no sharing between accounts.
- Inbox list, unread count and stored rows unchanged by opt-out / opt-in; the registered device is not revoked.
- No secrets in logs (35 values checked).

## 12. Implementation record (BE07-03, 2026-11-09)

The dispatcher integration is documented in `p3-be07-dispatch-integration.md`. It differs from the §4.1 sketch as follows:

- **Consent read.** The gate uses `getPushConsentForNotification(userId, notificationId)`, not `pushAllowed(userId, createdAt)` or `getPushConsentForDelivery`.
  - The rule `push_enabled AND created_at >= push_enabled_at` is evaluated in PostgreSQL.
  - Passing a JS `Date` would lose the microseconds and could let a notification created just before the opt-in through.
- **Boundaries.** Boundary B runs before the P3-BE05 `isSendEligible` check (consent first, then eligibility, lease, deadline, abort, send).
- **Fail closed.** A consent read error or timeout (5 s) returns `RETRY TRANSIENT pawflow/consent-unavailable`. It is never treated as permission and never as `PUSH_OPTED_OUT`.
- **Aggregate priority.** An authoritative opt-out in the same attempt outranks retryable failures (§4.2 unchanged otherwise).
- **§4.4 race:** as written; verified in QA (in-flight send completes; stale-lease result not recorded). No upper bound is claimed.
