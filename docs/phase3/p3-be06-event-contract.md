# P3-BE06-01 — Booking Event Contract & Notification Mapping

Status: **audit and contract only.** Nothing in this document is implemented by BE06-01.
Baseline: branch `feature/notification-inbox`, HEAD `a135ed7` (14 migrations).
All source references point to the **committed** code at `a135ed7` (`git show HEAD:<path>`).
The working tree also holds an uncommitted draft from an earlier, interrupted P3-BE06 attempt (see §8). That draft was **not** used as the source of truth for this audit.

---

## 1. Booking lifecycle inventory

### 1.1 Statuses (no new states are introduced)

Defined in `src/bookings/entities/booking.entity.ts` (`chk_bookings_status`). `booking_status_logs` uses the same set (`chk_booking_logs_old_status`, `chk_booking_logs_new_status`).

| Status | Meaning | Terminal |
|---|---|---|
| `PENDING_CONFIRMATION` | Created by the customer; holds one unit of slot capacity | no |
| `CONFIRMED` | Accepted by the provider (owner or ACTIVE staff) | no |
| `REJECTED` | Declined by the provider; capacity released | yes |
| `CANCELLED` | Cancelled by the customer; capacity released | yes |
| `COMPLETED` | Service delivered; enables payment management and reviews | yes |
| `NO_SHOW` | The customer did not attend | yes |

### 1.2 Transitions (the only ones in the code)

All of them are in `src/bookings/bookings.service.ts`:

| # | Operation (endpoint → method) | From → To | Actor (role guard) | Lines @HEAD |
|---|---|---|---|---|
| T1 | `POST /bookings` → `createBooking` / `createBookingIdempotently` → `insertBooking` | ∅ → `PENDING_CONFIRMATION` | `CUSTOMER` | 53, 81, 171 (log save 322) |
| T2 | `POST /bookings/provider/:id/confirm` → `confirmProviderBooking` | `PENDING_CONFIRMATION` → `CONFIRMED` | `PROVIDER_OWNER` / `PROVIDER_STAFF` | 397 (log 418) |
| T3 | `POST /bookings/provider/:id/reject` → `rejectProviderBooking` | `PENDING_CONFIRMATION` → `REJECTED` | `PROVIDER_OWNER` / `PROVIDER_STAFF` | 467 (log 493) |
| T4 | `POST /bookings/mine/:id/cancel` → `cancelMyBooking` | `PENDING_CONFIRMATION` or `CONFIRMED` → `CANCELLED` | `CUSTOMER` | 432 (log 453) |
| T5 | `POST /bookings/provider/:id/complete` → `completeProviderBooking` → `transitionConfirmedProviderBooking` | `CONFIRMED` → `COMPLETED` | `PROVIDER_OWNER` / `PROVIDER_STAFF` | 507, 570 (log 588) |
| T6 | `POST /bookings/provider/:id/no-show` → `noShowProviderBooking` → `transitionConfirmedProviderBooking` | `CONFIRMED` → `NO_SHOW` | `PROVIDER_OWNER` / `PROVIDER_STAFF` | 519, 570 (log 588) |

The role guards are in `src/bookings/bookings.controller.ts` (`@Roles` at lines 78, 200, 281, 310, 343, 369).

The state machine is a **forward-only DAG**. Each status can be reached **at most once** per booking, and no transition re-enters an earlier state.

**Paths that do not change booking status** (checked so nothing is missed):

- `AvailabilityService.deactivateMySlot` (`src/availability/availability.service.ts:351`) sets the **slot** to `CANCELLED`. Bookings on that slot are left untouched, and no booking status log is written.
- Admin provider suspension and user suspension do not modify bookings.
- `PaymentsService` (`src/payments/payments.service.ts:51`) only manages payments of `COMPLETED` bookings. It does not change the booking status.

### 1.3 Relationships used for recipients

- `bookings.customer_id` → the customer.
- `bookings.provider_id` → `providers.owner_id` (always present, FK) is the provider owner.
- `provider_staff(provider_id, user_id, status)`:
  - `user_id` is **unique** (`provider-staff.entity.ts`), so a staff user belongs to at most one provider.
  - Only `status = 'ACTIVE'` rows may manage bookings (`resolveManagedProviderId`, line 532).
  - Deactivating a staff member flips their role back to `CUSTOMER` (`providers.service.ts` ~458).

### 1.4 Transaction boundaries

