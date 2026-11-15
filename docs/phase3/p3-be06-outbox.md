# P3-BE06-02 — Transactional Outbox Foundation

Status: **implemented and QA-verified (BE06-02)**. Not deployed: migration `1796500000000` has **not** been run on `pet_care_db`. Full development preflight is reserved for BE06-08.

Scope: the durable job table and an internal enqueue API. **Not** in this subtask:

- booking integration (`BookingEventsService`);
- the worker, claiming and retries;
- providers, Firebase, and `sendPush`.

## 1. Granularity decision

**One job = one inbox notification (one recipient)**. It is not one device destination.

| Option | Verdict |
|---|---|
| Job per notification | **Chosen.** It is created atomically with the notification. Device selection happens at send time, so a device registered, rotated or revoked between enqueue and send is handled correctly: re-check through P3-BE05 `findSendTargets`. No device identifier or registration value is ever copied into the outbox. |
| Job per device | Rejected. It would freeze destinations at business-transaction time, and devices change between enqueue and send. It would also put device ids in the business transaction and multiply rows. |

**Per-device outcomes (BE06-05)** will live in a separate child table, keyed `UNIQUE (delivery_id, push_device_id)`, holding the final per-device result (sent, invalid destination, permanent failure). A retried job then skips devices that already have a final outcome. This table is deliberately **not** created here. It will be its own additive migration in BE06-05.

## 2. Schema: `notification_deliveries`

