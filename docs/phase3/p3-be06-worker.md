# P3-BE06-05 — Durable Delivery Worker & Retry State Machine

Status: **implemented and QA-verified (BE06-05)**.

- **The worker cannot run in a deployed application yet.** It is disabled by default, and it refuses to start without a delivery executor. BE06-06 provides that executor.
- No Firebase call, no device selection, no `markInvalid`.
- **No schema change:** the pending migration `1796500000000` is unchanged.

Code: `src/push-delivery/worker/`:

- `delivery-job.types.ts`: executor contract
- `push-worker.config.ts`: settings
- `retry-policy.ts`: pure backoff and transition rules
- `push-job.store.ts`: all job SQL
- `push-delivery.worker.ts`: lifecycle and processing
- `push-worker.spec.ts`

Wiring: `PushDeliveryModule` builds the worker with an **optional** `DELIVERY_JOB_EXECUTOR`. QA: `test/qa/push-worker.cjs` (`npm run qa:push-worker`).

## 1. Architecture

```
tick (per instance; any number of instances)
  ├─ store.expireOverdue()            overdue PENDING / abandoned PROCESSING -> EXPIRED
  ├─ store.claim(workerId, batch)     SKIP LOCKED, fresh lease token per job, attempt_count+1   (auto-commit)
  ├─ execute ≤ batch jobs concurrently through DeliveryJobExecutor   (no DB transaction open)
  │     heartbeat: store.renew() every lease/3; lease lost -> AbortSignal
  │     bound: PUSH_WORKER_JOB_TIMEOUT_MS -> abort + ambiguous TRANSIENT
  ├─ decideTransition(outcome)        pure retry policy
  └─ fenced write per job             DONE | PENDING(+backoff) | FAILED | EXPIRED, or LOST_LEASE
next tick: immediately if the batch was full, else PUSH_WORKER_POLL_MS;
failed tick (e.g. DB down): back-off pollMs·2^n, max 60 s
```

- Every job-state change is a **single auto-committed statement**. No transaction or row lock is held while the executor runs.
- **Time.** Every comparison uses `COALESCE($now, now())`. Production passes `null`, so the **database clock** is the single authority across instances and app-server clock skew cannot break leases or schedules. Tests inject a clock.

## 2. Claiming and locking

```sql
WITH t AS (SELECT COALESCE($now, now()) AS now),
     due AS (SELECT d.id FROM notification_deliveries d, t
              WHERE d.expires_at > t.now
                AND ((d.status='PENDING' AND d.next_attempt_at <= t.now)
                  OR (d.status='PROCESSING' AND d.lease_expires_at <= t.now))
              ORDER BY d.next_attempt_at, d.id LIMIT $batch
              FOR UPDATE OF d SKIP LOCKED)
UPDATE notification_deliveries d SET status='PROCESSING',
       lease_owner = $workerId || ':' || <16 random hex>,
       lease_expires_at = now + lease, attempt_count = attempt_count + 1
  FROM due WHERE d.id = due.id RETURNING …
```

- Due jobs are selected in `next_attempt_at` order (index `idx_notification_deliveries_due`).
- Expired leases are reclaimable (index `idx_notification_deliveries_lease`).
- Jobs past the deadline and terminal jobs are **never** claimed.
- `SKIP LOCKED`: concurrent claimers never wait on, or double-claim, the same row. QA: 20 concurrent claimers over 60 jobs produced 60 distinct claims, and rows locked by another transaction were skipped in under 1 s.

## 3. Lease fencing (no schema change)

- Each claim writes a **new unique token** into the existing `lease_owner` column: `<workerId>:<16 hex>`. The column's pattern check allows `^[A-Za-z0-9:._-]{1,64}$`.
- **Every** later write for that attempt (renew, complete, retry, fail, expire) requires `status='PROCESSING' AND lease_owner=<token>`.
- So once another worker reclaims an expired lease, the stale worker cannot renew, complete, retry, fail or expire it. Its result is discarded (`LOST_LEASE`).
- **If a lease expired but nobody reclaimed it yet**, the original owner may still complete (the token still matches). That is safe: no one else has run the job.
- The heartbeat renews leases every `lease/3`. If renewal shows the lease is lost, the executor's `AbortSignal` fires.
- The BE06-02 trigger still enforces legal transitions and immutable terminal rows. QA confirmed that reopening a DONE job is refused (23514).

## 4. Retry and backoff (`retry-policy.ts`)

`delay = min(cap, base·2^(attempt−1))`, then jitter of ±20% (never above the cap). After that:

- `max(delay, Retry-After)`: a larger Retry-After beats the cap;
- RATE_LIMITED waits at least **60 s**;
- CONFIGURATION waits at least **5 min**;
- every retry waits at least 1 s.

