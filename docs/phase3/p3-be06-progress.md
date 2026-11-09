# P3-BE06 — Progress / Session Handoff

| Subtask | Scope | Status |
|---|---|---|
| **BE06-01** | Booking event contract and notification mapping (audit and docs only) | **DONE (2026-11-09)** |
| **BE06-02** | Transactional outbox foundation (schema, migration, internal enqueue API) | **PASS (2026-11-09)**. Not committed, not deployed. |
| **BE06-03** | Booking events into inbox + outbox | **PASS (2026-11-09)**. Not committed, not deployed. |
| **BE06-04** | Firebase provider adapter (disabled / mock / firebase) | **PASS (2026-11-09)**. Not committed, not deployed. |
| **BE06-05** | Durable delivery worker and retry state machine (no executor) | **PASS (2026-11-09)**. Not committed, not deployed. |
| BE06-06 | Delivery executor: devices, provider, per-device outcomes (assumed) | NOT STARTED (wait for an explicit prompt) |
| BE06-08 | Development migration preflight | NOT STARTED |

## BE06-01 (done)

- **Baseline:** branch `feature/notification-inbox`, HEAD `a135ed7`, 14 migrations.
- **Deliverable:** [p3-be06-event-contract.md](p3-be06-event-contract.md)
- **Decisions:**
  1. No new booking states; there are 6 transitions (T1–T6).
  2. Event matrix E1–E6. Creation and cancellation go to the provider owner + ACTIVE staff. Confirm, reject, complete and no-show go to the customer. The actor is excluded.
  3. `eventKey = booking:{bookingId}:log:{statusLogId}`.
  4. Notifications are written in the booking transaction (atomic).
  5. The payload is display-only.
  6. Inbox rows are written even for non-ACTIVE recipients.
  7. P3-BE04 and P3-BE05 APIs are reused unchanged.

## BE06-02 (PASS)

Details: [p3-be06-outbox.md](p3-be06-outbox.md).

### Draft recovery (interrupted earlier attempt)

- **Snapshot (outside the repo):** `D:/ARGGGG/THESIS/pawflow-db-backups/p3be06/draft-snapshot-20261109-142430/`
  - `tracked.patch`: binary diff of the 5 modified tracked files against `a135ed7`. SHA-256 `2e5f21fc…add285`.
  - `files/`: full copies of all 17 changed or untracked files.
  - `MANIFEST.md`: per-file SHA-256 checksums.
  - **Verified:** every copy was byte-identical to the working tree, and `git apply --check` of the patch passed on a clean export of HEAD.
  - **Restore:** `git apply tracked.patch`, then copy the untracked files from `files/`.
- **Disposition after review:**
  - **Reused, then reworked:** the migration name and timestamp, the job-per-notification table shape (lease, attempt and next-attempt columns, partial indexes), and the `ON CONFLICT DO NOTHING` enqueue pattern.
  - **Fixed relative to the draft:**
    - the recipient was not tied to the notification; now a composite FK;
    - there was no database transition guard; now a trigger;
    - there was no delivery deadline; `expires_at` added;
    - free-text error code; now pattern-restricted;
    - enqueue was silently partial when an id was missing; now all-or-nothing;
    - enqueue was not forced into a transaction;
    - insert order was nondeterministic (deadlock).
  - **Removed from the working tree** (deferred; preserved in the snapshot):
    - `notification_push_sends` and its entity (BE06-05);
    - worker, mock and Firebase providers, admin stats controller (BE06-04/05);
    - `BookingEventsService` and the edits to `bookings.service.ts` / `bookings.module.ts` (BE06-03);
    - the `firebase-admin` dependency (`npm prune`; package files restored to HEAD);
    - `test/qa/push-delivery.cjs` (its QA never completed).
  - None of the draft's earlier test results count as verification.

### Implemented

