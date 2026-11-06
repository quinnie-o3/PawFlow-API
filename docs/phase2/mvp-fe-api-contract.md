# PawFlow MVP — Frontend API Contract

Status: verified against the running backend (branch `feature/p2-04-search`, Phase 2 through P2-11B) on 2026-11-06.
Every example below is a real response captured by `npm run qa:fe-smoke` from the demo dataset (`npm run qa:demo-seed`); personal data is shown as `<redacted>`.
The live, authoritative schema is Swagger at `GET /api/docs` (JSON: `GET /api/docs-json`).

## 1. Conventions

| Topic | Contract |
|---|---|
| Base URL | `http://localhost:8000/api` (dev `.env`: `PORT=8000`). Every path below is relative to `/api`. |
| Auth | `Authorization: Bearer <accessToken>`. Tokens last `JWT_EXPIRES_IN_SECONDS` (default 86 400 s = 1 day). There is no refresh token: on `401` send the user to login. |
| Roles | `CUSTOMER`, `PROVIDER_OWNER`, `PROVIDER_STAFF`, `ADMIN` (from `user.role`). Registration always creates a `CUSTOMER`; the role becomes `PROVIDER_OWNER` / `PROVIDER_STAFF` through the provider and staff flows. The role is re-read from the database on every request, so a role change applies to existing tokens. |
| IDs | Every ID is a **string** (PostgreSQL BIGINT), e.g. `"id": "8"`. Send IDs as strings too; numeric strings are accepted in bodies and paths. Path IDs must be positive integers, otherwise `400`. |
| Money and decimals | NUMERIC values are **strings with 2 decimals**: `price`, `bookedPrice`, `minPrice`, `maxPrice`, `ratingAvg`, payment `amount`, pet `weight` (`"150000.00"`, `"4.50"`). Parse with `Number()` for display only. Request bodies send numbers (`price: 150000`, `weight: 4.5`). Counts and minutes are numbers (`durationMinutes: 60`, `ratingCount: 1`). |
| Dates and times | Audit timestamps are ISO-8601 UTC (`"2026-11-06T02:45:13.355Z"`). Slot dates are `YYYY-MM-DD`; slot times are `HH:mm:ss` in **business local time (Asia/Ho_Chi_Minh)** and carry no time zone — display them as-is, do not convert. Requests send times as `HH:mm`. |
| Validation | Unknown body fields are rejected (`400 property x should not exist`). Many free-text fields are trimmed, and a blank optional value (e.g. `phone`, `customerNote`) is treated as absent/`null`. |
| Status codes | `200` read/update, `201` create **and every booking state-change action** (cancel/confirm/reject/complete/no-show), `204` delete with empty body. |

### Error format

```json
{ "message": "Booking not found", "error": "Not Found", "statusCode": 404 }
{ "message": ["property status should not exist"], "error": "Bad Request", "statusCode": 400 }
```

`message` is a **string or an array of strings** (DTO validation returns an array). Always normalize: `Array.isArray(m) ? m.join('\n') : m`. Messages are English and meant for logs/developers; map status codes to Vietnamese UI copy.

| Status | Meaning for the UI |
|---|---|
| 400 | Invalid input (form errors). |
| 401 | Missing/expired/invalid token, or wrong login credentials (`"Invalid email or password"`). |
| 403 | Authenticated but wrong role, inactive staff, or blocked provider lifecycle (e.g. `"A SUSPENDED provider cannot confirm bookings"`). |
| 404 | Not found **or not yours** (another customer's booking, another provider's booking, a hidden provider). The API never reveals which. |
| 409 | Business conflict: slot full, wrong booking status, duplicate review/complaint, Idempotency-Key reused with a different payload, schedule conflicts. |