Every transition runs inside one `this.dataSource.transaction(async (manager) => …)` (lines 61, 90, 401, 437, 472, 576). The booking update, the slot capacity change and the `booking_status_logs` insert are all written through `manager`. Rollback is all-or-nothing.

### 1.5 Concurrency and idempotency protection that already exists

- **Transitions T2–T6.** `findLockedBooking` (line 642) uses `SELECT … FOR UPDATE` on the booking row, and the guards check status after taking the lock (`assertPendingConfirmation` 705, `assertConfirmedBooking` 713, `getCancellableStatus` 721).
  - Concurrent identical actions serialise on that lock.
  - Exactly one succeeds. The rest get **409**, write nothing, and so produce no event.
- **Creation T1.**
  - The slot is locked `FOR UPDATE` (line 188), so capacity cannot be double-booked.
  - With an `Idempotency-Key`, `booking_idempotency_keys` (`uq_booking_idempotency_customer_key`) makes a retry **replay** the stored booking (`findIdempotentBooking`, line 132). A replay never calls `insertBooking`, so it never writes a status log and therefore never produces an event.
  - Without a key, every request is a new booking by design, so a new event is correct.
- **Authorization** happens before any write:
  - Another provider's or customer's booking gets 404 (C-01, lines 687–703).
  - A missing role or staff association gets 403.
  - In both cases nothing is written and no event is produced.

### 1.6 Event identity that already exists

`booking_status_logs` (`src/bookings/entities/booking-status-log.entity.ts`) has `id bigint` (generated), `booking_id`, `old_status`, `new_status`, `changed_by` and `reason`. Every successful transition inserts **exactly one** row in the same transaction. `save()` returns the generated `id`, so it is available inside the transaction.

→ **The status-log row is the natural, already-existing event identity.** BE06 needs no new identity column.

---

## 2. Event-to-recipient matrix

Common rules for every row:

- `target = { type: 'BOOKING', id: <bookingId> }`.
- Recipients are derived **only from the locked booking row** (customer, or provider owner plus ACTIVE staff of `booking.provider_id`). They are never taken from request input, so no unrelated user can be selected.
- The **acting user is removed** from the recipient set.
- The recipient set is **de-duplicated**.

| Event | Transition | Notification type | Recipients | Title | Body template |
|---|---|---|---|---|---|
| E1 | T1 ∅ → `PENDING_CONFIRMATION` | `BOOKING_CREATED` | provider owner + ACTIVE staff | New booking request | `{service} for {pet} on {date} at {HH:MM} is waiting for your confirmation.` |
| E2 | T2 → `CONFIRMED` | `BOOKING_CONFIRMED` | customer | Booking confirmed | `Your {service} booking for {pet} on {date} at {HH:MM} was confirmed.` |
| E3 | T3 → `REJECTED` | `BOOKING_REJECTED` | customer | Booking declined | `Your {service} booking for {pet} on {date} at {HH:MM} was declined by the provider.` |
| E4 | T4 → `CANCELLED` | `BOOKING_CANCELLED` | provider owner + ACTIVE staff | Booking cancelled | `The {service} booking for {pet} on {date} at {HH:MM} was cancelled by the customer.` |
| E5 | T5 → `COMPLETED` | `BOOKING_COMPLETED` | customer | Booking completed | `Your {service} booking for {pet} on {date} at {HH:MM} was completed. You can now leave a review.` |
| E6 | T6 → `NO_SHOW` | `BOOKING_NO_SHOW` | customer | Booking marked as no-show | `Your {service} booking for {pet} on {date} at {HH:MM} was marked as a no-show.` |

All six types and the target `BOOKING` already exist in the P3-BE04 catalogue (`src/notifications/notification-types.ts`, `NOTIFICATION_TYPE_TARGETS`). **No migration is needed for types.**

**Payload** (flat, display-only):

`{ bookingId, status, serviceName, petName, slotDate, startTime }`

- Every key passes the P3-BE04 payload validator: none matches `FORBIDDEN_PAYLOAD_KEY`, and there are no URLs.
- String values are truncated to 300 characters (`NOTIFICATION_PAYLOAD_STRING_MAX_LENGTH`).
- The body is kept at 1000 characters or fewer.
- **Excluded on purpose:**
  - customer or staff names, email, phone, address;
  - price;
  - the free-text `reason` of a reject, cancel or no-show. It is user-written text, so it may contain contact data or abuse. It stays visible in the booking detail (`statusLogs`) behind the normal authorization.