- `src/push-delivery/push-delivery.config.ts`: `PUSH_DELIVERY_MODE` (disabled, mock or firebase; explicit in production; mock refused in production) and `PUSH_DELIVERY_TTL_SECONDS`.
- `src/push-delivery/entities/notification-delivery.entity.ts`, `push-outbox.service.ts`, `push-delivery.module.ts` (registered in `src/app.module.ts`).
- `src/database/migrations/1796500000000-CreateNotificationDeliveries.ts`.
- `src/notifications/entities/notification.entity.ts`: entity metadata for the new `uq_notifications_id_recipient`.
- Tests: `src/push-delivery/push-outbox.spec.ts`; `test/qa/push-outbox.cjs`, with npm script `qa:push-outbox`.
- `.env.example`: push outbox variables.

### Decisions

1. **Granularity:** one job per notification (recipient). Devices are resolved at send time. Per-device outcomes go in a BE06-05 child table, `UNIQUE (delivery_id, push_device_id)`.
2. **Statuses:** `PENDING`, `PROCESSING`, `DONE`, `FAILED`, `EXPIRED`. Legal transitions are enforced by a trigger, and terminal rows are immutable.
3. **Push disabled:** no job is written, so nothing old is sent when push is enabled later. **Mode enabled but delivery unavailable:** jobs wait, but only until `expires_at` (TTL, default 24 h); after that they are EXPIRED and never sent.
4. **Enqueue** requires the caller's transaction. It is all-or-nothing, idempotent, and inserts in ascending id order to stay deadlock-free.

### Verification

| Check | Result |
|---|---|
| Unit `push-outbox.spec.ts` | 22/22 |
| PostgreSQL `qa:push-outbox` | 28/28, 4 consecutive runs on the final code |
| `npm test` | 49 suites, 1422/1422 |
| `qa:notifications` | 43/43 |
| `qa:push-devices` | 49/49 |
| tsc, build | clean |
| lint | 0 errors; 1 pre-existing warning |

**Defect found and fixed during QA:** concurrent overlapping batch enqueues could deadlock (`40P01`).

### Open items

- **Leftover database `pawflow_qa_push_delivery`.** Inspected read-only:
  - owner `postgres`, 0 connections, ~10 MB;
  - created 2026-11-09 10:40 (+07), which matches the interrupted run;
  - 13/13 users are `@qa.test`; it contains the **old draft schema**.
  - It is verified disposable but **not dropped**, because deletion was not explicitly authorized. To drop it: `DROP DATABASE pawflow_qa_push_delivery;` (on the `postgres` maintenance database).
- **Product decision R3** (reject/cancel reason in notifications): still open, default no.
- **Confirm the subtask split** for BE06-03 to BE06-08.

### Next subtask (after BE06-02)

**BE06-03.** Done; see below.

**Dependencies BE06-03 can rely on:**

- `PushOutboxService.enqueue(manager, ids)` from `PushDeliveryModule`;
- `NotificationsService.createMany(inputs, manager)` (P3-BE04);
- the BE06-01 matrix and event key.

## BE06-03 (PASS)

The old interrupted draft was **not** restored. BE06-03 was written fresh on top of BE06-02, and the pending migration `1796500000000` is unchanged. **No new migration** was needed.

### Implemented

- **`src/bookings/booking-events.service.ts`**: `BookingEventsService.record(manager, { bookingId, statusLogId, newStatus, actorUserId })`. It returns `BookingEventResult`: `{ eventType, eventKey, recipientUserIds, notificationIds, createdNotificationIds, outbox }`.
  - `BOOKING_EVENT_RULES` holds the BE06-01 matrix, and `bookingEventKey()` builds `booking:{bookingId}:log:{statusLogId}`.
  - **Recipients:** one SQL read inside the caller's transaction (booking → customer, or provider owner + `provider_staff.status='ACTIVE'`). The actor is excluded and the set is deduplicated. Nothing comes from request input.
  - It calls `NotificationsService.createMany(inputs, manager)` and passes only `created === true` ids to `PushOutboxService.enqueue(manager, ids)`.
  - It never opens a transaction. Invalid input (an id that is not persisted, an unknown status) or an unknown booking throws `BookingEventError`, which aborts the transition.