Defaults: base 30 s, cap 1 h, max attempts 8.

| Executor outcome | Transition |
|---|---|
| `DELIVERED` | DONE |
| `NO_DESTINATIONS` | DONE (category `NO_DESTINATIONS`) |
| `RETRY` (TRANSIENT / RATE_LIMITED) | PENDING at now + delay; FAILED when `attempt ≥ max` |
| `CONFIGURATION` | PENDING (≥ 5 min); FAILED when attempts are exhausted |
| `TERMINAL` (INVALID_PAYLOAD / INVALID_REQUEST / NOTIFICATION_MISSING) | FAILED, never retried |
| `DISABLED` | FAILED (`PUSH_DISABLED`), never sent later |
| executor throws or times out | RETRY TRANSIENT, **ambiguous** (`pawflow/executor-error`, `pawflow/job-timeout`) |
| unknown outcome shape | RETRY TRANSIENT (`pawflow/invalid-executor-outcome`) |

Codes and categories are sanitized (code-token pattern) before they are stored or logged.

## 5. Deadlines

- `expires_at` (BE06-02) is never crossed:
  - overdue jobs are expired at the start of every tick: `PENDING`, and `PROCESSING` whose lease also expired;
  - claims exclude them;
  - a claimed job already past its deadline is expired instead of executed.
- **The retry statement decides atomically.** If `now + delay ≥ expires_at`, the job becomes **EXPIRED**, not PENDING.
- A job whose deadline passes **during** execution: if the outcome is RETRY it becomes EXPIRED. If the outcome is DELIVERED it is DONE (it was sent).
- **The executor receives `expiresAt` and must not send after it.** BE06-06 passes the remaining window as the FCM TTL.

## 6. Crash recovery (verified in QA)

| Failure point | Result |
|---|---|
| Before the claim | Nothing changed |
| Right after the claim | Invisible while the lease is valid; reclaimed after expiry (attempt +1) |
| During execution | Lease expires; another worker reclaims. The executor may already have sent to some devices → **at-least-once** |
| After execution, before persistence (real process killed with SIGKILL) | Job left `PROCESSING` with the dead worker's token, reclaimed, executed **again**, then DONE once. QA: 2 executions, attempt 2 |
| Lease expiry while still running | Heartbeat prevents it; if renewal fails, the signal aborts and the result is discarded |
| Stale worker completes | Fence rejects it (all 5 write kinds) |
| Process restart | A new worker id (new random suffix) reclaims expired leases |
| Database unreachable | Tick returns `null`, a safe diagnostic is logged, poll back-off; no execution |
| Connection lost mid-job | Persist fails (`PERSIST_FAILED`); the job stays leased, is reclaimed after expiry, and ends DONE once |
| Deadline passes during the job, or while the worker is crashed | EXPIRED, never sent late |

**Guarantee: at-least-once per job attempt, never exactly-once.** Duplicate FCM deliveries are possible after ambiguous outcomes, crashes or lost connections. They are mitigated by BE06-06's per-device records (accepted devices are not re-sent) and the per-notification tag / collapse id (BE06-04), which replaces a duplicate on the device.

## 7. Lifecycle and configuration

| Variable | Default | Notes |
|---|---|---|
| `PUSH_WORKER_ENABLED` | **false** | `true` requires `PUSH_DELIVERY_MODE` ≠ `disabled` and a registered executor; otherwise the app refuses to start (verified) |
| `PUSH_WORKER_BATCH_SIZE` | 5 (1–50) | Jobs claimed **and** executed concurrently per tick. This bounds in-flight work. |
| `PUSH_WORKER_POLL_MS` | 2000 (200–60000) | Idle poll interval. Failed ticks back off up to 60 s. |
| `PUSH_WORKER_LEASE_SECONDS` | 120 (10–3600) | Must be ≥ 3 × `PUSH_SEND_TIMEOUT_MS`; renewed every lease/3 |
| `PUSH_WORKER_JOB_TIMEOUT_MS` | 60000 | Per attempt; must be ≥ `PUSH_SEND_TIMEOUT_MS` |
| `PUSH_DELIVERY_MAX_ATTEMPTS` | 8 (1–20) | |
| `PUSH_RETRY_BASE_MS` / `PUSH_RETRY_MAX_MS` | 30000 / 3600000 | |
| `PUSH_WORKER_SHUTDOWN_GRACE_MS` | 10000 (0–60000) | |

- **Lifecycle:** `onApplicationBootstrap` starts the worker only when enabled. `beforeApplicationShutdown` stops claiming, waits up to the grace period for in-flight jobs, then aborts them (their leases expire and they are reclaimed).
- **Logs:** `Push job <id> (notification <id>, attempt <n>): <OUTCOME> [<CATEGORY> <code>] -> <STATE>`. No lease tokens, destinations, credentials, content or SQL/driver messages: errors are reduced to `Name(code)`.
- **No HTTP control endpoint.**