## 2. Auth and account — `src/auth/auth.controller.ts`, `src/users/users.controller.ts`

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/auth/register` | public | `fullName` (2–150) **req**, `email` **req**, `password` (8–72) **req**, `phone` (≤20, optional; empty string = omitted) | `201` same shape as login |
| POST | `/auth/login` | public | `email`, `password` | `200` |
| GET | `/auth/me` | any role | — | `200 { user }` |
| GET | `/users/me` | any role | — | `200 user` (no wrapper) |
| PATCH | `/users/me` | any role | `fullName?`, `phone?` | `200 user` |

Errors: register `409` (email already registered, case-insensitive), `400`; login `401 "Invalid email or password"`.

```json
// POST /auth/login -> 200
{ "accessToken": "<redacted>", "tokenType": "Bearer",
  "user": { "id": "6", "fullName": "<redacted>", "email": "<redacted>", "phone": "<redacted>",
            "role": "CUSTOMER", "status": "ACTIVE", "createdAt": "2026-11-06T02:45:10.032Z", "updatedAt": "2026-11-06T02:45:10.032Z" } }
// GET /auth/me -> 200   { "user": { ...same user object } }
```

No password hash is ever returned. Store the token (memory or storage) and send it as a bearer header; cookies are not used for auth.

## 3. Pets (CUSTOMER) — `src/pets/pets.controller.ts`, `src/pets/dto/create-pet.dto.ts`

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/pet-types` (public) | — | `200 [{ id, name }]` (active types) |
| POST | `/pets` | `petTypeId` **req**, `name` (1–100) **req**, `breed?`, `birthDate?` (YYYY-MM-DD), `weight?` (number ≤ 9999.99), `healthNote?` | `201 pet` |
| GET | `/pets` | — | `200 pet[]` (active pets, with `petType`) |
| GET | `/pets/:id` | — | `200 pet` |
| PATCH | `/pets/:id` | any create field | `200 pet` |
| DELETE | `/pets/:id` | — | `204` (soft delete: the pet becomes INACTIVE and disappears from lists; booking history keeps it) |

```json
// GET /pets -> 200 (item)
{ "id": "1", "ownerId": "6", "petTypeId": "1", "name": "Mochi", "breed": "Poodle", "birthDate": "2022-03-15",
  "weight": "4.50", "healthNote": "Da nhạy cảm, dùng sữa tắm không mùi.", "status": "ACTIVE",
  "createdAt": "…", "updatedAt": "…", "petType": { "id": "1", "name": "Chó", "status": "ACTIVE", "createdAt": "…", "updatedAt": "…" } }
```

Another customer's pet returns `404`. Unknown/inactive `petTypeId` returns `404`.

## 4. Public discovery (no auth)

All three search endpoints share the paginated envelope:

```json
{ "items": [ … ],
  "meta":  { "page": 1, "limit": 20, "totalItems": 2, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false },
  "query": { …normalized filters actually applied (absent = null), "sort": "newest" } }
```

`page` 1–1000 (default 1), `limit` 1–50 (default 20). `totalPages` is 0 when there are no items. Use `query` to discard stale responses (compare it with the request you are rendering).

### 4.1 Provider search and detail — `src/providers/public-providers.controller.ts`, `src/providers/dto/public-provider-search-query.dto.ts`

`GET /providers/public/search`

| Query | Rule |
|---|---|
| `q` | ≤ 100 chars and ≤ 8 words (more → `400`); blank is ignored; every term must match the business name/description or one of its services (name, description, category). Case-insensitive, `%`/`_` are literal. |
| `categoryId`, `minPrice`, `maxPrice` | Keep providers with at least one public service matching all three. `minPrice ≤ maxPrice`. |
| `minRating` | 0–5 on `ratingAvg`. |
| `location` | ≤ 100 chars, substring of `address`. |
| `sort` | `newest` (default), `name_asc`, `name_desc`, `rating_desc`, `price_asc`, `price_desc`. |

```json
// GET /providers/public/search?q=Paw -> 200 (item)
{ "id": "1", "businessName": "Paw Spa Sài Gòn", "address": "123 Nguyễn Thị Minh Khai, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh",
  "description": "Spa thú cưng: …", "ratingAvg": "5.00", "ratingCount": 1, "serviceCount": 3, "minPrice": "150000.00", "maxPrice": "350000.00" }
```

