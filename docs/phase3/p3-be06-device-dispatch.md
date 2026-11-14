# P3-BE06-06 — Device Eligibility, Firebase Dispatch & Per-Device Persistence

Status: **implemented and QA-verified (BE06-06)**.

- No live Firebase call (QA used the BE06-04 mock provider).
- The pending migration `1796500000000` was extended. It has **not** been applied to `pet_care_db`.
- Development stays on `PUSH_DELIVERY_MODE` unset (disabled) and `PUSH_WORKER_ENABLED=false`.

Code:

- `src/push-delivery/dispatch/push-dispatch.executor.ts`: `PushDispatchExecutor`, registered as `DELIVERY_JOB_EXECUTOR`
- `src/push-delivery/entities/notification-push-send.entity.ts`
- Fenced per-device writes in `PushJobStore`, exposed to the executor through `DeliveryJobContext`
- `PushDevicesService.isSendEligible`

QA: `test/qa/push-dispatch.cjs` (`npm run qa:push-dispatch`).

## 1. Confirmed design decisions (from the real code)

| Decision | Basis |
|---|---|
| One outbox job = one recipient notification | `notification_deliveries.notification_id` is UNIQUE; the composite FK ties `recipient_user_id` to the notification (BE06-02) |
| One notification may have several devices | `findSendTargets(userId)` returns every eligible registration of the user (one per live session, P3-BE05) |
| The job is not DONE while a retryable destination remains | The executor returns `RETRY` whenever a device ended TRANSIENT or RATE_LIMITED, or was not attempted |
| Final device outcomes persist between attempts | `notification_push_sends` (insert-only); the executor skips devices that already have a row |
| Every write is protected against stale leases | Per-device insert and lease renewal are fenced on the claim's token (§5); job state writes were already fenced (BE06-05) |

## 2. Per-device persistence: `notification_push_sends`

Added to the pending migration `1796500000000-CreateNotificationDeliveries`. `down` removes it.

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `delivery_id`, `recipient_user_id` | FK `(delivery_id, recipient_user_id) → notification_deliveries(id, recipient_user_id)` ON DELETE CASCADE |
| `push_device_id` (+ `recipient_user_id`) | FK `(push_device_id, recipient_user_id) → push_devices(id, user_id)` ON DELETE CASCADE. **The device must belong to the job's recipient.** |
| `outcome` | `ACCEPTED` \| `INVALID_DESTINATION` \| `INVALID_REQUEST`, final device outcomes only |
| `provider_code` | Sanitized code token; NULL **iff** ACCEPTED; pattern `^[A-Za-z0-9/._:-]{1,100}$` |
| `attempt` | Job attempt that produced it (1–1000) |
| `attempted_at`, `finalized_at` | When the send started, and when it was persisted |

**Constraints and triggers:**

- `UNIQUE (delivery_id, push_device_id)` is the deduplication key (§3).
- `trg_notification_push_sends_immutable` refuses every UPDATE (insert-only).
- `idx_notification_push_sends_device` supports cascades.

**Supporting uniques**, both implied by the primary keys, so there is no data change. Entities are updated, and QA confirmed 0 pending DDL:

- `uq_notification_deliveries_id_recipient`
- `uq_push_devices_id_user`

**Never stored:** FID or token values, the message, the FCM message id, credentials, or personal data beyond ids.

`TRANSIENT`, `RATE_LIMITED`, `CONFIGURATION` and `INVALID_PAYLOAD` are **not** per-device rows. The first three are retried. `INVALID_PAYLOAD` fails the whole job.

## 3. Deduplication key and registration generations

P3-BE05 never reuses a `push_devices` row for a different registration:

- Rotation (new FID or token on the same session) and transfer (the same installation registered by another session or account) **revoke the old row and insert a new one**.
- A same-value re-registration only advances `last_seen_at`.
- The `push_devices` guard trigger makes the kind, hash, ciphertext, user and session immutable, and a revoked row can never change.

Therefore **`push_devices.id` is the registration generation**, and `UNIQUE (delivery_id, push_device_id)` cannot let an old generation's outcome suppress a new registration. QA case 23 confirms rotation reaches the new row. No extra generation column is needed.

## 4. Device eligibility and account isolation

- **Selection:** `findSendTargets(recipient)`, which applies the P3-BE05 rules:
  - active registration of that user;
  - session of the same user (composite FK), not revoked, not expired;
  - account `ACTIVE`;
  - seen within `PUSH_DEVICE_STALE_DAYS`.
- **Re-check before every external send:** `isSendEligible(deviceId, recipient)` runs **exactly the same SQL** (a shared `SEND_ELIGIBLE_FROM_WHERE`), so the two cannot drift.
  - A device rotated, transferred, logged out (logout, logout-all, password change or reset, refresh-token reuse) or suspended since selection is skipped. It is not recorded and not sent.
  - QA covers logout, logout-all, password reset, suspension, rotation, transfer, and a logout *between* selection and send (18b).
- **The recipient is fixed by the job.** Devices of other users are never selected, and the database refuses a send row linking a job to another user's device (FK, 23503).
- **Account switch (QA case 22):**
  - A's old job sends nothing to the installation now registered by B.
  - B's job reaches it once.
  - A's inbox keeps the notification; B's inbox never shows it.
  - A's revoked session cannot register again (401).
  - Transfer while A is still logged in behaves the same way (22b).
- **Firebase environment:** P3-BE05 registrations carry no project tag. Isolation comes from one database and one `FIREBASE_PROJECT_ID` per environment. A token from another project yields `messaging/mismatched-credential`, which BE06-04 classifies as `CONFIGURATION`: the job retries slowly and then fails, and devices are never revoked. This is a known limitation (§10).