- **`src/bookings/bookings.service.ts`**: `BookingEventsService` is a **required** constructor dependency, deliberately not `@Optional`, so it can never be silently skipped. It is called right after each status-log insert, with the same `manager`:
  - `insertBooking` (both create paths);
  - `confirmProviderBooking`;
  - `cancelMyBooking`;
  - `rejectProviderBooking`;
  - `transitionConfirmedProviderBooking` (COMPLETED and NO_SHOW).
  - The only other change is that each status-log `save()` result is now captured. Guards, locks, DTOs, views, idempotency keys and payment flows are unchanged.
- **`src/bookings/bookings.module.ts`**: imports `NotificationsModule` and `PushDeliveryModule`, and provides `BookingEventsService`.
- **Tests:**
  - `src/bookings/booking-events.service.spec.ts` (22);
  - `bookings.views.spec.ts` +6 (call order: status log → event → response view, inside the transaction; a guard rejection records no event);
  - the 3 direct-construction specs pass an event stub;
  - `test/qa/booking-events.cjs`, npm script `qa:booking-events`.

### Verified event mapping (PostgreSQL QA)

| Event | Recipients observed |
|---|---|
| E1 BOOKING_CREATED | owner + 2 ACTIVE staff (the INACTIVE staff member, the customer and unrelated users are excluded); a staff member hired later is included in later events |
| E2 BOOKING_CONFIRMED | customer |
| E3 BOOKING_REJECTED | customer ("Booking declined") |
| E4 BOOKING_CANCELLED | owner + ACTIVE staff |
| E5 BOOKING_COMPLETED | customer |
| E6 BOOKING_NO_SHOW | customer |

All six use `target BOOKING/{id}`, the key `booking:{id}:log:{statusLogId}`, and the payload `{bookingId, status, serviceName, petName, slotDate, startTime}`.

### Transaction and deduplication guarantees (verified)

- **Atomic.** If the notification insert fails, or the outbox insert fails (push enabled), the request returns **500** and the booking status, status log, slot capacity, inbox rows and jobs are all unchanged. This holds for both creation and transitions. Retrying afterwards produces exactly one event.
- **No duplicates.**
  - An Idempotency-Key replay creates no notification.
  - Reusing a key with a different payload gets 409 and creates nothing.
  - 9 concurrent confirms (owner + 2 staff, 2 instances): one 201, eight 409, exactly one `BOOKING_CONFIRMED`.
  - There is at most one job per notification.
- **Unauthorized transitions** (another provider, another customer, a customer on the provider route) return 403/404 and create nothing.
- **Push disabled** (the development default): inbox only, 0 jobs. **Push mock** (QA only): one `PENDING` job per new notification, recipient = notification recipient, TTL applied. No worker or provider activity; no Firebase call happens during the booking transaction.
- **Free-text reasons** (reject, cancel, no-show; test text containing a phone number and an e-mail address) appear only in `booking_status_logs`. They are never in a notification title, body or payload.
- **Self-action.** A customer later hired as staff who confirms their own booking gets no notification about their own action.
- **Concurrency vs suspension:**
  - 8 rounds of confirm ∥ suspend-the-customer: every request finishes in 27–57 ms; the booking is CONFIRMED, the customer SUSPENDED, with exactly one notification and one job.
  - 6 rounds of create ∥ suspend-the-provider-owner: 30–38 ms, and the owner is notified exactly once.
  - Each request has a 15 s cap. `pg_stat_database.deadlocks` stayed 0 → 0, and no `40P01` appears in the app logs.
- **Invariants checked at the end:**
  - 0 unrelated recipients;
  - 0 duplicate (recipient, event) pairs;
  - every booking event key maps to a status log, and every status log produced its event (except the self-action case);
  - 0 job/notification recipient mismatches.

### QA results (BE06-03)