Migration: `src/database/migrations/1796500000000-CreateNotificationDeliveries.ts`.
Entity: `src/push-delivery/entities/notification-delivery.entity.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | Stable job id |
| `notification_id` | bigint, **UNIQUE** | `uq_notification_deliveries_notification`: at most one job per notification |
| `recipient_user_id` | bigint | Must equal the notification's recipient (composite FK) |
| `status` | varchar(16) | `PENDING` / `PROCESSING` (claimed, leased) / `DONE` / `FAILED` / `EXPIRED` |
| `attempt_count` | int ≥ 0 | Never decreases (trigger) |
| `next_attempt_at` | timestamptz | When the job becomes due (retries/backoff are set by the worker) |
| `expires_at` | timestamptz | **Delivery deadline** = enqueue time + `PUSH_DELIVERY_TTL_SECONDS`. Immutable. |
| `lease_owner`, `lease_expires_at` | | Set **iff** `PROCESSING`. The owner id is pattern-restricted. |
| `last_error_category` | varchar(32) | `^[A-Z][A-Z_]{0,31}$` (for example `UNAVAILABLE`) |
| `last_error_code` | varchar(100) | `^[A-Za-z0-9/._:-]{1,100}$`. A code token only: free-text messages, e-mail addresses and values with spaces are rejected. |
| `created_at`, `updated_at`, `completed_at` | timestamptz | `completed_at` is set **iff** the status is terminal. The trigger maintains `updated_at`. |

**Constraints:**

- `fk_notification_deliveries_notification`: `(notification_id, recipient_user_id) → notifications(id, recipient_user_id) ON DELETE CASCADE`.
  - It is backed by a new `uq_notifications_id_recipient UNIQUE (id, recipient_user_id)` on `notifications`. That unique is implied by the primary key and changes no data. It follows the same pattern as P3-BE05 `uq_auth_sessions_id_user`.
  - Effect: a job can never point at another user's notification. Deleting a notification, or its recipient through the existing cascade, deletes the job.
- Eight checks: status, lease pair, completed pair, attempts range, `expires_at > created_at`, and the patterns for lease owner, error category and error code.
- Trigger `trg_notification_deliveries_guard` (BEFORE INSERT OR UPDATE):
  - an insert must be `PENDING`, with 0 attempts and no `completed_at`;
  - `notification_id`, `recipient_user_id`, `created_at` and `expires_at` are immutable;
  - `attempt_count` cannot decrease;
  - terminal rows (`DONE`, `FAILED`, `EXPIRED`) cannot change;
  - legal transitions only:

```
PENDING    -> PROCESSING | EXPIRED
PROCESSING -> PROCESSING (lease renew / reclaim) | PENDING (retry) | DONE | FAILED | EXPIRED
```

**Indexes** (partial, for future worker queries):

- `idx_notification_deliveries_due (next_attempt_at, id) WHERE status='PENDING'`
- `idx_notification_deliveries_lease (lease_expires_at) WHERE status='PROCESSING'`
- `idx_notification_deliveries_finished (completed_at) WHERE status IN ('DONE','FAILED','EXPIRED')` (retention)

**Never stored:** device ids, FIDs or tokens, Firebase credentials, notification title, body or payload, e-mail addresses. The worker re-reads the notification at send time.

`down()` drops exactly the table (with its trigger), the guard function, and `uq_notifications_id_recipient`. Inbox data is untouched. Pending push jobs are lost on rollback, by design.

## 3. Enqueue API (internal)

`PushOutboxService` in `src/push-delivery/push-outbox.service.ts` is exported by `PushDeliveryModule`, which is registered in `AppModule`. There is **no HTTP endpoint**.

```ts
enqueue(manager: EntityManager, notificationIds: readonly string[]): Promise<{
  enqueued: string[];        // jobs created by this call
  alreadyQueued: string[];   // notifications that already had a job
  skipped: 'PUSH_DISABLED' | null;
}>
```

- **Must run inside the caller's transaction.** A manager without an active transaction gets `OutboxUsageError`. The jobs then commit or roll back together with the business change and the notifications.
- **Input:** ids are positive bigint strings, at most 500 per call, de-duplicated. Anything else is an `OutboxUsageError`, and nothing touches the database.
- **One SQL statement:**
  - it checks that every notification exists in the caller's snapshot, and inserts only if all of them do;
  - otherwise it throws `OutboxNotificationNotFoundError(missingIds)` and writes **nothing**, so the caller's transaction should abort;
  - the recipient is taken from the notification row;
  - `expires_at = now() + TTL`.
- **Deduplication** is deterministic: `ON CONFLICT (notification_id) DO NOTHING`.
  - A repeated call returns `alreadyQueued`.
  - A **concurrent** transaction enqueuing the same notification **waits** for the first one. If the first commits, the waiter gets `alreadyQueued`. If it rolls back, the waiter creates the job.
  - Rows are inserted **in ascending notification-id order**, so overlapping concurrent batches wait but never deadlock. QA found a real deadlock before this ordering was added (§6).

Expected caller (BE06-03), in the booking transaction:

```ts
const results = await notifications.createMany(inputs, manager);
await outbox.enqueue(manager, results.filter((r) => r.created).map((r) => r.notification.id));
```

## 4. Push-disabled and outage policy

| Situation | Behaviour |
|---|---|
| `PUSH_DELIVERY_MODE=disabled` (or unset outside production) | **No job is written** (`skipped: 'PUSH_DISABLED'`). The inbox works normally. Nothing accumulates, so switching push on later never sends old messages. Only events after the switch are pushed. |
| Mode enabled, but the worker or provider is temporarily unavailable (crash, outage, FCM 5xx) | Jobs stay `PENDING` or are reclaimed after lease expiry, and are delivered when service returns, **but only until `expires_at`** (default 24 h). A job past its deadline must be set to `EXPIRED` and **never sent** (worker rule, BE06-04). |
| `NODE_ENV=production` | `PUSH_DELIVERY_MODE` must be set explicitly (`firebase` or `disabled`), and `mock` is refused. The application fails to start otherwise, so it never silently runs without push or with a fake provider. |

Configuration (`.env.example`): `PUSH_DELIVERY_MODE` (`disabled` / `mock` / `firebase`), `PUSH_DELIVERY_TTL_SECONDS` (60 to 2,419,200, default 86,400).

In BE06-02, `mock` and `firebase` only **record intent**. No worker exists yet, so jobs created in those modes stay `PENDING` until a worker exists. When one does, it must expire anything past its deadline. The development default (mode unset → disabled) therefore writes nothing.

## 5. Future worker integration (BE06-04 / BE06-05)

- **Claim:**
  ```sql
  UPDATE … SET status='PROCESSING', lease_owner=$me, lease_expires_at=now()+lease, attempt_count=attempt_count+1
  WHERE id IN (SELECT id … WHERE (status='PENDING' AND next_attempt_at<=now()) OR (status='PROCESSING' AND lease_expires_at<now())
               ORDER BY next_attempt_at, id LIMIT n FOR UPDATE SKIP LOCKED)
  ```
  Several backend instances can claim in parallel, and an expired lease is reclaimed.
- **Before sending:** if `expires_at <= now()`, set `EXPIRED` (from `PENDING` or `PROCESSING`). Re-check device eligibility right before each send.
- **Every completion update is lease-fenced:** `WHERE id=$1 AND lease_owner=$me AND status='PROCESSING'`. A worker whose lease was taken over cannot overwrite the new owner's state.
- **Retry:** `PROCESSING → PENDING`, with `next_attempt_at` set by backoff and `last_error_category`/`code` updated. The terminal states are `DONE`, `FAILED` (retries exhausted or permanent) and `EXPIRED`.
- **Retention:** delete finished jobs by `completed_at` (index `idx_notification_deliveries_finished`). Inbox rows are unaffected.
- **Delivery guarantee: at least once per device.** A crash after the provider accepted a message but before its outcome is recorded causes a resend. A per-notification tag or collapse id deduplicates the display.

## 6. Verification (BE06-02)

| Check | Result |
|---|---|
| Unit spec `src/push-delivery/push-outbox.spec.ts` | **22/22 PASS** |
| PostgreSQL QA `npm run qa:push-outbox` (`test/qa/push-outbox.cjs`, disposable `pawflow_qa_push_outbox`, dropped afterwards) | **28/28 PASS** in 4 consecutive runs on the final code |
| Full `npm test` (because `AppModule` and the notifications entity changed) | 49 suites, **1422/1422 PASS** |
| `qa:notifications` / `qa:push-devices` (their migration rehearsals now run with the new migration on top) | **43/43**, **49/49 PASS** |
| `tsc --noEmit`, `nest build` | clean |
| Lint | 0 errors. 1 pre-existing warning (`test/qa/bot-protection.cjs:189`). |

**What the QA suite covers:**

- schema, constraints, FK and indexes; 15/15 migrations; 0 pending DDL;
- valid enqueue in the caller's transaction (invisible before commit, persisted after);
- duplicate enqueue; parent rollback; missing notification (all-or-nothing); a call outside a transaction is refused;
- disabled mode writes nothing;
- 12 concurrent duplicate enqueues from 2 instances produce exactly one job;
- the waiter takes over after the first transaction rolls back;
- 15 rounds × 5 concurrent overlapping batches (40 notifications, mixed and reversed order, 2 instances): no deadlock, each job created exactly once;
- wrong recipient or unknown notification → 23503; duplicate insert → 23505;
- 15 illegal inserts, transitions and edits → 23514; the legal retry path is accepted; `PENDING → EXPIRED` is accepted and terminal;
- cascade on recipient deletion; no sensitive data in job rows;
- the app boots with the module;
- migration down removes only BE06-02 objects (data intact), and up again gives 0 pending DDL.

**Defect found and fixed during QA:** concurrent enqueues of **overlapping** id sets could deadlock (`40P01`), because `INSERT … SELECT` order was unspecified. Fix: `ORDER BY f.id` in the insert. The unit spec pins this, and the QA suite now runs 15 rounds × 5 overlapping batches.

## 7. Remaining risks

1. **Unique-index wait.** A concurrent enqueue of the same notification blocks until the first transaction ends. In BE06-03 a notification is enqueued only by the transaction that created it, so this situation should not arise in practice.
2. **Jobs in `mock` or `firebase` mode before a worker exists** (BE06-02 to BE06-03) stay `PENDING` until expired by the future worker. Keep development on `disabled` until BE06-04.
3. **The new `uq_notifications_id_recipient`** adds one index on `notifications`. It is built during the migration, and the cost is negligible at the current table size. Measure it in the BE06-08 preflight.
4. **Rolling back the migration discards pending jobs.** By design, no inbox data is lost.
5. **Production startup** now requires an explicit `PUSH_DELIVERY_MODE`. Add it to the deployment checklist.