`GET /providers/public/:id` returns the same object. Only **APPROVED** providers are visible; PENDING, REJECTED, SUSPENDED and missing providers are all `404 "Provider not found"`. Owner, phone and approval status are never exposed. `minPrice`/`maxPrice` are `null` when `serviceCount` is 0.

`GET /reviews/provider/:providerId` (public) → `200 [{ id, rating, comment, providerResponse, respondedAt, createdAt }]`, visible reviews only, newest first; hidden provider → `404`.

### 4.2 Service search and detail — `src/services/public-services.controller.ts`

`GET /services/public/search` — same `q`, `categoryId`, `minPrice`, `maxPrice`, `minRating`, `location`, `page`, `limit`, plus `providerId`; `sort`: `newest`, `name_asc`, `name_desc`, `price_asc`, `price_desc`, `rating_desc`.

```json
// GET /services/public/search?providerId=1&sort=price_asc -> 200 (item)
{ "id": "1", "name": "Tắm sấy cơ bản", "description": "…", "price": "150000.00", "durationMinutes": 60,
  "category": { "id": "1", "name": "Tắm & vệ sinh", "description": null },
  "provider": { "id": "1", "businessName": "Paw Spa Sài Gòn", "address": "…", "description": "…", "ratingAvg": "5.00", "ratingCount": 1 } }
```

`GET /services/public/:id` returns the same object. Only ACTIVE services in ACTIVE categories of APPROVED providers are visible (`404` otherwise). `GET /service-categories` (public) → `200 [{ id, name, description }]`.

### 4.3 Availability search and detail — `src/availability/public-availability.controller.ts`, `src/availability/dto/public-availability-search-query.dto.ts`

`GET /availability/public/search`

| Query | Rule |
|---|---|
| `providerId` / `serviceId` | **At least one is required.** Both together: the service must belong to that provider (else empty). |
| `date` | Exact `YYYY-MM-DD`; cannot be combined with `fromDate`/`toDate`. |
| `fromDate`, `toDate` | Inclusive range; `toDate ≥ fromDate`. |
| `page`, `limit` | As above. Ordered by date, then start time. |

```json
// GET /availability/public/search?providerId=1&serviceId=1&date=2026-11-11 -> 200 (item)
{ "id": "14", "slotDate": "2026-11-11", "startTime": "09:00:00", "endTime": "10:00:00", "capacity": 2, "bookedCount": 0,
  "service": { "id": "1", "name": "Tắm sấy cơ bản", "description": "…", "price": "150000.00", "durationMinutes": 60,
               "category": { "id": "1", "name": "Tắm & vệ sinh", "description": null } },
  "provider": { "id": "1", "businessName": "Paw Spa Sài Gòn", "address": "…", "description": "…", "ratingAvg": "5.00", "ratingCount": 1 } }
```

`GET /availability/public/:id` returns the same object or `404`. A slot is listed only if it is bookable **right now**: OPEN, not full, not started (server clock, Asia/Ho_Chi_Minh), inside one active working-hour interval of the provider, at least as long as the service, provider APPROVED, service and category ACTIVE. Remaining places = `capacity - bookedCount`. Visibility can change between search and booking, so the booking call is the final authority.

```json
// GET /availability/public/search?date=2027-02-30 -> 400
{ "message": ["providerId or serviceId must be provided", "date must be a valid calendar date in YYYY-MM-DD format"], "error": "Bad Request", "statusCode": 400 }
```

## 5. Bookings — `src/bookings/bookings.controller.ts`, `src/bookings/booking-views.ts`, `src/bookings/dto/booking-response.schema.ts`

Booking responses are explicit, nested projections (no flat foreign keys such as `petId` / `slotId` / `customerId`).

```ts
type BookingStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'REJECTED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
```

**Customer view** (create, replay, `/bookings/mine`, cancel):