| Check | Result |
|---|---|
| `booking-events.service.spec.ts` | 22/22 |
| All booking specs | 7 suites, 256/256 |
| `npm test` (run because `BookingsService` constructor and module wiring changed) | 50 suites, 1450/1450 |
| `qa:booking-events` (disposable `pawflow_qa_booking_events`) | **32/32** |
| `qa:notifications` | 43/43 |
| `qa:push-outbox` | 28/28 |
| `qa:mvp-e2e` (run because the booking module changed; booking projections, authorization, retry/concurrency, payments) | 110/110 |
| tsc, nest build | clean |
| lint | 0 errors; 1 pre-existing warning |

The first `qa:booking-events` run had 4 failures in phase B. They were a **test-expectation bug**: a staff member hired earlier in the run correctly became a recipient of later events, and the test had hard-coded 3 recipients. The expectations now follow the actual provider side. The product behaviour was correct.

### Deviations from BE06-01

**None.** The matrix, key, recipients, payload, transaction placement and atomic-failure policy are as specified. The contract document is unchanged.

The only refinement concerns dependency injection. The contract mentioned `@Optional()` as one option; `BookingEventsService` is **required** instead, so a wiring error cannot silently drop events. The 3 specs that construct `BookingsService` directly now pass a stub.

### Remaining risks

1. Notification and outbox failures now abort booking transitions (accepted policy). Any future schema or trigger change on `notifications` or `notification_deliveries` must keep booking tests in its regression.
2. Each transition adds one join query plus 1–N small inserts inside the booking transaction (N = 1 + ACTIVE staff count). This was negligible in QA (about 30 ms end to end per request).
3. `pet.name` and `service.name` are user-entered display data. They are shown only to the booking's own parties, as in the existing booking views.
4. With `PUSH_DELIVERY_MODE` set to `mock` or `firebase` before a worker exists, jobs accumulate as `PENDING` until they are expired by the BE06-04 worker. Keep development on `disabled`, which is the default.
5. The leftover database `pawflow_qa_push_delivery` (old draft schema) is still present, awaiting authorization to drop it. BE06-03 QA left no new databases behind.

### BE06-04 dependencies

- **Jobs:** `notification_deliveries` rows are `PENDING`, `attempt_count 0`, `expires_at = created + TTL`, one per notification, with recipient = notification recipient.
- **Claim:** `FOR UPDATE SKIP LOCKED` with leases. Every completion must be lease-fenced. Past the deadline → `EXPIRED`, never sent. Allowed transitions are as listed in `p3-be06-outbox.md` §5, and the database trigger enforces them.
- **Content** is re-read from `notifications` (title, body, target) at send time. Destinations come from P3-BE05 `findSendTargets(recipientUserId)` with a per-device eligibility re-check, and `markInvalid` is used only for UNREGISTERED.
- **No change is needed in BookingsService or BookingEventsService** for the worker.

### Next subtask (after BE06-03)

**BE06-04.** Done; see below.

## BE06-04 (PASS)

Details: [p3-be06-firebase-provider.md](p3-be06-firebase-provider.md).

The provider adapter only. **No** worker, job claiming, retries, destination selection, `markInvalid` or migration. `BookingsService`, `BookingEventsService`, `NotificationsService` and `PushOutboxService` were not modified.

### Files

- **New:** in `src/push-delivery/provider/`: `push-provider.types.ts`, `fcm-message.ts`, `firebase-error.ts`, `push-providers.ts`, `push-provider.spec.ts`. Also `docs/phase3/p3-be06-firebase-provider.md`.
- **Modified:**
  - `src/push-delivery/push-delivery.config.ts`: adds `FIREBASE_PROJECT_ID` and `PUSH_SEND_TIMEOUT_MS`; `staging` is treated like `production`.
  - `src/push-delivery/push-delivery.module.ts`: `PUSH_PROVIDER` factory and export.
  - `src/push-delivery/push-outbox.spec.ts`: 4 config expectations updated for the 2 new fields and `firebase` requiring a project id. The outbox logic is unchanged.
  - `package.json` / `package-lock.json`: `firebase-admin@^14.5.0`, updated together.
  - `.env.example`: Firebase and timeout variables, plus a credentials note.
  - `.gitignore`: service-account key file patterns.