**Content source.** The service name, pet name, `slot_date` and `start_time` are read inside the same transaction, joining `bookings → services, pets, availability_slots`.

### 2.1 When no notification is created

| Situation | Why nothing is written |
|---|---|
| Validation, eligibility, capacity or authorization failure (400, 403, 404, 409) | Thrown before the status-log insert; the transaction rolls back |
| A concurrent duplicate action that loses the booking lock | 409 from the status guard |
| Idempotent creation replay (same `Idempotency-Key`) | `insertBooking` is not called; no status log |
| Any rollback after the notification insert | Notifications are part of the same transaction |
| The recipient is the actor | Removed from the set. Example: a user who booked as a customer, later became ACTIVE staff of that provider, and confirms their own booking |
| INACTIVE staff, staff of other providers, admins | Never part of the derived set |
| Slot deactivation, provider or user suspension, payment change | Not booking transitions; out of BE06 scope (see §7) |

**Recipient account not ACTIVE (suspended or inactive).** The inbox row **is still created**. This keeps the history, and the user cannot read it while locked out anyway. Push eligibility (P3-BE05 `findSendTargets`) excludes non-ACTIVE accounts and revoked sessions, so no push is sent.

---

## 3. Existing notification and push contracts (reuse audit)

| API | Location @HEAD | Reusable unchanged? | Notes |
|---|---|---|---|
| `NotificationsService.create(input, manager?)` | `src/notifications/notifications.service.ts:109` | **Yes** | `INSERT … ON CONFLICT (recipient_user_id, event_key) DO NOTHING`. A duplicate returns `{created:false}` and the original row. Runs on `manager` when one is given, so it joins the business transaction. |
| `NotificationsService.createMany(inputs, manager?)` | same file, line 143 | **Yes** | Sequential `create` calls on the caller's manager, or its own transaction when there is none. |
| Input validation `normalizeNotificationInput` | `notification-types.ts` | Yes | Type ↔ target pairing, length limits, event-key pattern `^[A-Za-z0-9:._-]{1,200}$`, payload rules. |
| Schema `notifications` | migration `…CreateNotifications` | Yes | `uq_notifications_recipient_event` (recipient, event_key). NULL keys are not de-duplicated, so BE06 must **always** pass a key. Also: `idx_notifications_recipient_id`, `idx_notifications_recipient_unread`, and an immutability trigger `trg_notifications_guard_update`. |
| `NotificationsModule` exports | `notifications.module.ts` | Yes | Exports `NotificationsService`. Imports only `TypeOrmModule` and `AuthModule`, so there is no cycle with `BookingsModule`. |
| `PushDevicesService.findSendTargets(userId)` | `src/push-devices/push-devices.service.ts:221` | **Yes** (for the delivery side, BE06-03) | Returns only rows with an active registration, a live non-expired session, an ACTIVE account and not stale. Values are decrypted and **must never be logged**. Not transaction-bound; meant for the worker, not the booking transaction. |
| `PushDevicesService.markInvalid(deviceId, attemptedAt)` | same file, line 252 | **Yes** | Idempotent. It will not revoke a device that re-registered after the failed attempt. |
| Session / device revocation | P3-BE01 / P3-BE05 triggers | Yes | Logout, logout-all, suspension and session revocation revoke the session's push device in the database. Delivery only has to re-check eligibility right before sending. |

**Conclusion: no change to the P3-BE04 or P3-BE05 APIs is required.**

---

## 4. Integration design (for BE06-02 / BE06-03; not implemented here)

### 4.1 Methods that need integration

Exactly the four places that insert a `BookingStatusLog`:

1. `insertBooking` (after the log save at line 322). This covers both `createBooking` and `createBookingIdempotently`.
2. `confirmProviderBooking` (after line 418).
3. `cancelMyBooking` (after line 453).
4. `rejectProviderBooking` (after line 493).
5. `transitionConfirmedProviderBooking` (after line 588). This covers both COMPLETED and NO_SHOW.

Recommended shape: one small `BookingEventsService.record(manager, { bookingId, statusLogId, newStatus, actorUserId })`. Each method calls it with the saved log's `id`, right after the log insert and before the method returns its view. The mapping from §2 lives in that service, so `BookingsService` gains one line per transition and **no business rule changes**.

### 4.2 Where inside the transaction