## 8. Aggregate outcome contract for BE06-06

`DeliveryJobExecutor.execute({ jobId, notificationId, recipientUserId, attempt, expiresAt, signal }) → JobExecutionOutcome`. The lease token is never exposed; persistence belongs to the worker.

BE06-06 must aggregate the per-device provider results (BE06-04) as follows:

- **All eligible devices have a final outcome** → `DELIVERED{accepted, failedFinal}`. Final outcomes are ACCEPTED, INVALID_DESTINATION (after `markInvalid`), INVALID_REQUEST and INVALID_PAYLOAD for one device.
- **No eligible device** → `NO_DESTINATIONS`.
- **Any device TRANSIENT or RATE_LIMITED** → `RETRY{category, code, retryAfterMs = max over devices, ambiguous}`. **Do not report DELIVERED after a partial success.**
- **Provider CONFIGURATION** → `CONFIGURATION` (stop sending this attempt).
- **Provider DISABLED** → `DISABLED`.
- **Notification deleted, or payload invalid for every device** → `TERMINAL`.
- **Respect `signal`:** stop sending when it is aborted. Never send after `expiresAt`.

## 9. BE06-06 integration requirements

1. **Per-device persistence (required, durable).** Extend the pending migration `1796500000000`, or add an additive migration, with:

   ```sql
   notification_push_sends(id bigserial PK,
     delivery_id bigint NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
     push_device_id bigint NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
     status varchar CHECK (status IN ('ACCEPTED','INVALID_DESTINATION','INVALID_REQUEST','INVALID_PAYLOAD')),
     provider_message_id varchar(200) NULL, code varchar(100) NULL, attempt int NOT NULL, created_at timestamptz DEFAULT now(),
     UNIQUE (delivery_id, push_device_id))
   ```

   - Write each final per-device result **immediately** after the provider returns, with `INSERT … ON CONFLICT DO NOTHING`, auto-committed.
   - Before sending, skip devices that already have a row.
   - **Never delete or overwrite** a row on retry. In-process memory is not the source of truth.
2. **Executor work per attempt:**
   - re-read the notification (missing → `TERMINAL`);
   - `findSendTargets(recipientUserId)`, minus devices with a final row;
   - for each device: re-check eligibility right before sending; `provider.send(destination, message{ttlSeconds = remaining window}, …)`; persist the per-device row;
   - on `INVALID_DESTINATION`, call `markInvalid(deviceId, attemptedAt)`.
3. **Register the executor** as `DELIVERY_JOB_EXECUTOR` in `PushDeliveryModule`. The worker then becomes startable with `PUSH_WORKER_ENABLED=true` (`mock` for QA; `firebase` only with real configuration).
4. **Keep development on** `PUSH_DELIVERY_MODE=disabled` / `PUSH_WORKER_ENABLED=false` until BE06-08.

## 10. Verification

| Check | Result |
|---|---|
| `push-worker.spec.ts` (retry policy, config, worker with in-memory store and fake executors) | **21/21** |
| `src/push-delivery` (all specs) | 3 suites, **103/103** |
| `qa:push-worker` (disposable PostgreSQL, compiled classes, controlled clock, real child-process crash, connection kill, app boot) | **33/33** in 2 consecutive runs |
| `qa:push-outbox` / `qa:booking-events` | 28/28, 32/32 (one assertion each updated, see progress) |
| tsc, nest build | clean |
| lint | 0 errors; 1 pre-existing warning |

QA evidence:

- 20 claimers → 60/60 distinct claims.
- Retry delays: 30 s → 60 s (exponential); Retry-After 120 s; quota 60 s (despite Retry-After 1 s); configuration 300 s.
- Crash after execution: 2 executions, attempt 2, DONE.
- Connection drop: `PERSIST_FAILED`, then reclaimed, then DONE.
- Lease renewal kept an 11 s execution with a 10 s lease.
- 0 outbound HTTP/HTTPS/HTTP2/fetch calls; 0 deadlocks.

## 11. Remaining risks

- **At-least-once:** duplicates are possible, as described above.
- **Long executions** depend on the heartbeat. If the database is unreachable for longer than the lease while an executor is still sending, another worker may reclaim the job and both may send. The fence still keeps the persisted state consistent, and BE06-06's per-device rows limit re-sends.
- **`expireOverdue` runs on every tick** (bounded at 500 rows, `SKIP LOCKED`). Retention and purging of finished jobs (index `idx_notification_deliveries_finished`) is not implemented yet. It is a BE06-07/08 item.
- **Attempts count claims, not sends.** A job reclaimed after a crash consumes an attempt.
