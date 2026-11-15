# P3-BE07-03 — Push Consent Enforcement in the Delivery Executor

**Status:** implemented and QA'd on disposable databases (2026-11-09). Not committed. Migration `1797000000000` is **not** applied to `pet_care_db`.

**Policy:** the approved BE07 policy (contract §3, §10). This document records how that policy is enforced in the BE06 delivery pipeline.

## 1. Rule

A notification may be sent to Firebase only if, at the moment of the check:

```text
preference row exists AND push_enabled AND notification.created_at >= push_enabled_at
```

- A missing row means OFF.
- The comparison runs **inside PostgreSQL**, at microsecond precision. A JavaScript `Date` keeps only milliseconds, so comparing in JS would treat a notification created a few µs *before* the opt-in as inside the period. QA verifies this case.
- The boundary is inclusive: `created_at == push_enabled_at` is allowed.

Consent is independent of:

- browser permission;
- device registration (opted in with no device → `NO_DESTINATIONS`);
- the inbox, which is never affected.

## 2. Where it is checked

### Single read

`NotificationPreferencesService.getPushConsentForNotification(userId, notificationId)` runs one statement:

```sql
SELECT COALESCE(p.push_enabled, false) AS opted_in,
       COALESCE(p.push_enabled AND n.created_at >= p.push_enabled_at, false) AS in_epoch
  FROM notifications n
  LEFT JOIN notification_preferences p ON p.user_id = n.recipient_user_id
 WHERE n.id = $1 AND n.recipient_user_id = $2
```

- Fresh read on every call. No cache and no process-local state, so every backend instance sees the same committed value.
- Returns `null` if the notification no longer exists for that recipient.
- Throws on any database error.

The older `getPushConsentForDelivery(userId)` (BE07-02) is kept but the dispatcher does not use it, because comparing its `optedInSince` in JS has the millisecond-precision problem above.

### Boundaries in `PushDispatchExecutor`

| Boundary | Position | Result when not allowed |
|---|---|---|
| **A**: attempt start | after the notification is loaded; before `findSendTargets` | `SUPPRESSED`. No device lookup, no send. |
| **B**: before each device send | in `dispatchOne`, before the P3-BE05 `isSendEligible`, `renewLease`, the deadline/abort checks and `provider.send` | Stops new sends in this attempt; the aggregate is `SUPPRESSED`. |

Every consent read is bounded by `CONSENT_TIMEOUT_MS = 5 s`.

### Outcome

- New `JobExecutionOutcome` `{ kind: 'SUPPRESSED', reason: 'PUSH_OPTED_OUT' }`.
- `decideTransition` maps it to **DONE** with category `PUSH_OPTED_OUT` and code `pawflow/push-opted-out`, regardless of the attempt number.
- It is never retried and never `FAILED`. Re-enabling push does not reopen the job (QA: `claimed = 0` after re-enabling).
- No schema change to `notification_deliveries`.

**Aggregate priority:**

1. `DISABLED`
2. **opt-out → `SUPPRESSED`**
3. notification gone → `TERMINAL NOTIFICATION_MISSING`
4. `CONFIGURATION`
5. `INVALID_PAYLOAD`
6. `LEASE_LOST`
7. `RETRY`
8. `DELIVERED` / `NO_DESTINATIONS`

An authoritative opt-out wins over a transient failure in the same attempt, so the job is not retried.

## 3. Fail-closed behaviour

| Condition | Executor result | Job |
|---|---|---|
| DB unreachable, missing table, query error | `RETRY TRANSIENT pawflow/consent-unavailable` (`ambiguous: false`) | `PENDING` with the existing backoff, attempt counted, existing `max_attempts` / `expires_at` limits. Never `DONE` / `PUSH_OPTED_OUT`. |
| Read hangs | Bounded by the timeout, then same as above | Same as above |
| Failure at boundary B after earlier sends | Earlier per-device rows stay; no further sends; `RETRY` | The next attempt skips finalized devices (BE06 logic) and checks consent again. |

Never sent on error: no Firebase call happens unless consent was read as allowed for that device send.

**Logging:** job id, error class and SQLSTATE only. No user content, registration values or tokens.

## 4. Unavoidable race (no zero-send claim)

**No transaction spans a Firebase request.** If boundary B passed before an opt-out commit became visible, that send goes out:

- It is recorded if the lease is still held.
- It is not recorded if the lease was lost (stale worker, BE06 fencing).
- It cannot be recalled. FCM may still deliver accepted messages to offline devices later, within the TTL.

**What is guaranteed:** once the opt-out has committed, no new send starts in any attempt or instance whose next consent read sees it, because every send is preceded by a fresh read.

**What is not claimed:** any upper bound on how many already-dispatched pushes still arrive.

Both cases are shown in QA:

- check 9: in-flight send completes, the next device is not sent;
- check 27: a stale worker's in-flight result is not recorded, and the new lease owner suppresses the job.

## 5. Interaction with existing guarantees

**Unchanged:** lease, heartbeat, fencing, claim (`SKIP LOCKED`), retry/backoff, deadline, graceful stop and per-device idempotency (`notification_push_sends`).

**P3-BE05 eligibility still applies after the consent gate:**

