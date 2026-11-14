# PawFlow — Notification Inbox (P3-BE04)

Persistent, per-user in-app notifications with list / detail / unread count / mark-as-read APIs, plus an internal creation service for event producers.
Verified by `npm test` (unit) and `npm run qa:notifications` (real HTTP + PostgreSQL, two instances, 150,000-row scale check).
Source: `src/notifications/*`, migration `1795500000000-CreateNotifications`.

Out of scope here: producing notifications from business events (P3-BE06), push/FCM (P3-BE05/06), preferences (P3-BE07).

## 1. Model

| Field | Notes |
|---|---|
| `id` | BIGINT, returned as a string. Creation order; the inbox sorts by it, newest first. |
| `type` | One of the catalogue in §2 (CHECK constraint). |
| `title` (≤150), `body` (≤1000) | Snapshot text written at creation; never changes later (history is preserved when the business record changes). |
| `payload` | Flat JSON object (≤20 keys, ≤4 KB): strings / numbers / booleans / null only. No URLs, no secrets, no contact data (keys like `*token*`, `*password*`, `*email*`, `*phone*`, `*link*`, `*url*` are refused). |
| `target` | `{ type, id }` or `null`; navigation metadata only (§3). |
| `readAt` / `isRead` | `null` / `false` until read; set once, never reset. |
| `createdAt` | Server time. |

Database guarantees (`notifications` table):
- Exactly one recipient (FK `users`, ON DELETE CASCADE).
- `(recipient_user_id, event_key)` unique, used for idempotent delivery.
- Trigger: **everything except `read_at` is immutable**, including the recipient, and `read_at` can only go from NULL to a timestamp.
- Indexes `(recipient_user_id, id DESC)` and the partial `… WHERE read_at IS NULL`.

The recipient id and the event key are never returned by the API.

## 2. Types

| Type | Target | Intended recipient (for P3-BE06) |
|---|---|---|
| `BOOKING_CREATED` | BOOKING | provider owner + staff |
| `BOOKING_CONFIRMED`, `BOOKING_REJECTED`, `BOOKING_COMPLETED`, `BOOKING_NO_SHOW` | BOOKING | customer |
| `BOOKING_CANCELLED` | BOOKING | the other party |
| `PAYMENT_STATUS_CHANGED` | BOOKING | customer |
| `REVIEW_RECEIVED` | REVIEW | provider owner |
| `COMPLAINT_CREATED` | COMPLAINT | admins |
| `COMPLAINT_STATUS_CHANGED` | COMPLAINT | complainant |
| `PROVIDER_APPROVED`, `PROVIDER_REJECTED`, `PROVIDER_SUSPENDED` | PROVIDER | provider owner |
| `SYSTEM_ANNOUNCEMENT` | none | any |

A type may only point at its listed target type (validated on creation). Adding a type requires a migration extending `chk_notifications_type`.

## 3. Deep links

- No URL is ever stored or returned. The client maps `target` to its own route; possessing a notification **does not grant access** to the target.
- Open the record through its normal endpoint, which applies its own authorization. If the record was deleted or access was lost, that endpoint answers 404 (or 403 for the wrong role); show "This item is no longer available".
- Expected frontend mapping (routes are owned by the frontend and not confirmed by this repository):

| target.type | Customer | Provider owner / staff | Admin |
|---|---|---|---|
| BOOKING | booking detail via `GET /bookings/mine/:id` | booking detail via `GET /bookings/provider/:id` | — |
| COMPLAINT | the user's complaint view | — | `GET /admin/complaints/:id` |
| REVIEW | — | provider reviews page | — |
| PROVIDER | — | provider profile / status page | — |