```json
{ "id": "8", "status": "PENDING_CONFIRMATION", "bookedPrice": "150000.00", "customerNote": "Nhờ cắt gọn móng giúp bé.",
  "createdAt": "2026-11-06T02:45:13.355Z", "updatedAt": "2026-11-06T02:45:13.355Z",
  "service": { "id": "1", "name": "Tắm sấy cơ bản", "durationMinutes": 60 },
  "slot": { "id": "14", "slotDate": "2026-11-11", "startTime": "09:00:00", "endTime": "10:00:00" },
  "pet": { "id": "1", "name": "Mochi", "breed": "Poodle", "petType": { "id": "1", "name": "Chó" } },
  "provider": { "id": "1", "businessName": "Paw Spa Sài Gòn", "address": "123 Nguyễn Thị Minh Khai, …" } }
```

**Provider/staff view** (`/bookings/provider`, provider actions): same base fields, no `provider`, plus

```json
"customer": { "id": "6", "fullName": "<redacted>" },
"pet": { "id": "1", "name": "Mochi", "breed": "Poodle", "birthDate": "2022-03-15", "weight": "4.50",
         "healthNote": "Da nhạy cảm, dùng sữa tắm không mùi.", "petType": { "id": "1", "name": "Chó" } }
```

**Detail endpoints** add `statusLogs` (oldest first):

```json
"statusLogs": [ { "id": "15", "oldStatus": null, "newStatus": "PENDING_CONFIRMATION", "reason": null, "createdAt": "…" },
                { "id": "16", "oldStatus": "PENDING_CONFIRMATION", "newStatus": "CONFIRMED", "reason": null, "createdAt": "…" } ]
```

Notes: `bookedPrice` is the price snapshot at booking time; `service.durationMinutes` is the **current** service duration (not a snapshot). Customer email/phone are never exposed to providers; provider phone is never exposed to customers.

### 5.1 Create — `POST /bookings` (CUSTOMER)

Body: `petId` **req** (own active pet), `slotId` **req**, `customerNote?` (string or `null`; blank becomes `null`). Header: `Idempotency-Key` (optional, strongly recommended).

| Result | Status |
|---|---|
| Created, or replay of the same key + same payload | `201` customer view |
| Invalid body, malformed key, pet/service/provider not usable, slot in the past or already started | `400` |
| No/invalid token | `401` |
| Not a customer | `403` |
| Pet / slot / service / provider not found | `404` |
| Slot closed or full, outside working hours, shorter than the service; key reused with a **different** payload; key still being processed | `409` |

**Idempotency-Key** — generate one per booking *attempt* with `crypto.randomUUID()` when the user presses "Đặt lịch", keep it while retrying that same attempt (network error, timeout, double click, page reload), and create a new key only for a new attempt (different pet/slot/note, or after the user edits the form). Format: 16–128 characters `[A-Za-z0-9_-]`, scoped to the customer, never expires. Behaviour:

* same key + same payload → `201` with the **original booking in its current state**, header `Idempotent-Replayed: true`, no second booking and no capacity used — even if the slot has since become full or started;
* same key + different payload → `409 "This Idempotency-Key was already used for a different booking request"`;
* failed attempts (4xx) store nothing, so retrying with the same key re-runs the booking;
* without the header every request is a new booking (legacy behaviour).

Response header `Idempotent-Replayed: "true" | "false"` is present only when a key was sent, and is readable from the browser (CORS `exposedHeaders`).

```json
// POST /bookings  Idempotency-Key: 3f0c…  {"petId":"1","slotId":"14","customerNote":"Nhờ cắt gọn móng giúp bé."}
// -> 201, Idempotent-Replayed: false  (customer view above)
// retry with the same key -> 201, Idempotent-Replayed: true, identical body
// Idempotency-Key: abc -> 400 "Idempotency-Key must be 16-128 characters long and contain only letters, digits, \"-\" or \"_\" (for example a UUID)"
// full slot -> 409 "Availability slot is full"
```

