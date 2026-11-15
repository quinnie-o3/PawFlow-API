# P3-BE06-07 — Full Regression, Integration Security & Failure Injection

Status: **PASS (2026-11-09)**. This was a verification task.

- **No application code was changed.** The only additions are a new integration QA suite (`test/qa/push-pipeline.cjs`, npm script `qa:push-pipeline`) and documentation.
- No real Firebase call. Nothing deployed. `pet_care_db` untouched.

## 1. Source revision and working tree

| Item | Value |
|---|---|
| Branch | `feature/notification-inbox` |
| HEAD | `90b0012` (BE06-01 to BE06-05 checkpoint, committed by the user) |
| Uncommitted | BE06-06: executor, per-device table, migration extension, eligibility re-check, fenced context, QA updates. BE06-07: `test/qa/push-pipeline.cjs`, `package.json` script, docs. |
| BE06-06 presence verified | `PushDispatchExecutor` registered as `DELIVERY_JOB_EXECUTOR`; `notification_push_sends` entity and migration; `isSendEligible`; fenced `renewLease` / `recordDeviceOutcome`; `qa:push-dispatch` |
| Prior migrations | 15 migration files; none of the 14 earlier ones changed since `a135ed7` (`git diff` empty) |
| Old interrupted draft | not restored |

## 2. Environment safety (checked before any test)

- **`.env`** points at `pet_care_db`. The harness (`assertQaDatabaseName`, and its own copy in `mvp-e2e`) refuses any database not named `pawflow_qa_*` **and** refuses the `.env` database. All 12 suites default to distinct `pawflow_qa_*` names. No `QA_*`, `DB_*` or `PUSH_*` override was present in the shell.
- **No node processes were running.** QA ports 8101–8282 were free. Port 8080 belongs to an unrelated `httpd` service and is used by no suite.
- **`pet_care_db`**, checked read-only before and after: 14 migrations, no `notification_deliveries` / `notification_push_sends`. **Unchanged.**
- **Suites ran strictly one after another** (timing-sensitive `bot-protection` alone). After each suite the runner listed `pawflow_qa_*` databases: **no suite left a database behind**. Only the pre-existing `pawflow_qa_push_delivery` remains, untouched (not authorized to drop).

## 3. Full QA matrix

Static checks (the repository has no `typecheck` script, so the TypeScript compiler was run directly):

| Check | Command | Exit | Result | Time |
|---|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | 0 | 0 errors | 8 s |
| Lint | `npm run lint` (oxlint) | 0 | 0 errors, 1 pre-existing warning (`test/qa/bot-protection.cjs:189`) | <1 s |
| Build | `npm run build` | 0 | ok | 8 s |
| Unit | `npm test` | 0 | **53 suites, 1549/1549 passed**, 0 skipped | 21 s |

PostgreSQL / HTTP suites, sequential, fresh disposable database each:

| # | Command | Exit | Passed | Failed | Skipped | Duration | Leftover DB |
|---|---|---|---|---|---|---|---|
| 1 | `npm run qa:push-dispatch` | 0 | 38 | 0 | 0 | 26 s | none |
| 2 | `npm run qa:push-worker` | 0 | 33 | 0 | 0 | 64 s | none |
| 3 | `npm run qa:push-outbox` | 0 | 28 | 0 | 0 | 8 s | none |
| 4 | `npm run qa:booking-events` | 0 | 32 | 0 | 0 | 26 s | none |
| 5 | `npm run qa:push-devices` | 0 | 49 | 0 | 0 | 29 s | none |
| 6 | `npm run qa:notifications` | 0 | 43 | 0 | 0 | 12 s | none |
| 7 | `npm run qa:auth-sessions` | 0 | 55 | 0 | 0 | 24 s | none |
| 8 | `npm run qa:account-recovery` | 0 | 91 | 0 | 0 | 95 s | none |
| 9 | `npm run qa:bot-protection` | 0 | 40 | 0 | 0 | 143 s | none |
| 10 | `npm run qa:fe-smoke` | 0 | 31 | 0 | 0 | 11 s | none |
| 11 | `npm run qa:mvp-e2e` | 0 | 110 | 0 | 0 | 18 s | none |
| 12 | `npm run qa:push-pipeline` (**new**, BE06-07) | 0 | 18 | 0 | 0 | 37 s, then 35 s on a second run | none |

**Totals:**

- PostgreSQL/HTTP: **568/568** checks (550 in the 11 required suites + 18 new).
- Unit: 1549/1549.
- No partial or interrupted run counted. No assertion was weakened, and no failure occurred.

## 4. Integrated pipeline (`qa:push-pipeline`, the app's own worker + executor)

The gap closed: before BE06-07, `qa:booking-events` stopped at the outbox job, and `qa:push-dispatch` drove the worker on synthetic notifications. The new suite runs:

> booking HTTP transition → status log → inbox notification → outbox job → **application worker** claim → eligibility re-check → mock provider → `notification_push_sends` rows → final job state

It uses two application instances with `PUSH_WORKER_ENABLED=true` and `PUSH_DELIVERY_MODE=mock`, in three phases.

| Requirement | Evidence |
|---|---|
| All six events | 20 notifications. `BOOKING_CREATED` and `BOOKING_CANCELLED` went to owner + 2 ACTIVE staff; `CONFIRMED`, `REJECTED`, `COMPLETED` and `NO_SHOW` went to the customer. |
| Correct recipients, no unauthorized ones | Per-device rows are **exactly** the recipient's active devices (owner: FID + legacy token), all `ACCEPTED` on attempt 1, every job DONE. 0 rows for the INACTIVE staff member's or the unrelated user's devices. |
| Event keys, no duplicates | Every key is `booking:{id}:log:{statusLogId}` with a matching status log; Idempotency-Key replay added nothing; 0 duplicate (recipient, key) pairs; 0 notifications with more than one job; reject/cancel/no-show reasons never in content |
| One job per notification when enabled; none when disabled | Phase 2: one job each. Phase 3 (mode unset): the booking created 4 inbox notifications and **0 jobs**; provider disabled, worker disabled. |
| Failed booking transaction | Injected failure at the outbox insert gave HTTP 500 and no booking, no inbox row and no job (counts identical before and after) |
| Push failure keeps the inbox | A `CONFIGURATION` failure leaves the notification in `GET /notifications`; earlier suites verified the same for TRANSIENT / RATE_LIMITED / INVALID_PAYLOAD (`qa:push-dispatch` #30) |
| Unexpected 5xx / deadlocks | 145 requests, **0** unexpected 5xx; `pg_stat_database.deadlocks` 0; no `40P01` in logs |

## 5. Failure injection

Existing verified evidence was reused, and new tests were added only for the integration gaps.

### A. Partial delivery

| Where | Result |
|---|---|
| `qa:push-dispatch` #13/#14 (scripted provider) | Attempt 1: A ACCEPTED@1, B TRANSIENT, C INVALID_DESTINATION@1 (C revoked). Attempt 2: only B was sent (sends A 1, **B 2**, C 1), then DONE. |
| `qa:push-pipeline` (app worker; B always unavailable) | A@1 and C@1 written once and never re-sent. B retried each attempt until max attempts (3), then the job became **FAILED (TRANSIENT)**. This is the documented terminal condition. Only C revoked; A and B intact. |

### B. Process crash

**Database state** stays consistent at every boundary. **External sends** may be duplicated, and never exactly once is claimed.

| Boundary | Evidence | Database state | External sends |
|---|---|---|---|
| After the claim | `qa:push-worker` #17 | Invisible while the lease is valid; reclaimed after expiry (attempt 2), DONE | none duplicated |
| After provider acceptance, before persisting | `qa:push-dispatch` #16 (real SIGKILL) | No row; reclaimed; row @2 | **1 duplicate send** (at-least-once) |
| After persisting one device result | `qa:push-dispatch` #15 (real SIGKILL) | A's row survives; recovery sends only B | A exactly once |
| After all device rows, **before finalizing the job** | `qa:push-pipeline` B (new) | Job left PROCESSING; recovery completes it **DONE** (attempt 2) | **0 re-sends** (2 sends total) |
| Process restart / database loss | `qa:push-worker` #19/#20 | Tick fails safely and backs off; a dropped connection gives PERSIST_FAILED, then reclaim, then DONE once | at most the in-flight attempt |

### C. Account switching, rotation, stale results

| Case | Evidence |
|---|---|
| A registers → logs out → B registers the same installation → A's **delayed** job runs | `qa:push-pipeline` (application worker): A's job **NO_DESTINATIONS**, 0 rows; B's job reaches the installation only via B's device row; B's inbox never shows A's notification. Also `qa:push-dispatch` #22 / #22b (transfer while A is logged in). |
| Revoked session tries to register again | 401 (`qa:push-dispatch` #22) |
| Rotation before dispatch | Only the new row receives it (#23) |
| Delayed INVALID_DESTINATION after rotation or re-registration | Recorded for the old row only; the new or refreshed registration stays active (#24 / #24b) |

### D. Concurrency

| Case | Evidence |
|---|---|
| Multiple worker instances | `qa:push-dispatch` #27 (10 jobs × 2 devices: 20 distinct sends and rows); `qa:push-pipeline` (two app workers) |
| Concurrent claims / SKIP LOCKED | `qa:push-worker` #4–6 (20 claimers → 60/60 distinct) |
| Lease expiry, stale-result rejection | `qa:push-worker` #7/#8; `qa:push-dispatch` #17 (in-flight stale INVALID_DESTINATION neither written nor revoking) |
| Lease renewal | `qa:push-worker` (11 s execution, 10 s lease, not stealable) |
| Logout concurrent with delivery | `qa:push-dispatch` #18b (logout between selection and send: skipped); `qa:push-pipeline`: 6 confirms ∥ logout, all 201, 0 sends started after revocation |
| Concurrent booking transitions | `qa:push-pipeline` (8 confirms across 2 instances: 1 × 201 + 7 × 409, one notification, one job, delivered once); `qa:booking-events` |
| Deadlocks / 5xx | 0 in every suite that measures them |

### E. Deadline and retry

| Case | Evidence |
|---|---|
| Expired jobs never sent | `qa:push-pipeline` (application worker expires an overdue job, 0 rows); `qa:push-worker` #16; `qa:push-dispatch` #25 (< 1 s left → no send) |
| Retry-After / quota | `qa:push-worker` (Retry-After 120 s wins; quota ≥ 60 s despite Retry-After 1 s); `qa:push-dispatch` #11 (60 s) |
| Bounded backoff | `qa:push-worker`: 30 s then 60 s (exponential); unit spec covers the cap and ±20% jitter |
| Max attempts | `qa:push-worker` #14; `qa:push-pipeline` partial delivery (3 → FAILED) |
| Configuration failure never revokes | `qa:push-dispatch` #12; `qa:push-pipeline` (≥ 5 min retry, no device revoked) |
| Disabled mode never contacts Firebase | `qa:push-pipeline` phase 3; `qa:push-worker` (firebase mode with worker off: no Google traffic); BE06-04 spec (no initialization) |

## 6. Security invariants (all held)

1. A notification is only ever sent to devices of **its** recipient. Enforced by the composite FK `(push_device_id, recipient_user_id) → push_devices(id, user_id)`; a cross-user row is rejected with 23503.
2. Eligibility is re-checked immediately before every external send, with the **same SQL** as target selection.
3. No stale worker can write a per-device outcome, renew a lease, revoke a device or change job state after its lease was taken over (fenced on the per-claim token).
4. Only `INVALID_DESTINATION` revokes, and only the exact registration row. It is kept if it re-registered after the attempt.
5. No FID, token, lease token, credential or notification content in logs or send rows. QA checked 18 / 55 / 33 suite-specific values.
6. Reject / cancel / no-show free text never reaches notifications or pushes.
7. A failed business transaction leaves no inbox row and no job. A failed push never removes an inbox row.

## 7. Architecture review

### A. Devices registered after a job's first attempt

**Behaviour, verified in `qa:push-pipeline` A:** each attempt calls `findSendTargets` afresh, minus devices with a final row.

- A device registered **after attempt 1** receives the notification **on the next attempt**, if one happens. The run showed `A:ACCEPTED@1`, `D(new):ACCEPTED@2`; A was not re-sent.
- If the job is already DONE (no retry was needed), a later device does not receive it.

**Assessment:**

- **Secure:** only devices of the same recipient that pass the full eligibility check.
- **Deterministic, but dependent on whether a retry happens.** That is acceptable for a push (the inbox is the source of truth) and is the natural "deliver to the user's current devices" semantics.
- **No correctness defect, so no redesign.** BE06-06's note "not included in that attempt" remains accurate; this section is the precise statement.

### B. Firebase project isolation

- Registrations carry no project id (P3-BE05). Isolation relies on one database plus one `FIREBASE_PROJECT_ID` per environment.
- A foreign-project token produces FCM `SENDER_ID_MISMATCH`. The SDK maps that to `messaging/mismatched-credential`, **the same code as `PERMISSION_DENIED`** (a genuine credential or IAM problem). The adapter therefore cannot tell them apart per device, and classifies both as `CONFIGURATION`.
  - **Safe:** never revokes. A genuine global misconfiguration must not wipe every device.
  - **Cost:** the affected job retries slowly (≥ 5 min) and then FAILS after max attempts. In that same attempt, up to 4 devices are already in flight, and their outcomes are kept (QA: the healthy device was ACCEPTED and recorded alongside `mockAuth`). Devices beyond the 4 concurrent sends wait for the next attempt. The foreign token is never cleaned up, so the same user's later jobs keep ending in `CONFIGURATION`.
- **Future hardening (not implemented):**
  - (a) record the registration's Firebase project (or app id) at P3-BE05 registration and filter by `FIREBASE_PROJECT_ID`; or
  - (b) when `mismatched-credential` occurs on one device while another device in the **same attempt** was ACCEPTED (which proves the credentials are fine), record it as a per-device `INVALID_REQUEST`, still without revoking.
  - Both need product or FE input. **Not a blocker** while every environment uses its own database.

### C. Retention

**What accumulates:**

- **Jobs:** one `notification_deliveries` row per notification while push is enabled (each booking event yields 1 + ACTIVE-staff-count notifications). Terminal jobs (`DONE`, `FAILED`, `EXPIRED`) are never deleted today.
- **Per-device rows:** about one `notification_push_sends` row per eligible device per notification. They are removed only by cascade, when the job is deleted, or when P3-BE05 deletes revoked device rows after 30 days.
- **Indexes:** `idx_notification_deliveries_finished (completed_at) WHERE status IN ('DONE','FAILED','EXPIRED')` already exists for cleanup.

**Recommendation for a future hardening task (not implemented):**

- **Retention:** 30 days for `DONE` / `EXPIRED`, and 90 days for `FAILED` (diagnostics). Per-device rows follow their job by cascade. **Never** touch `PENDING` / `PROCESSING`. Inbox notifications are unaffected (separate P3-BE04 policy).
- **Mechanism:** batched deletes by the existing index, run hourly from the worker tick (or a separate scheduled command) on any instance:

  ```sql
  DELETE FROM notification_deliveries
   WHERE id IN (SELECT id FROM notification_deliveries
                 WHERE status IN ('DONE','EXPIRED') AND completed_at < now() - interval '30 days'
                 ORDER BY completed_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
  ```

  Concurrent instances never block each other this way.
- **Safe to delete:** jobs are only ever created inside the business transaction that created the notification. Removing a finished job can never cause a re-send.
- **Before enabling:** add a QA check that purging never removes non-terminal jobs, and that inbox rows survive.

## 8. Migration readiness observations (no preflight; that is BE06-08)

- **Entities match the migration:** every suite that migrates a fresh database reports **0 pending DDL** after all 15 migrations, including the BE06-06 additions.
- **Expected objects exist:**
  - tables `notification_deliveries`, `notification_push_sends`;
  - triggers `trg_notification_deliveries_guard`, `trg_notification_push_sends_immutable`;
  - keys `uq_notifications_id_recipient`, `uq_notification_deliveries_id_recipient`, `uq_push_devices_id_user`, `fk_notification_deliveries_notification`, `fk_notification_push_sends_delivery`, `fk_notification_push_sends_device`.

  (`qa:push-pipeline` §0, `qa:push-dispatch` §0.)
- **Down/up rehearsals pass** in `qa:push-outbox`, `qa:push-dispatch` (removes only BE06 objects, data intact), `qa:push-devices` and `qa:notifications` (their own rehearsals run with the BE06 migration on top).
- The 14 earlier migrations are unmodified. `pet_care_db` is still at 14 with no BE06 objects.
- **Note for BE06-08:** the migration now adds UNIQUE constraints on the existing `notifications` and `push_devices` tables. Building them scans those tables; this is trivial at development size but should be timed on the dump copy.

## 9. Bugs

**No product defect found.** No application source was modified in BE06-07. The new QA suite passed on its first run and again on a second run.

## 10. Remaining risks

1. At-least-once delivery. A crash between provider acceptance and persistence, or an ambiguous timeout, can duplicate a push (QA #16). The per-notification tag / APNs collapse id is the mitigation.
2. A send already in flight cannot be recalled by a concurrent logout or transfer.
3. Firebase project mismatch is job-level `CONFIGURATION` and is never cleaned up (§7B).
4. Finished jobs and per-device rows grow without bound until retention is implemented (§7C).
5. No live Firebase verification yet: the real Admin SDK has only been exercised with a fake credential and no network.
6. Development and production startup now require explicit push configuration in deployed environments (`PUSH_DELIVERY_MODE` when `NODE_ENV` is `production` or `staging`).

## 11. BE06-08 prerequisites

- Commit (user decision) the BE06-06 and BE06-07 working tree on top of `90b0012`.
- **Development migration preflight on a verified copy of `pet_care_db`:**
  - backup and checksum;
  - official migrate on the copy (15/15, 0 pending);
  - data preservation;
  - time to build the new UNIQUE constraints;
  - the new build on the *unmigrated* copy (expected: booking transitions fail **only** if push is enabled, because enqueue is a no-op when disabled; verify);
  - the previous build `90b0012`/`a135ed7` on the *migrated* copy;
  - rollback (`migration:revert`) rehearsal and runbook.
- **Deployment configuration for development:** keep `PUSH_DELIVERY_MODE` unset (disabled) and `PUSH_WORKER_ENABLED=false` unless a controlled push test is planned.
- Optional, operator-provided: a non-production Firebase project and service account (ADC, never committed) plus a real web-client FID, for one controlled live send.
- Decide on the retention task (§7C) and the project-isolation hardening (§7B).
- Authorization to drop the leftover `pawflow_qa_push_delivery` database, if desired.