### Decisions

1. **Destination kinds** reuse P3-BE05 `RegistrationKind`: `FID → fid` (`FidMessage`) and `FCM_TOKEN → token` (deprecated `TokenMessage`). They are never interchanged, and a malformed value gives `INVALID_REQUEST`.
2. **`send()` never throws.** Its typed outcomes are `ACCEPTED`, `INVALID_DESTINATION`, `INVALID_REQUEST`, `INVALID_PAYLOAD`, `RATE_LIMITED`, `TRANSIENT` (with an `ambiguous` flag), `CONFIGURATION` and `DISABLED`.
3. **Only `INVALID_DESTINATION` may lead to device revocation.** It covers `registration-token-not-registered` and SDK 14's FID-specific `installation-id-not-registered`. Generic `INVALID_ARGUMENT` becomes `INVALID_REQUEST` and never revokes. Unknown errors become `TRANSIENT` + ambiguous.
4. **Credentials** come from Application Default Credentials only. PawFlow never reads a credential file or path. The Firebase app is lazy (created on the first send) and is a single named, reused app.
5. **Payload:** only the notification's title, body, id, type and target, plus at most 8 validated string extras. Reserved and sensitive keys and URLs are refused, and the payload must be ≤ 4096 bytes. A tag / collapse id per notification makes duplicates replace each other on the device.
6. **The mock** is in memory, deterministic by destination prefix, records fingerprints only, and has no control endpoint.

### Verification

| Check | Result |
|---|---|
| `push-provider.spec.ts` (all 24 required cases) | 60/60 |
| `push-outbox.spec.ts` | 22/22 |
| Boot smoke on a disposable database: disabled, mock, firebase with fake project and no credentials (boots, nothing initialized); production + mock refused with the push-config error | 7/7 |
| `qa:push-outbox` | 28/28 |
| `qa:booking-events` | 32/32 |
| tsc, nest build | clean |
| lint | 0 errors; 1 pre-existing warning |

**Not run:** the full 1450-test Jest regression. It was not needed, because no booking, notification or outbox source changed. Boot and PostgreSQL QA confirm the wiring.

### Remaining limitations

- No live call to a real Firebase project has been made. That needs operator-provided non-production credentials (BE06-08 or later).
- `npm audit` total is 36 (was 33): 3 moderate findings in transitive Google libraries pulled in by `firebase-admin`.
- `ACCEPTED` means accepted by FCM, not delivered to the device.

### BE06-05 dependencies

- **Inject `PUSH_PROVIDER`** (`PushProvider`) from `PushDeliveryModule`.
- **Per job:**
  - re-read the notification and build a `PushMessage` from it (with `ttlSeconds` = remaining time to `expires_at`);
  - get destinations from `findSendTargets` and re-check each device before sending.
- **Per device outcome:**
  - `ACCEPTED`, `INVALID_REQUEST`, `INVALID_PAYLOAD` → final for that device;
  - `INVALID_DESTINATION` → `markInvalid(deviceId, attemptedAt)`, then final;
  - `TRANSIENT` / `RATE_LIMITED` → retry, waiting at least `retryAfterMs`, and at least 60 s for quota;
  - `CONFIGURATION` → global, alertable; no revocation;
  - `DISABLED` → do not process.
- **One call** may include up to 4 SDK-internal retries and is bounded by `PUSH_SEND_TIMEOUT_MS`. Ambiguous outcomes may duplicate.

### Next subtask (after BE06-04)

**BE06-05.** Done; see below.

## BE06-05 (PASS)

Details: [p3-be06-worker.md](p3-be06-worker.md).

What it covers: a generic durable worker (claiming, leases, fencing, retries, deadlines, lifecycle) behind a `DeliveryJobExecutor` interface. **No** executor is implemented, and there is no Firebase orchestration, device selection or `markInvalid`. **No migration change.** `BookingsService` and notification content are unchanged, and `pet_care_db` was not touched.