### 5.2 Customer — list, detail, cancel (CUSTOMER)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/bookings/mine` | — | `200` customer view[] (newest first, no pagination) | 401, 403 |
| GET | `/bookings/mine/:id` | — | `200` customer view + `statusLogs` | 400, 401, 403, 404 (not yours) |
| POST | `/bookings/mine/:id/cancel` | `{ reason? }` | `201` customer view, status CANCELLED, capacity released | 409 if not PENDING_CONFIRMATION/CONFIRMED |

### 5.3 Provider — list, detail, actions (PROVIDER_OWNER or active PROVIDER_STAFF)

| Method | Path | Body | From → To | Success |
|---|---|---|---|---|
| GET | `/bookings/provider` | — | — | `200` provider view[] (newest first, no pagination) |
| GET | `/bookings/provider/:id` | — | — | `200` provider view + `statusLogs` |
| POST | `/bookings/provider/:id/confirm` | — | PENDING_CONFIRMATION → CONFIRMED | `201` provider view |
| POST | `/bookings/provider/:id/reject` | `{ reason? }` | PENDING_CONFIRMATION → REJECTED (capacity released) | `201` |
| POST | `/bookings/provider/:id/complete` | — | CONFIRMED → COMPLETED | `201` |
| POST | `/bookings/provider/:id/no-show` | `{ reason? }` | CONFIRMED → NO_SHOW | `201` |

Errors: another provider's booking `404`; wrong status `409` (e.g. `"Only a pending confirmation booking can be updated"`); inactive staff or wrong role `403`; **confirm** by a provider that is not APPROVED (PENDING/REJECTED/SUSPENDED) `403 "A SUSPENDED provider cannot confirm bookings"`. A suspended provider can still read, reject, complete and mark no-show; customers can still cancel.

## 6. Provider dashboard — `src/dashboard/dashboard.controller.ts` (PROVIDER_OWNER only)

`GET /dashboard/provider?from=YYYY-MM-DD&to=YYYY-MM-DD` — both **required**, `from ≤ to` (else `400`); staff get `403`.

```json
{ "providerId": "1", "period": { "from": "2026-10-30", "to": "2026-11-20" },
  "bookingVolumeByStatus": { "PENDING_CONFIRMATION": 0, "CONFIRMED": 2, "REJECTED": 1, "COMPLETED": 1, "CANCELLED": 2, "NO_SHOW": 1, "total": 7 },
  "cancellationRate": { "cancelledBookings": 2, "resolvedBookings": 4, "rate": 50 },
  "popularServices": [ { "serviceId": "2", "serviceName": "Cắt tỉa lông tạo kiểu", "completedBookings": 1 } ],
  "returningCustomers": { "count": 0 },
  "recordedRevenue": { "amount": "350000.00" },
  "averageRating": { "reviewCount": 1, "average": 5 },
  "alerts": [ { "code": "HIGH_SERVICE_CANCELLATION", "severity": "WARNING", "message": "Combo tắm + cắt móng had a 100% cancellation rate in 2026-11.",
                "recommendation": "Review pricing, duration, scheduling conditions, and recent feedback for this service.",
                "context": { "month": "2026-11", "serviceId": "3", "cancelledBookings": 1, "resolvedBookings": 1, "percentage": 100 } } ] }
```

`cancellationRate.rate` and `averageRating.average` are numbers (percentage / 0–5), `rate` is `null` when nothing is resolved. Alert `message`/`recommendation` are English; render from `code` + `context` in Vietnamese.

## 7. Reviews and complaints (CUSTOMER) — `src/reviews/*.controller.ts`, `src/complaints/complaints.controller.ts`