## 4. API (all require `Authorization: Bearer <accessToken>`; any role)

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/notifications?page&limit&status&maxId` | `200` paginated list | 400 invalid query, 401 |
| GET | `/api/notifications/unread-count` | `200 { unreadCount }` | 401 |
| GET | `/api/notifications/:id` | `200` notification (does **not** mark it read) | 400 bad id, 401, 404 |
| PATCH | `/api/notifications/:id/read` | `200` notification (idempotent: already read → same `readAt`) | 400, 401, 404 |
| PATCH | `/api/notifications/read-all` (body optional `{ "upToId": "128" }`) | `200 { markedCount, unreadCount }` | 400, 401 |

- The recipient is always the caller; no endpoint accepts a user id, and unknown query/body fields are 400.
- **404 `Notification not found`** is the same for a missing id and for another user's notification.
- 401 = missing/invalid/expired token or revoked session (suspended users included); apply the usual refresh-once rule.
- There is **no public endpoint that creates notifications**.

### List

Query parameters:
- `page` 1..1000 (default 1);
- `limit` 1..50 (default 20);
- `status` = `all` (default) | `unread` | `read`;
- `maxId` = snapshot anchor.

The response uses the standard envelope:

```json
{
  "items": [{ "id": "128", "type": "BOOKING_CONFIRMED", "title": "Booking confirmed",
              "body": "Your grooming appointment on 12 Dec at 09:00 was confirmed.",
              "payload": { "serviceName": "Full grooming", "startTime": "2026-12-12T09:00:00+07:00" },
              "target": { "type": "BOOKING", "id": "42" }, "isRead": false, "readAt": null,
              "createdAt": "2026-12-04T03:15:00.000Z" }],
  "meta": { "page": 1, "limit": 20, "totalItems": 35, "totalPages": 2, "hasNextPage": true, "hasPreviousPage": false },
  "query": { "status": "all", "maxId": "128" }
}
```

- Newest first, by `id` (deterministic).
- **Stable paging:** request page 1 without `maxId`, then send `maxId` = `query.maxId` from that response for every later page. Notifications that arrive meanwhile then do not shift the pages. To show them, reload page 1 without `maxId`.
- A page past the end returns `items: []` with accurate totals.

### Unread count and read state
- `unread-count` is exact (a `count` over the partial index), the same rows as `status=unread`.
- Viewing details does not change the read state; mark explicitly with `PATCH /:id/read`, e.g. when the user opens the notification.
- `read-all` without a body marks every unread notification. With `upToId` (recommended: the newest id the user has seen), notifications that arrived after it stay unread. Repeating it returns `markedCount: 0`.
- There is no "mark as unread".

## 5. Frontend handoff
1. **Bell badge:** `GET /notifications/unread-count` on load, after login, and periodically (e.g. every 60 s and when the tab regains focus) until push arrives with P3-BE05/06.
2. **Inbox:** `GET /notifications?limit=20`, keep `query.maxId`, and use it for "load more" (`page=2&maxId=…`). Use `status=unread` for an "unread" tab.
3. **Open a notification:** `PATCH /notifications/:id/read`, then navigate using `target` (§3). Handle 404 or 403 from the target endpoint gracefully.
4. **"Mark all as read":** `PATCH /notifications/read-all` with `{ upToId: <newest id displayed> }`. Update the badge from `unreadCount` in the response.
5. Render `title`/`body` as plain text (never as HTML). `payload` is optional display data and may be `{}`.
6. The existing provider "notifications" mock can be replaced by this API once P3-BE06 produces real events. Until then the inbox is empty unless notifications are created internally.

## 6. Internal creation contract (P3-BE05 / P3-BE06)

Import `NotificationsModule` and inject `NotificationsService`:

```ts
await notifications.create({
  recipientUserId: booking.customerId,          // BIGINT id string
  type: 'BOOKING_CONFIRMED',
  title: 'Booking confirmed',
  body: `Your ${serviceName} appointment on ${dateText} was confirmed.`,
  payload: { serviceName, startTime: slotStartIso },  // flat, no URLs/secrets/contact data
  target: { type: 'BOOKING', id: booking.id },
  eventKey: `booking:${booking.id}:CONFIRMED`,  // idempotency per recipient
}, manager);                                     // optional: the business transaction's EntityManager
```

- **Transactions:** pass the business transaction's `manager`; the notification then commits or rolls back with the business change. Without `manager` it is written on its own.
- **Idempotency:** the same `(recipient, eventKey)` returns `{ created: false, notification }` with the original row and never updates it. Safe for retries and concurrent duplicate deliveries (verified: 10 concurrent deliveries give 1 row). Choose keys that identify the event, e.g. `booking:<id>:<newStatus>` or `complaint:<id>:status:<n>`.
- **Several recipients** (e.g. all staff of a provider): `createMany([...], manager?)`. With a manager it runs inside that transaction; without one, the batch is a single transaction of its own.
- **Errors:**
  - `NotificationInputError`: invalid input; a programming error, nothing is written.
  - `NotificationRecipientNotFoundError`: unknown user. Inside a caller transaction, this error aborts that transaction, so validate the recipient first if the business change must survive.
- **Suspended recipients still receive notifications** (they see them after reactivation). Deciding *whether* to notify is the producer's job, and P3-BE07 will add preferences.
- **P3-BE05/06 (push):** read the persisted notification after creation to build the push message. Push is a separate delivery channel; the inbox row is the source of truth. FCM device tokens and preferences need their own tables.

## 7. Deployment
- Migration `CreateNotifications1795500000000` adds the `notifications` table, indexes, trigger and function. It is additive; `down` drops all of them, and with them every notification.
- **Not applied to `pet_care_db` yet** (needs approval). Run it before starting the new build: without the table the inbox endpoints fail with 500 (`relation "notifications" does not exist`) while the rest of the API is unaffected. Both were verified on a copy of `pet_care_db`; the previous build works unchanged on the migrated schema.

## 8. Known limits
- Offset paging over a `maxId` snapshot: if a business transaction allocates a notification id but commits after page 1 was read, that notification can appear on a later page. Marking items read while viewing `status=unread` also shifts that filtered list.
- `totalItems` is an exact count (fast in tests with 50,000 notifications for one user: about 10–20 ms per request). Very large inboxes may want a retention policy later; none is implemented.
- No deletion/archiving endpoint, and no admin view of other users' notifications (by design).