Call `record()` with the **same `manager`**, after the status-log insert. The notification rows then commit or roll back with the transition, so a rolled-back transition can never leave a notification behind.

### 4.3 Event-key strategy

```
eventKey = `booking:${bookingId}:log:${statusLogId}`     // e.g. booking:42:log:1873
```

- It is deterministic for one real transition, and the status-log row is the transition.
- It survives a retry of `record()` inside the same transaction. P3-BE04 `ON CONFLICT` returns `{created:false}`.
- **Repeated legitimate transitions are distinguished** because each real transition has its own log id. This keeps working if a future state machine ever allows re-entering a status. The P3-BE04 doc example `booking:<id>:<STATUS>` would wrongly merge those.
- Length is 40 characters or fewer, well under 200, and it matches the key pattern.

**Alternative considered:** `booking:{id}:{NEW_STATUS}`. It is unique today because the DAG is forward-only, but it would break silently if states can ever be revisited. **Rejected.**

### 4.4 Duplicate requests

| Duplicate kind | Handled by |
|---|---|
| Client retry of creation with an `Idempotency-Key` | Replay path; no log, so no event |
| Concurrent identical transitions | Booking `FOR UPDATE` plus status guard: one winner, the others 409 |
| Double invocation of `record()` in one transaction (bug or retry) | `uq_notifications_recipient_event` plus `ON CONFLICT DO NOTHING` |
| Creation retry **without** a key | A new booking is a legitimate new event (existing P2-07 semantics) |

### 4.5 Connection to the future outbox (BE06-03)

`createMany` returns `{created, notification}` per recipient. Only `created === true` ids are passed, **in the same `manager`**, to the outbox: `delivery.enqueue(manager, ids)`. This means:

- One job per new notification, written atomically with the notification and the booking. This is the transactional outbox.
- Duplicates (`created:false`) are never re-enqueued.
- If push is disabled or not configured, `enqueue` must be a no-op. The booking transaction must never depend on push configuration.

### 4.6 What can be done without touching booking business rules

Everything above. Locks, guards, capacity handling, idempotency keys and response views stay byte-for-byte the same. The only edits to `BookingsService` are:

- an injected collaborator;
- capturing the `save()` result of the status log, which the code already performs but currently discards;
- one `record()` call per transition.

---

## 5. Transaction, locking and failure analysis

1. **Atomicity.** A notification insert failure inside the booking transaction puts PostgreSQL in the aborted state, so the **booking transition fails too**.
   - Possible causes are limited to programming errors (invalid input caught by `NotificationInputError`) or database faults. Recipients come from FKs, so "recipient not found" cannot happen.
   - **Decision: accept atomic failure.** It is consistent and testable.
   - A SAVEPOINT-based "best effort" mode is **not** recommended, because it would silently lose events.
2. **Lock interaction.**
   - Inserting into `notifications` takes `FOR KEY SHARE` on the recipient `users` rows (the FK).
   - That conflicts only with `SELECT … FOR UPDATE` / key updates on those user rows, such as the P3-BE01 suspension lock order user → sessions → tokens.
   - The suspension path does not lock bookings, slots or providers, so **no lock cycle was identified**. The effect is a short wait. BE06-02 should confirm this with a concurrent confirm + suspend test.
3. **Recipient read consistency.**
   - Staff membership is read without a lock (statement snapshot under READ COMMITTED).
   - A staff member deactivated concurrently may still receive one inbox row. That is harmless: the row is navigation only, and access is re-checked by the booking endpoints (403 for INACTIVE staff).
4. **Cost.** Each transition adds 1 + N small inserts (N = recipients, normally ≤ 1 + staff count) and one join query. They run inside a transaction that already holds the booking lock.

---

## 6. Expected `NotificationsService` usage (contract for BE06-02)

```ts
// inside BookingsService.<transition>, same manager, after the status-log save
const log = await bookingLogsRepository.save(bookingLogsRepository.create({ ... }));
await this.bookingEvents.record(manager, {
  bookingId: savedBooking.id,
  statusLogId: log.id,
  newStatus: 'CONFIRMED',
  actorUserId: user.id,
});

// BookingEventsService.record (sketch)
const rule = BOOKING_EVENT_RULES[newStatus];                    // §2 matrix
const d = await loadBookingDetails(manager, bookingId);         // customer, owner, ACTIVE staff, service, pet, slot
const audience = rule.audience === 'CUSTOMER' ? [d.customerId] : [d.ownerId, ...d.activeStaffIds];
const recipients = [...new Set(audience)].filter((id) => id !== actorUserId);
const results = await notifications.createMany(recipients.map((r) => ({
  recipientUserId: r, type: rule.type, title: rule.title, body: rule.body(d),
  payload: { bookingId, status: newStatus, serviceName, petName, slotDate, startTime },
  target: { type: 'BOOKING', id: bookingId },
  eventKey: `booking:${bookingId}:log:${statusLogId}`,
})), manager);
// BE06-03: await delivery.enqueue(manager, results.filter((r) => r.created).map((r) => r.notification.id));
```