| Method | Path | Body | Rules | Success |
|---|---|---|---|---|
| POST | `/bookings/:id/reviews` | `rating` (int 1–5) **req**, `comment?` | own COMPLETED booking, one review per booking (`409` duplicate / not completed) | `201` review |
| GET | `/reviews/mine` | — | — | `200 review[]` |
| POST | `/bookings/:id/complaints` | `reason` (1–2000, not blank) **req** | own booking in CONFIRMED, COMPLETED, CANCELLED, REJECTED or NO_SHOW; at most one OPEN/IN_REVIEW complaint per booking (`409`) | `201` complaint (OPEN) |
| GET | `/complaints/mine`, `/complaints/mine/:id` | — | own complaints only | `200` |

```json
// GET /reviews/mine -> 200 (item)
{ "id": "1", "bookingId": "3", "rating": 5, "comment": "Bé Lu được cắt tỉa rất đẹp, nhân viên thân thiện.", "providerResponse": null,
  "respondedBy": null, "respondedAt": null, "isVisible": true, "createdAt": "…", "updatedAt": "…" }
// GET /complaints/mine -> 200 (item)
{ "id": "1", "bookingId": "5", "createdBy": "6", "reason": "Lịch bị từ chối sát giờ, mong cửa hàng báo sớm hơn.", "status": "OPEN",
  "adminNote": null, "resolvedBy": null, "resolvedAt": null, "createdAt": "…", "updatedAt": "…" }
```

Complaint status: `OPEN → IN_REVIEW → RESOLVED | REJECTED` (admin only, `PATCH /admin/complaints/:id/review|resolve|reject`). Reviews are moderated by admin (`PATCH /admin/reviews/:id/hide|restore`); hidden reviews disappear from the public list and the provider rating is recomputed. Review and complaint responses are entity-shaped (they include the caller's own `bookingId`/`createdBy`), not booking-style projections.

## 8. Simulated payments — `src/payments/payments.controller.ts` (PROVIDER_OWNER only)

| Method | Path | Body | Success |
|---|---|---|---|
| PUT | `/payments/provider/booking/:id` | `paymentStatus` **req** `UNPAID` \| `PAID` \| `FAILED`, `method?` `CASH` \| `QR` \| `BANK_TRANSFER` \| `OTHER` | `200` payment |
| GET | `/payments/provider/booking/:id` | — | `200` payment |
| GET | `/payments/provider` | — | `200` payment[] |

```json
{ "id": "1", "bookingId": "3", "amount": "350000.00", "method": "CASH", "paymentStatus": "PAID",
  "paidAt": "2026-11-06T02:45:12.495Z", "createdAt": "…", "updatedAt": "…" }
```

Only for the owner's own **COMPLETED** bookings (`409` otherwise, `404` for another provider). `amount` always equals `bookedPrice`; a repeated `PAID` keeps the first `paidAt`. Staff and customers get `403`. This records an offline payment; there is no payment gateway.

## 9. Provider self-service (PROVIDER_OWNER) — reference

Owner-side management endpoints exist and are documented in Swagger (`Providers`, `Services`, `Availability` tags): `GET/PATCH /providers/me`, `POST/GET/PATCH/DELETE /providers/staff[/:id]`, `POST/GET/PATCH/DELETE /providers/working-hours[/:id]`, `POST/GET/PATCH/DELETE /services[/mine/:id]`, `POST /availability`, `GET/PATCH/DELETE /availability/mine[/:id]`. These return entity-shaped responses (they include the owner's own `providerId`, `approvalStatus`, …). Key rules: working-hour intervals of the same weekday may not overlap (half-open `[start, end)`, `409`); a slot must fit inside one active interval, last at least the service duration (`409`) and start in the future (`400`); REJECTED/SUSPENDED providers cannot manage services, slots, staff or hours (`403`).

## 10. Provider visibility and lifecycle summary

| Provider status | Public listing/detail | New bookings | Confirm | Reject / complete / no-show | Customer cancel |
|---|---|---|---|---|---|
| PENDING | hidden (404) | no | 403 | allowed | allowed |
| APPROVED | visible | yes | yes | yes | yes |
| REJECTED | hidden (404) | no | 403 | allowed | allowed |
| SUSPENDED | hidden (404) | no (`400`) | 403 | allowed | allowed |