### Files

- **New:** in `src/push-delivery/worker/`: `delivery-job.types.ts`, `push-worker.config.ts`, `retry-policy.ts`, `push-job.store.ts`, `push-delivery.worker.ts`, `push-worker.spec.ts`. Also `test/qa/push-worker.cjs` and `docs/phase3/p3-be06-worker.md`.
- **Modified:**
  - `src/push-delivery/push-delivery.module.ts`: worker factory with an optional `DELIVERY_JOB_EXECUTOR`.
  - `package.json`: `qa:push-worker`.
  - `.env.example`: worker variables.
  - `test/qa/push-outbox.cjs`, `test/qa/booking-events.cjs`: one assertion each. Both previously required app logs to never mention a "worker". They now require "worker disabled, never started, no job processed, no Firebase", which is the property they were protecting.

### Decisions

1. **Fencing** uses a fresh unique token per claim in the existing `lease_owner` column, and every write is fenced on that token plus `PROCESSING`. No schema change.
2. **Database clock by default** (`COALESCE($now, now())`): one time authority for all instances; tests inject a clock.
3. **Every state change is one auto-committed statement.** No transaction is held during execution. The heartbeat renews leases every lease/3; each attempt is bounded by a timeout and an `AbortSignal`.
4. **Retry:** exponential backoff (base 30 s, cap 1 h, ±20% jitter). Retry-After wins when larger. Quota waits ≥ 60 s, configuration ≥ 5 min, any retry ≥ 1 s. Up to 8 attempts. A retry past the deadline → EXPIRED, decided atomically in SQL.
5. **Outcome mapping:**
   - DELIVERED, NO_DESTINATIONS → DONE;
   - RETRY, CONFIGURATION → PENDING (FAILED when exhausted);
   - TERMINAL, DISABLED → FAILED;
   - executor error or timeout → ambiguous TRANSIENT retry.
6. **Safety:**
   - `PUSH_WORKER_ENABLED` defaults to false;
   - enabled + push disabled → configuration error;
   - enabled without an executor → the app refuses to start;
   - there is no production fake executor, so no job can be processed by a running application until BE06-06.

### Verification

| Check | Result |
|---|---|
| `push-worker.spec.ts` | 21/21 |
| `src/push-delivery` (3 suites) | 103/103 |
| `qa:push-worker` | **33/33** (2 consecutive runs) |
| `qa:push-outbox` | 28/28 |
| `qa:booking-events` | 32/32 |
| tsc, nest build | clean |
| lint | 0 errors; 1 pre-existing warning |

The full Jest regression was not run, as instructed. No booking, notification or outbox source changed.

**First QA run** aborted on a test-harness clock error. The injected clock base was taken before the test jobs were inserted, so they were not yet "due". Fixed in the test by inserting test jobs already due. No product change.

### Remaining risks

- At-least-once delivery: duplicates are possible after crashes, lost connections or ambiguous timeouts. The mitigation is BE06-06 per-device rows plus the BE06-04 notification tag.
- A database outage longer than the lease during a long execution can lead to double execution. The persisted state stays consistent through fencing.
- Attempts count claims: a crash consumes an attempt.
- Retention of finished jobs is not implemented yet.
- The leftover database `pawflow_qa_push_delivery` is still present (not deleted, as instructed). BE06-05 QA dropped its own databases.

### BE06-06 dependencies

- Implement `DeliveryJobExecutor` and register it as `DELIVERY_JOB_EXECUTOR`, following the aggregate contract in `p3-be06-worker.md` §8.
- **Add durable per-device outcomes** (`notification_push_sends`, `UNIQUE (delivery_id, push_device_id)`, insert-only), extending the pending migration `1796500000000` or a new additive one (§9).
- Skip devices that already have a final outcome; re-check eligibility right before each send; pass the remaining TTL; call `markInvalid` only on `INVALID_DESTINATION`; honour `signal` and `expiresAt`.

### Next subtask

**BE06-06.** Do not start until it is explicitly requested.