## 5. Dispatch flow and lease fencing

For each claimed job, **without** an open database transaction during provider calls:

1. Provider `disabled` → `DISABLED`.
2. Re-read the notification (scoped to the recipient). If it is missing → `TERMINAL NOTIFICATION_MISSING`.
3. `ctx.finalizedDevices()`, then `findSendTargets` minus the devices that already have a final row.
4. Per device, up to **4 concurrently**:
   - stop if the signal is aborted or a shared failure, quota error or lost lease was seen;
   - stop if **less than 1 s** of the delivery window is left;
   - `isSendEligible`;
   - `ctx.renewLease()`, a fenced check-and-extend: false means the lease was lost and the signal aborts;
   - `provider.send(kind/value, message + ttlSeconds = remaining window)`;
   - `ctx.recordDeviceOutcome` immediately, a **fenced insert**: the job row is locked FOR SHARE and must still be PROCESSING under this claim's token, otherwise the result is `LEASE_LOST` and nothing is written;
   - on `INVALID_DESTINATION`, after a successful record, `markInvalid(deviceId, attemptedAt)`.
5. Aggregate (§7). The worker applies the BE06-05 retry, backoff and deadline policy. No new retry logic was added.

The executor never sees the lease token. The worker binds `renewLease` / `finalizedDevices` / `recordDeviceOutcome` to the claim. A `LEASE_LOST` result aborts the attempt, and the worker discards it.

## 6. Provider outcome handling

| Provider result | Per device | Job |
|---|---|---|
| `ACCEPTED` | Row `ACCEPTED`; never re-sent | — |
| `INVALID_DESTINATION` | Row `INVALID_DESTINATION` + `markInvalid` for **this row only**. It is kept if the device re-registered after the attempt (`last_seen_at > attempted_at`, QA 24b). A delayed result for a rotated-away row cannot touch the new row (QA 24). | — |
| `INVALID_REQUEST` | Row `INVALID_REQUEST`; **no revocation** | — |
| `INVALID_PAYLOAD` | No row; **no revocation** | Stop; `TERMINAL INVALID_PAYLOAD` → FAILED |
| `TRANSIENT` | No row (retried); ambiguity flag kept | `RETRY TRANSIENT` |
| `RATE_LIMITED` | No row; **no new sends this attempt** | `RETRY RATE_LIMITED`, largest `retryAfterMs` (worker: ≥ 60 s) |
| `CONFIGURATION` | No row; **no revocation**; stop | `CONFIGURATION` (worker: ≥ 5 min, then FAILED) |
| `DISABLED` | — | `DISABLED` → FAILED (`PUSH_DISABLED`). The worker cannot be enabled with push disabled. |

## 7. Aggregate outcome and partial delivery

Priority:

1. `DISABLED`
2. `CONFIGURATION`
3. `TERMINAL` (payload)
4. Lease lost → `RETRY` (discarded by the worker)
5. Any device unresolved (TRANSIENT, RATE_LIMITED, not started because of deadline or abort) → `RETRY`. Deadline gives `pawflow/deadline-reached`, which the worker turns into EXPIRED; abort gives `pawflow/dispatch-aborted`.
6. Otherwise: `DELIVERED{accepted, failedFinal}`, counting rows from earlier attempts too. If nothing was ever final → `NO_DESTINATIONS`.

**One device succeeding never completes the job.** QA critical case (13/14):

- Attempt 1: A ACCEPTED, B TRANSIENT, C INVALID_DESTINATION. The job is PENDING, rows A@1 and C@1 exist, and C is revoked.
- Attempt 2: only B is sent. Final sends were A 1, B 2, C 1, and the job is DONE.

A device that becomes ineligible between attempts is simply dropped from later attempts. The job does not wait for it.

## 8. Crash recovery (QA, real SIGKILL of a child worker)

| Point | Result |
|---|---|
| After A's outcome was saved, B in flight (15) | A's row survives; recovery skips A and sends B; A sent **exactly once** |
| After the provider accepted A, before the row was saved (16) | No row; recovery **sends A again** and saves attempt 2. This is the unavoidable at-least-once duplicate. |
| Lease taken over while a send was in flight (17) | The stale worker's late `INVALID_DESTINATION` is **not written** and the device is **not revoked**; the new owner writes all rows |
| Worker cancelled mid-job (26) | No new send after the abort; outcomes already obtained are kept; recovery sends only the untouched device; each device exactly once |
| Two worker instances (27) | 10 jobs × 2 devices: 20 sends, 20 distinct (job, device) pairs, 20 rows |

## 9. Remaining unavoidable duplicate-send and race risks

- **At least once, never exactly once.** A send that FCM accepted but whose row was not persisted is repeated after a crash, lost connection or lease loss. A `TRANSIENT` ambiguous result (timeout) may also have been delivered. Mitigation: the per-notification tag / APNs collapse id (BE06-04) makes the device replace, not stack, the duplicate.
- **External send race:** a send already submitted to FCM cannot be recalled. If the user logs out, or the installation is transferred, *during* that call, that single in-flight push can still arrive. The re-check happens immediately before the call. It narrows the window but cannot close it.
- **Registrations created after a job's target selection** are not included in that attempt. The inbox always has the notification.

## 10. Limitations

- Registrations have no Firebase project tag (P3-BE05). A foreign-project token is a job-level `CONFIGURATION` failure, not a per-device one.
- The FCM message id is not stored (support diagnostics rely on the job and device ids).
- Live Firebase verification with a real FID is still outstanding (BE06-08 or later, with operator credentials).