**Dependency injection note.** Four existing unit specs construct `new BookingsService(dataSource)` with one argument:

- `bookings.eligibility.spec.ts:129`
- `bookings.idempotency.spec.ts:216`
- `bookings.suspension.spec.ts:133`
- `bookings.views.spec.ts:167`

Use either an `@Optional()` second constructor parameter (no spec churn) or update those specs. `BookingsModule` must import `NotificationsModule`, and `PushDeliveryModule` in BE06-03.

---

## 7. Dependencies for BE06-02 and BE06-03

Assumed split. Please confirm, because this document only defines the contract.

**BE06-02: booking events into the inbox (no push)**

- `BookingEventsService` with the §2 matrix and §4.3 key.
- The five call sites in §4.1. `BookingsModule` imports `NotificationsModule`.
- Unit tests for the matrix, actor exclusion and key format.
- PostgreSQL QA:
  - recipients per transition;
  - INACTIVE staff excluded;
  - replay and concurrent-confirm produce no duplicates;
  - an injected failure rolls back the booking and its notifications;
  - unauthorized transitions produce nothing;
  - concurrent confirm + user suspension (lock check, §5.2).
- **No migration needed** (types and target already exist).

**BE06-03: outbox and push delivery**

- An additive migration for the outbox table (and per-device send results).
- `enqueue(manager, ids)` that is a no-op when push is disabled.
- A worker that claims jobs with `FOR UPDATE SKIP LOCKED` and leases, re-checks eligibility via `findSendTargets`, and calls `markInvalid` only for UNREGISTERED.
- The Firebase Admin provider, retry and backoff policy, admin stats, and migration preflight.

**Missing capabilities found: none blocking.**

- Event identity (`booking_status_logs.id`), transaction plumbing (`manager`) and de-duplication (`uq_notifications_recipient_event`) all exist.
- The only code-level gap is that the status-log `save()` result is currently discarded. BE06-02 captures it.

---

## 8. Unresolved decisions and risks

| # | Item | Proposed default | Needs owner decision? |
|---|---|---|---|
| R1 | **Uncommitted draft in the working tree** from the interrupted earlier P3-BE06 attempt. It contains `src/bookings/booking-events.service.ts`, `src/push-delivery/`, migration `1796500000000-CreateNotificationDeliveries.ts`, `test/qa/push-delivery.cjs`, and edits to `bookings.service.ts`, `bookings.module.ts`, `app.module.ts` and `package*.json` (adds `firebase-admin`). Its event mapping and key match this contract, but its QA never completed. | Keep untouched. In BE06-02, either adopt the matching parts (after review) or stash or discard the draft. Do not count it as verified. | **Yes** |
| R2 | A leftover disposable database, `pawflow_qa_push_delivery`, from the interrupted QA run. `pet_care_db` was not touched. | Drop it at the start of the next QA run (the QA harness recreates it anyway). | Low |
| R3 | Should the free-text `reason` of reject, cancel or no-show appear in the notification? | No (privacy and abuse risk); it remains in the booking detail | Yes (product) |
| R4 | Customers of a deactivated slot (`deactivateMySlot`) are not told. Bookings remain as they are. | Out of BE06 scope; existing behaviour | Product |
| R5 | `PAYMENT_STATUS_CHANGED` type exists, but payment changes are not booking transitions. | Not in BE06; later task | Roadmap |
| R6 | Recipient whose role changed (for example a customer who became staff) gets a target that their current role cannot open (403 from `/bookings/mine`). | Accept. The target is navigation only, and access is re-checked. | No |
| R7 | Lock wait between notification FK `KEY SHARE` and user `FOR UPDATE` (suspension) | Verify with a concurrent test in BE06-02 | No |
| R8 | Content language: titles and bodies are English, consistent with existing API messages. | Keep; localisation is out of scope | Product |