- revoked session → `NO_DESTINATIONS`;
- suspended account → `NO_DESTINATIONS`;
- rotated registration → only the new value is used;
- account switch on a shared installation → the previous account's registration is revoked; the new account is OFF by default.

**Untouched:** booking event mapping, inbox persistence, device lifecycle, the Firebase provider, the worker and the retry engine.

## 6. Files

**Production:**

- `src/notification-preferences/notification-preferences.service.ts`: `getPushConsentForNotification`, `NotificationPushConsent`.
- `src/push-delivery/dispatch/push-dispatch.executor.ts`:
  - consent dependency;
  - `checkConsent` (bounded; maps errors to `UNAVAILABLE`);
  - boundaries A and B;
  - aggregate.
- `src/push-delivery/worker/delivery-job.types.ts`: `SUPPRESSED` outcome.
- `src/push-delivery/worker/retry-policy.ts`: `SUPPRESSED` → DONE `PUSH_OPTED_OUT`.
- `src/push-delivery/push-delivery.module.ts`: imports `NotificationPreferencesModule` and injects the service into the executor factory.

**Tests:**

- `src/push-delivery/dispatch/push-consent.spec.ts` (new unit tests);
- `test/qa/push-consent.cjs` (new PostgreSQL/HTTP QA, `npm run qa:push-consent`).

**BE06 fixtures updated (setup only, assertions unchanged):**

- `push-dispatch.executor.spec.ts`: explicit consent stub that allows sending;
- `test/qa/push-dispatch.cjs` and `test/qa/push-pipeline.cjs`: every recipient opts in through the real `PATCH /notification-preferences` right after registration, before any of its notifications exist; real consent service passed to the executor;
- `test/qa/push-worker.cjs`: the boot-case user gets an opted-in preference row.

No test-only bypass exists. Enforcement is always on.

## 7. Verification (2026-11-09)

All suites ran sequentially on disposable `pawflow_qa_*` databases, with the mock provider only. No Firebase traffic.

| Check | Result |
|---|---|
| `push-consent.spec.ts` + existing executor spec + preferences spec (`src/push-delivery`, `src/notification-preferences`) | 6 suites, 158/158 |
| Focused Jest incl. notifications + push-devices | 8 suites, **230/230** |
| **`qa:push-consent`** (new) | **30/30** |
| `qa:notification-preferences` | 30/30 |
| `qa:push-dispatch` | 38/38 |
| `qa:push-pipeline` | 18/18 |
| `qa:push-worker` | 33/33 |
| `qa:push-outbox` | 28/28 |
| `qa:booking-events` | 32/32 |
| `qa:notifications` | 43/43 |
| `qa:push-devices` | 49/49 |
| tsc (`--noEmit`) / build | clean / OK |
| lint | 0 errors, 1 pre-existing warning (`bot-protection.cjs`) |

**Key evidence from `qa:push-consent`:**

- **Critical scenario** (A ACCEPTED, B `RATE_LIMITED`, C unsent, then opt-out):
  - attempt 1 → `PENDING/RATE_LIMITED`;
  - after the opt-out → `DONE/PUSH_OPTED_OUT`;
  - sends per device (A, B, C) = 1, 1, 0;
  - rows = `A:ACCEPTED@1`;
  - inbox intact;
  - re-enabling claims 0 jobs.
- **Boundary:**
  - equal timestamps → delivered;
  - +1 µs → suppressed;
  - same millisecond but earlier by µs → suppressed.
- **Fail closed:**
  - DB unreachable, missing table (42P01), hanging read (bounded at 300 ms in the test), mid-attempt read failure → job `PENDING` with `pawflow/consent-unavailable`, no send;
  - after recovery the retry delivers.
- **Account switch on a shared installation:**
  - A → `NO_DESTINATIONS`;
  - B (default OFF) → `PUSH_OPTED_OUT`;
  - 0 pushes to the installation;
  - inboxes separate.
- **Stale lease + opt-out:**
  - the stale worker's in-flight result is not recorded (`LOST_LEASE`);
  - the new owner ends the job `PUSH_OPTED_OUT`;
  - the 2nd device is never sent.
- **20 concurrent ON/OFF requests on 2 instances:**
  - all 200;
  - the final committed state decides;
  - every pre-period job is suppressed.
- **Multi-instance with real bookings:**
  - preferences changed through instance A; the application's own worker runs on instance B;
  - owner (device registered, never opted in) → `BOOKING_CREATED` suppressed, still in the inbox;
  - customer (opted in) → `BOOKING_CONFIRMED` ACCEPTED;
  - an opt-out made through A is honoured by B.
- **Global:**
  - no registration values, passwords, JWT secret or tokens in logs;
  - 0 HTTP 5xx;
  - 0 deadlocks.

**After the runs:**

- only the old `pawflow_qa_push_delivery` remains;
- `pet_care_db` still has 15 migrations and no `notification_preferences` table.

**QA correction during development (test code only):** the first run of the multi-instance booking case looked the booking notification up by `target_id` alone. That collided with synthetic notifications that also use `BOOKING`/1, so it read the wrong row. The product had delivered correctly (notification 31 was `DONE`/ACCEPTED). The lookup now also filters by recipient; the assertion strength is unchanged.
