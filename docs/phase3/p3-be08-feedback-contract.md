# P3-BE08 — Provider Feedback: Architecture Audit & API Contract

Status:

- **BE08-01 (§1–§12): design, done.** §1–§11 are kept as the audit record of 2026-11-14.
- **BE08-02: implemented (§13).** Where §13 differs from the design, §13 is authoritative.
- **BE08-03: moderation integration and hardening (§14).** It updates §13.6 (CHECK trim set) and the admin projection.
- **BE08-04A: validation complete** ([p3-be08-validation.md](p3-be08-validation.md)). Contract unchanged. Git integration is blocked: the PR #14 revert wiped `dev` (validation §8).

Baselines:

- BE08-01: `feature/notification-preferences` @ `57ebede` (BE07).
- BE08-02: `feature/provider-feedback`, branched from `57ebede`.

See [p3-be08-progress.md](p3-be08-progress.md).

Roadmap acceptance criteria (P3-BE08, P1, depends on P2-14):

- **AC1:** providers can view only the feedback that belongs to their own provider account.
- **AC2:** a provider response records the authoritative responder identity and the response timestamp.
- **AC3:** hidden-review visibility and moderation behaviour are clearly defined.

---

## 1. Existing code and schema audit

### 1.1 Schema (`reviews`)

The schema was verified against the migration `1789876572501-CreatePaymentsAndFeedback.ts`, the entity `src/reviews/entities/review.entity.ts` and a read-only catalog query on `pet_care_db`. All three match.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | bigint | no | sequence | PK |
| `booking_id` | bigint | no | — | `UNIQUE` (P2-14 uniqueness). FK `fk_reviews_booking` → `bookings(id)` `ON DELETE RESTRICT` |
| `rating` | smallint | no | — | `chk_reviews_rating` 1–5 |
| `comment` | text | yes | — | No length limit (DTO has none either) |
| `provider_response` | text | yes | — | **Exists. Has no write path.** |
| `responded_by` | bigint | yes | — | **Exists.** FK `fk_reviews_responder` → `users(id)` `ON DELETE SET NULL` |
| `responded_at` | timestamptz | yes | — | **Exists** |
| `is_visible` | boolean | no | `true` | Index `idx_reviews_visible` |
| `created_at` / `updated_at` | timestamptz | no | `now()` | Index `idx_reviews_created_at` |

- There is no CHECK that ties the three response columns together.
- There is no moderation-reason column and no soft-delete column.
- `pet_care_db` currently holds **0 reviews**, so no existing row can violate a new constraint.

A review reaches its provider only through `reviews.booking_id → bookings.provider_id`. Reviews have no `provider_id` column, and none is needed: `idx_bookings_provider` plus the unique `booking_id` index cover the join.

### 1.2 Endpoints that already exist

| Route | Guard | Behaviour | Source |
|---|---|---|---|
| `POST /api/bookings/:id/reviews` | JWT + `CUSTOMER` | P2-14 create (see §1.4) | `reviews.controller.ts` |
| `GET /api/reviews/mine` | JWT + `CUSTOMER` | Returns the caller's reviews **including hidden ones**, newest first. Raw entity, so it includes `respondedBy` (a user id), `isVisible` and `updatedAt` | `review-queries.controller.ts:33`, `reviews.service.ts:130` |
| `GET /api/reviews/provider/:providerId` | public | Provider must be `APPROVED` (otherwise 404 `Provider not found`). Only `is_visible = true`. Projection: `id, rating, comment, providerResponse, respondedAt, createdAt`. Unpaginated | `review-queries.controller.ts:57`, `reviews.service.ts:141` |
| `GET /api/admin/reviews` | JWT + `ADMIN` | All reviews, including hidden. Unpaginated. No `respondedBy` | `admin-reviews.controller.ts` |
| `GET /api/admin/reviews/:id` | JWT + `ADMIN` | Detail (same projection) | ″ |
| `PATCH /api/admin/reviews/:id/hide` · `/restore` | JWT + `ADMIN` | See §1.5 | `admin.service.ts:351` |

**No provider-facing review endpoint exists.** Providers cannot read their own feedback, and nobody can write a response.

### 1.3 Answers to the audit questions

1. **Which review endpoints exist?** The six listed in §1.2.
2. **Who can read reviews today?**
   - Public visitors: visible reviews of APPROVED providers.
   - Customers: their own reviews, including hidden ones.
   - Admins: all reviews.
   - Providers and staff: **none**.
3. **Are responses supported?** Only as storage: the columns exist, but no API writes them.
4. **Do `respondedBy` and `respondedAt` exist?** Yes, as `responded_by` and `responded_at`, with a FK to `users` that is set to NULL when the user is deleted.
5. **Moderation fields?** `is_visible` only. There is no reason or note field. The accountable trail lives in `admin_activity_logs` (`REVIEW_HIDDEN` / `REVIEW_RESTORED`, with `adminUserId`, `fromVisible`, `toVisible` and the recomputed `ratingCount`/`ratingAvg`).
6. **Do hidden reviews affect public lists or aggregates?** Hidden reviews are excluded from the public list. They are also excluded from `providers.rating_avg` / `rating_count`, which are recomputed from visible rows on create, hide and restore. The DSS low-rating alert (`dashboard-dss.service.ts:334`) uses visible rows only.
7. **Is admin moderation implemented?** Yes: hide and restore, with a row lock, rating recompute and an activity log in a single transaction.
8. **What BE08 actually needs:**
   - a provider-scoped list API;
   - a response write API;
   - a policy check for responding (lifecycle);
   - optionally, DB CHECK hardening of the response columns;
   - small projection fixes for the admin view (§6).

   No new table and no new column is required.

### 1.4 P2-14 dependency verification (preserved, not modified)

`ReviewsService.createReview` enforces the following:

- **Locking:** it locks the booking with `FOR UPDATE`. A missing booking and another customer's booking both return the same 404 `Booking not found`.
- **Status:** `status !== 'COMPLETED'` returns 409.
- **One review per booking:** an existing review returns 409. The DB `UNIQUE(booking_id)` backstop maps 23505 to 409.
- **Rating:** it locks the provider with `FOR UPDATE` and recomputes the rating from visible rows.
- **Response columns:** they are initialised to `null`.

Coverage:

- **HTTP QA:** `test/qa/mvp-e2e.cjs` scenarios E1–E3 (201 / duplicate 409 / non-completed 409 / foreign 404 / rating 400 / hide / restore / 403 for a customer).
- **Unit tests:** `src/reviews/reviews.service.spec.ts` covers the public/customer queries and route guards. It has **no unit test for `createReview`**; P2-14 rests on the HTTP QA.

BE08 does not touch `createReview` or the `booking_id` uniqueness.

### 1.5 Provider, staff and auth model

- **Provider owner:**
  - `providers.owner_id` is `UNIQUE` (one provider per owner);
  - role `PROVIDER_OWNER`;
  - there is **no ownership-transfer API**.
- **Staff:**
  - `provider_staff (provider_id, user_id UNIQUE, status ACTIVE|INACTIVE, position free text)`;
  - role `PROVIDER_STAFF`;
  - deactivation or removal sets `status = INACTIVE` and reverts `users.role` to `CUSTOMER` in one transaction;
  - there is no per-staff permission model.
- **Existing staff convention** (`bookings.service.ts:563` `resolveManagedProviderId`):
  - Owner and active staff may read provider bookings and run booking operations (confirm, reject, complete, no-show).
  - Owner-only actions: provider profile, staff, working hours and the dashboard (`/dashboard/provider`).
- **Provider lifecycle** (`provider-lifecycle.policy.ts`):
  - Reads are never restricted by status.
  - A SUSPENDED provider cannot update its profile or manage resources.
  - Only APPROVED providers can confirm bookings.
  - Checks run right after the caller's provider is loaded, before any resource lookup.
  - Transitions: `PENDING → APPROVED | REJECTED`, `APPROVED ⇄ SUSPENDED`. Reviews therefore only exist for providers that are APPROVED or SUSPENDED.
- **Auth (P3-BE01, `jwt.strategy.ts`):**
  - Every request reloads the session and the user.
  - A revoked or expired session, or a user that is not ACTIVE, gets 401.
  - `role` comes from the DB on every request, not from the token.
- **Cross-tenant convention:** another tenant's resource gets **404 with the same message as a missing one** (`assertProviderCanManageBooking`, `createReview`). A wrong role gets 403 from `RolesGuard`.
- **Pagination convention (newest):** the notification inbox (`notification.dto.ts`) uses:
  - `page` (1–1000), `limit` (1–50, default 20) and the snapshot anchor `maxId`;
  - the envelope `{ items, meta: { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage }, query }` (`common/dto/paginated-schema.ts`).

  The global `ValidationPipe` uses `whitelist`, `forbidNonWhitelisted` and no implicit conversion, so unknown fields, including forged `respondedBy` / `respondedAt`, get 400.
- **Error envelope:** the Nest default `{ statusCode, message, error }`. The only custom filter is `retry-after.filter.ts`.
- **Notifications:** the type `REVIEW_RECEIVED` (target `REVIEW`) exists in the enum/CHECK, but **nothing produces it**. BE08 does not add review notifications (no push changes).

---

## 2. Gap analysis

| Requirement | Today | Gap | Owner |
|---|---|---|---|
| AC1: provider sees own feedback only | No provider endpoint | Scoped list API | BE08-02 |
| AC2: response with authoritative actor + time | Columns exist, no writer | Write API; `respondedBy = user.id`, `respondedAt = now()` in SQL | BE08-02 |
| AC2: integrity of the response triple | No DB rule | CHECK constraints (D9) | BE08-02 |
| AC3: hidden policy defined | Implemented for public, customer and admin; undefined for providers | Matrix (§6) + provider enforcement + tests | BE08-02 (query), BE08-03 (QA) |
| Admin accountability for responses | Admin view omits `respondedBy` | Add `respondedBy` to the admin projection | BE08-03 |
| Moderating an abusive response | No mechanism other than hiding the whole review | Documented gap; deferred (D7) | — |

---

## 3. Authorization matrix

| Capability | Provider owner | Active staff | Inactive / removed staff | Customer | Admin | Public |
|---|---|---|---|---|---|---|
| List own provider's reviews (incl. hidden, flagged) | ✅ | ✅ read-only (**D1**) | ❌ 403 | ❌ 403 | ❌ 403 (uses `/admin/reviews`) | ❌ 401 |
| Respond to own provider's review | ✅ (APPROVED provider only, **D5**) | ❌ 403 (**D1**) | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 401 |
| Edit / delete a response | ❌ (immutable, **D2**) | ❌ | ❌ | ❌ | ❌ (deferred, **D7**) | ❌ |
| Hide / restore a review | ❌ | ❌ | ❌ | ❌ | ✅ (existing) | ❌ |
| Read responses | own provider | own provider | ❌ | own reviews | ✅ all | visible reviews only |

Staff recommendation (D1): **read-only**.

- This mirrors the booking convention, where staff need context to serve customers.
- A response is the provider's public voice, like the profile, which is owner-only.
- No permission model exists to grant writes selectively.
- `respondedBy` stays a real user id, so staff writes can be enabled later without a schema change.

### Revoked access

| Event | Effect |
|---|---|
| Provider SUSPENDED (or REJECTED / PENDING) | List: allowed (reads are never restricted, as in the lifecycle matrix). Respond: 403 `A SUSPENDED provider cannot respond to reviews`. The check runs before any review lookup. |
| Staff becomes INACTIVE / removed | Role reverts to `CUSTOMER`, so `RolesGuard` returns 403 on the next request. If the role is still `PROVIDER_STAFF` with no ACTIVE row: 403 `Active provider staff association is required` (existing message). |
| Ownership change | No API exists. The write transaction still re-validates `providers.owner_id = user.id` under lock (§8), so a future transfer cannot race a response. |
| Session revoked / user suspended | 401 on the next request (P3-BE01). A request already past the guard completes. This is accepted and consistent with every other endpoint. |
| Relationship removed during the request | The write re-checks under `FOR SHARE` locks (§8). The read is a single snapshot query, and a removal committed after it is not retroactive. |

---

## 4. Provider review list API

**`GET /api/providers/me/reviews`** with roles `PROVIDER_OWNER` and `PROVIDER_STAFF`.

Why this route:

- `/providers/me` is the existing identity-scoped provider namespace.
- The URL carries **no provider id**, so there is nothing to tamper with.
- It does not collide with the public `GET /reviews/provider/:providerId`, which keeps its contract.

It is implemented as a new controller inside `ReviewsModule`.

**Scope resolution:**

- Owner: `providers.owner_id = user.id`. Without a provider: 404 `Provider profile not found`.
- Staff: an `ACTIVE` `provider_staff` row for `user.id`. Without one: 403.

Every query carries `WHERE bookings.provider_id = :resolvedProviderId`. No client input contributes to the scope.

**Query** (strict DTO; unknown parameters get 400):

| Param | Values | Default |
|---|---|---|
| `page` | 1–1000 | 1 |
| `limit` | 1–50 | 20 |
| `maxId` | bigint id string | omitted (server returns the anchor in `query.maxId`) |
| `rating` | integer 1–5 | null (all) |
| `visibility` | `all` \| `visible` \| `hidden` | `all` |
| `responded` | `all` \| `responded` \| `unresponded` | `all` |
| `sort` | `newest` \| `oldest` \| `rating_desc` \| `rating_asc` | `newest` |

- **Ordering** is always tie-broken by `reviews.id` (DESC for `newest` and the rating sorts, ASC for `oldest`).
- **`maxId`** restricts to `reviews.id <= maxId`, so new reviews do not shift later pages. This is the same pattern as the inbox.
- **`maxId` cannot leak data:** it only narrows a result set that is already provider-scoped.
- **No cursor is used.**

**Response** `200` uses the standard paginated envelope:

```json
{
  "items": [{
    "id": "41",
    "rating": 2,
    "comment": "Late by 20 minutes.",
    "isVisible": true,
    "createdAt": "2026-11-10T08:12:00.000Z",
    "booking": {
      "id": "310",
      "service": { "id": "7", "name": "Full grooming" },
      "slot": { "slotDate": "2026-11-09", "startTime": "09:00:00" }
    },
    "customer": { "fullName": "Nguyen An" },
    "response": {
      "text": "Sorry for the wait — we have added a groomer on Saturdays.",
      "respondedAt": "2026-11-10T09:00:00.000Z",
      "respondedBy": { "id": "12", "fullName": "Tran Binh" }
    }
  }],
  "meta": { "page": 1, "limit": 20, "totalItems": 1, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false },
  "query": { "rating": null, "visibility": "all", "responded": "all", "sort": "newest", "maxId": "41" }
}
```

Field rules:

- `response` is `null` when there is no response.
- `respondedBy` is `null` if the responding user was deleted (FK `SET NULL`).
- `customer` is the **name only**. Providers already see `{id, fullName}` on their bookings, but the customer id adds nothing for feedback and is omitted.
- **Never selected:**
  - customer email, phone or id;
  - the pet;
  - `customerNote`, `bookedPrice`;
  - status logs;
  - complaint data;
  - `updatedAt`;
  - any other provider's rows.
- **Projection:** use an explicit column list, as `getPublicProviderReviews` does, not a raw entity.

**Count and empty state:**

- `totalItems` is the count under the same scope, filters and anchor.
- A provider with no reviews gets `200` with `items: []`, `totalItems: 0`, `totalPages: 0` and `query.maxId: null`.
- A page beyond the last returns `200` with an empty `items`.

A single-review detail endpoint is **not required**. The list item and the response endpoint's return value cover the UI.

---

## 5. Provider response API

**`POST /api/providers/me/reviews/:reviewId/response`**

- Role: `PROVIDER_OWNER`, plus `PROVIDER_STAFF` only if D1 changes.
- `:reviewId` is checked by `ParseBigIntIdPipe`.

**Body** (`CreateReviewResponseDto`):

```json
{ "text": "Thank you for visiting us!" }
```

Validation and normalization:

- `text` is required and must be a string.
- CRLF/CR → LF, then trimmed.
- Empty after trimming gives 400.
- Length is **1–1000** characters after normalization (D8).
- NUL is rejected (`HasNoNulCharacter` pattern), giving 400.
- Inner whitespace and Unicode are preserved.
- Any other property gives 400. This includes `respondedBy`, `respondedAt`, `providerId` and `reviewId`, rejected by `forbidNonWhitelisted`.

**Authoritative fields:**

- `responded_by = <authenticated user.id>`.
- `responded_at = now()` (DB transaction time). Neither field is ever read from input.
- `updated_at` is also set by the statement.

**Duplicate policy (D2): create-once, immutable.**

- A review has at most one response, enforced by the single-valued column and the guarded UPDATE in §8.
- A second POST, including an identical replay or a double click, gets **409** `Review already has a response`. The client should refetch.
- No PUT, PATCH or DELETE in BE08.

**Response** `201`: the updated review in the §4 item shape.

**Order of checks** (no resource lookup before the policy checks, as in the lifecycle matrix):

1. JWT / role (401 / 403).
2. DTO (400).
3. Resolve the caller's provider (owner: 404 `Provider profile not found`; staff: 403).
4. `assertProviderCanRespondToReviews` (new; APPROVED only): 403.
5. Scoped review lookup: a missing review and another provider's review both give **404 `Review not found`**.
6. Hidden review: 409 `Hidden reviews cannot be responded to`.
7. Already responded: 409.
8. Write.

Steps 6 and 7 are only reachable for the caller's own reviews. The caller already sees both facts in the list, so they disclose nothing.

---

## 6. Hidden-review visibility and moderation

Definitions:

- **Visibility suppression:** `is_visible = false`. This is the only moderation mechanism. The row, its booking link and P2-14 uniqueness are untouched, and a hidden review still blocks a second review of the same booking.
- **Review deletion:** not supported. No endpoint exists, and `fk_reviews_booking RESTRICT` protects the row. BE08 adds none.
- **Review moderation:** the admin hide/restore actions, each with an `admin_activity_logs` entry in the same transaction. There is no reason field, so no internal reason can leak.
- **Response moderation:** none exists. Hiding a review also hides its response from the public. Removing an abusive response from a visible review is a **known gap** (D7).

| Hidden review | Listed | Detail | In rating aggregates | Respond | Edit | Moderate |
|---|---|---|---|---|---|---|
| Public visitor | ❌ (existing filter) | ❌ (no public detail) | ❌ | ❌ | ❌ | ❌ |
| Review author (customer) | ✅ `/reviews/mine`, `isVisible:false` (existing) | via the list | ❌ | n/a | ❌ (no review edit exists) | ❌ |
| Provider owner | ✅ flagged `isVisible:false`, filterable (**D3**) | via the list | ❌ | ❌ 409 (**D4**) | ❌ | ❌ cannot hide or restore |
| Active staff | ✅ same as owner (if D1 read) | via the list | ❌ | ❌ | ❌ | ❌ |
| Admin | ✅ | ✅ | ❌ | ❌ (not a provider) | ❌ | ✅ hide/restore, audited |

Rules:

- **Aggregates** count visible rows only, everywhere: provider rating, public search sort/filter and the DSS alert. BE08 leaves this unchanged, and responses never affect aggregates.
- **A response written before hiding** stays stored. It disappears from the public view with the review and comes back on restore.
- **Hidden-review enforcement lives in backend SQL predicates.** It is never done by filtering in the client.

Projection follow-ups:

- **Admin projection (BE08-03):** add `respondedBy` to `ReviewAdminResponse` for accountability.
- **Customer `/reviews/mine`** already returns `respondedBy` (a bare user id, no PII). It stays unchanged in BE08 (D6) to avoid breaking the FE contract.

---

## 7. Database change proposal

**Strictly required: none.**

**Recommended (D9):** one additive migration in BE08-02, `1797500000000-AddReviewResponseConstraints.ts` (after BE07's `1797000000000`):

```sql
ALTER TABLE reviews ADD CONSTRAINT chk_reviews_response_consistency CHECK (
  (provider_response IS NULL AND responded_at IS NULL AND responded_by IS NULL)
  OR (provider_response IS NOT NULL AND responded_at IS NOT NULL)
);
ALTER TABLE reviews ADD CONSTRAINT chk_reviews_response_length CHECK (
  provider_response IS NULL OR char_length(provider_response) BETWEEN 1 AND 1000
);
```

- `responded_by` may be NULL on a responded row because of the existing `ON DELETE SET NULL`, so the CHECK does not require it.
- **No new index:** the list uses the `idx_bookings_provider` join, `reviews.booking_id UNIQUE` and `idx_reviews_created_at`, which is adequate at the current scale.
- **No new columns, FKs or defaults.** The entity gains two `@Check` decorators.
- **Existing data:** 0 rows in `pet_care_db`. The migration's `up` should still run a preflight count of violating rows and fail with a clear message. This is new practice: the BE07 migration has no preflight. The migration transaction already prevents a half-applied state; the preflight only makes the failure readable.
- **Rollback:** `down` drops both constraints. No data is lost; the only consequence is losing the DB-level backstop.
- Historical migrations are not edited.

---

## 8. Transactions and concurrency

### Write transaction (READ COMMITTED, one `dataSource.transaction`)

1. Resolve `providerId` from the caller. This is an unlocked read, used only to scope the lookup.
2. Lock the review, scoped to that provider:

   ```sql
   SELECT r.* FROM reviews r JOIN bookings b ON b.id = r.booking_id
   WHERE r.id = $reviewId AND b.provider_id = $providerId
   FOR UPDATE OF r
   ```

   No row: 404.
3. Lock and re-validate the authority, **after** the review:
   - `providers` row `FOR SHARE`: still `owner_id = user.id` (owner) and `approval_status = 'APPROVED'`;
   - for staff (only if D1 grants writes): the `provider_staff` row `FOR SHARE`, still `ACTIVE` with the same `provider_id`.

   Failure gives the same 404 or 403 as above.
4. Check `is_visible` (409) and `provider_response IS NULL` (409).
5. Write:

   ```sql
   UPDATE reviews
   SET provider_response = $text, responded_by = $userId, responded_at = now(), updated_at = now()
   WHERE id = $reviewId AND provider_response IS NULL
   RETURNING ...
   ```

   0 rows (defensive) gives 409.

**Lock order is review → provider.** This is the same order as admin `updateReviewVisibility` (review `FOR UPDATE` → provider `FOR UPDATE`).

Locking the provider first would create a cycle with admin hide:

- the response transaction holds the provider share lock and waits for the review;
- admin hide holds the review and waits for the provider;
- result: **deadlock**.

`createReview` locks booking → provider and never locks an existing review, so there is no cycle with it either.

### Scenarios

| Scenario | Outcome |
|---|---|
| Two responses to the same review / double click | The second waits on the review row lock, then sees `provider_response` set: one 201, one 409. Never two writes. |
| Owner and staff concurrently (if staff could write) | Same as above. The winner's `respondedBy` is kept. |
| Identical replay | 409 (documented; clients refetch). |
| Provider suspended during the response | `transitionProvider` locks the provider row. Either the suspension commits first (we see SUSPENDED: 403) or our share lock delays it until we commit (the response happens-before). |
| Staff deactivated or ownership changed during the response | Same reasoning with the staff or provider row share lock. |
| Admin hides during the response | Both lock the review row and serialize. If hide is first: 409. If the response is first: it is stored, then hidden with the review. |
| Review created concurrently | Unaffected. Responses do not change aggregates and take no provider `FOR UPDATE`. |

The list is a single read (count + page) with no locks. `maxId` gives stable paging.

---

## 9. Error contract (Nest default envelope `{ statusCode, message, error }`)

| Status | When | Message |
|---|---|---|
| 400 | Invalid `reviewId`, query value, unknown param/field, empty, too long or NUL `text`, forged `respondedBy`/`respondedAt` | class-validator / pipe messages |
| 401 | Missing, invalid or expired token; revoked session; non-ACTIVE user | `Unauthorized` |
| 403 | Role not allowed (customer, admin, inactive staff whose role reverted) | `Forbidden resource` (RolesGuard) |
| 403 | Staff without an ACTIVE association | `Active provider staff association is required` |
| 403 | Provider not APPROVED (respond only) | `A <STATUS> provider cannot respond to reviews` |
| 404 | Owner without a provider | `Provider profile not found` |
| 404 | Review missing **or belonging to another provider** (identical) | `Review not found` |
| 409 | Review hidden | `Hidden reviews cannot be responded to` |
| 409 | Response already exists | `Review already has a response` |

- This adds no new semantics.
- 404 for a cross-tenant resource matches P2 (bookings, reviews).
- 409 for state conflicts matches P2 (`409` = business conflict).
- **Enumeration:** a review id from another provider is indistinguishable from a missing one, and the list takes no provider or review ids.

---

## 10. QA acceptance matrix

**Legend.**

Level:
- **U**: unit test (`src/reviews/*.spec.ts`, mocked DataSource);
- **Q**: HTTP QA on a disposable DB (`test/qa/provider-feedback.cjs`, `qa-env.cjs` pattern);
- **R**: existing regression.

Owner: the subtask that implements the test.

| # | Case | Expected | Level | Owner |
|---|---|---|---|---|
| 1 | Provider A lists its reviews | 200, only A's rows, envelope correct | U+Q | 02 |
| 2 | Provider B lists | Never sees A's rows (scope from token only) | Q | 02 |
| 3 | B responds to A's review | 404 `Review not found`; row unchanged | U+Q | 02 |
| 4 | Customer calls the list / respond | 403 | Q | 02 |
| 5 | Admin calls provider routes; forged `providerId` query/body | 403; 400 (unknown field) | Q | 02 |
| 6 | Inactive staff (role reverted, and the edge case with no ACTIVE row) | 403 | U+Q | 03 |
| 7 | Suspended provider | List 200; respond 403 | U+Q | 02 |
| 8 | Valid response | `responded_by = caller.id` in the DB | Q | 02 |
| 9 | Timestamp | `responded_at` within the DB `now()` window, not client time | Q | 02 |
| 10 | Body contains `respondedBy` | 400 | Q | 02 |
| 11 | Body contains `respondedAt` | 400 | Q | 02 |
| 12 | Second response | 409, original text, actor and time unchanged | U+Q | 02 |
| 13 | N parallel POSTs | Exactly 1×201, N−1×409, one DB write | Q | 03 |
| 14 | 1001 chars / whitespace-only / NUL / non-string | 400 | U+Q | 02 |
| 15 | PUT/PATCH/DELETE response; staff POST | 404 (no route) / 403 | Q | 03 |
| 16 | Hidden review absent from public list | Absent | R+Q | 03 |
| 17 | Hidden review responded-to (provider) and via the public route | 409; not exposed | Q | 03 |
| 18 | Hide/restore recompute; responses do not change the rating | `rating_count/avg` = visible rows | R+Q | 03 |
| 19 | Provider list shows hidden reviews flagged; `visibility=hidden` filter | Matches §6 | U+Q | 02/03 |
| 20 | Hide/restore by provider/customer | 403 | R+Q | 03 |
| 21 | Hide/restore writes `admin_activity_logs`; admin view shows `respondedBy` | Present | R+Q | 03 |
| 22 | Second review on the same booking (hidden or not) | 409 | R | 03 |
| 23–25 | P2-14 eligibility, COMPLETED, one per booking | Unchanged (E1) | R | 04 |
| 26 | `/providers/me`, public provider detail/search, `/bookings/provider` | Unchanged | R | 04 |
| 27 | Booking, complaint, notification/push flows | Unchanged | R | 04 |
| 28 | No email, phone, password hash or customer id in list/response bodies; response text not logged | Verified by key scan (as `forbiddenIn` in mvp-e2e) | Q | 03 |

Also: admin hide racing a response (§8) is checked in BE08-03 (Q).

Existing regression to rerun in BE08-04:

- full `npm test`;
- `qa:mvp-e2e` (E1–E3);
- `fe-smoke`;
- BE06/BE07 push QA scripts on disposable DBs.

---

## 11. Implementation plan

**BE08-02: list and response API**

- Optional migration `1797500000000` (D9) + entity `@Check`s.
- `assertProviderCanRespondToReviews` in `provider-lifecycle.policy.ts`, with the matrix comment updated.
- A provider-scope resolver for reviews:
  - same semantics as `resolveManagedProviderId`;
  - supports locked re-validation;
  - lives as `src/providers/provider-scope.ts`;
  - the bookings code is **not** refactored in BE08.
- `ProviderReviewsController` (`providers/me/reviews`), `ProviderReviewListQueryDto`, `CreateReviewResponseDto`, view mapper.
- `ReviewsService.listProviderReviews` and `respondToReview`.
- Unit specs.
- `test/qa/provider-feedback.cjs` covering rows 1–5, 7–12, 14 and 19.
- Disposable DB only.

**BE08-03: hidden policy and security QA**

- Add `respondedBy` to the admin review projection.
- Concurrency QA (13, admin-hide race).
- Cross-role and inactive-staff cases (6, 15).
- Hidden/aggregate/audit cases (16–22).
- Leak scan (28).
- Apply D6 if the decision changes.

**BE08-04: full regression and deployment**

- Source freeze and fingerprint.
- Migration rehearsal on a copy of `pet_care_db`.
- Full regression (23–27).
- Backup and rollback runbook.
- Development smoke.
- **Separate approval** to deploy.

**Hard ordering:** BE07-04B (migration 16) must be deployed before BE08's migration 17.

---

## 12. Product decisions

**Status: all ten APPROVED as recommended (2026-11-14, BE08-02 brief).** D9 was approved with a condition: the consistency CHECK must not require `responded_by`, because `ON DELETE SET NULL` must keep working. The §7 expression already met that condition. §13 records the final form.

| # | Decision | Approved default |
|---|---|---|
| D1 | Staff access | **Read-only list**. No responding. |
| D2 | Response mutability | **Create-once, immutable**. 409 on repeat. No edit/delete in BE08. |
| D3 | Provider sees hidden reviews | **Yes, flagged `isVisible:false`** (no reason exists to leak; the author already sees them). |
| D4 | Respond to a hidden review | **No (409)**. |
| D5 | Provider status for responding | **APPROVED only**. Reads allowed in every status. |
| D6 | `respondedBy` in customer `/reviews/mine` | **Keep unchanged** in BE08 (FE contract). Revisit with an FE projection later. |
| D7 | Admin removal of an abusive response | **Defer**. Documented gap. A future `PATCH /admin/reviews/:id/response/remove` with an activity-log action would be additive (the `action` column has no DB CHECK). |
| D8 | Response length | **1–1000** characters after trimming. |
| D9 | DB CHECK migration | **Include** in BE08-02. |
| D10 | Notify the customer of a response / `REVIEW_RECEIVED` | **Out of scope** (no push changes in BE08). |

---

## 13. BE08-02 implementation record (authoritative)

### 13.1 Files

| Kind | Path |
|---|---|
| New | `src/reviews/provider-reviews.controller.ts`, `src/reviews/provider-reviews.service.ts` |
| New | `src/reviews/dto/provider-review-list-query.dto.ts`, `src/reviews/dto/create-review-response.dto.ts` |
| New | `src/reviews/provider-review-views.ts` (projection, mapper, Swagger schema), `src/reviews/review-response-text.ts` (text rules, CHECK literals) |
| New | `src/database/migrations/1797500000000-AddReviewResponseConstraints.ts` |
| New | `src/reviews/provider-reviews.spec.ts`, `test/qa/provider-feedback.cjs` |
| Modified | `src/reviews/reviews.module.ts` (registers the controller and service) |
| Modified | `src/reviews/entities/review.entity.ts` (two `@Check`s) |
| Modified | `src/providers/provider-lifecycle.policy.ts` (`assertProviderCanRespondToReviews`) |
| Modified | `package.json` (`qa:provider-feedback`) |

Untouched:

- `ReviewsService`, which holds P2-14 creation, `/reviews/mine` and the public list;
- `AdminService` hide/restore;
- bookings, notifications and push.

The provider-scope logic was written inside `ProviderReviewsService` with the same semantics as `resolveManagedProviderId`. The bookings code was not refactored, to avoid regression risk. Consolidating the two remains optional later work.

### 13.2 Authorization (D1, D5)

| Caller | `GET /providers/me/reviews` | `POST …/:reviewId/response` |
|---|---|---|
| Provider owner | 200, own provider. Any provider status. | 201 if APPROVED. Otherwise 403 `A <STATUS> provider cannot respond to reviews` (checked before any review lookup). |
| ACTIVE staff | 200, its provider (read-only) | 403 (RolesGuard) |
| Staff with an INACTIVE row but role still `PROVIDER_STAFF` | 403 `Active provider staff association is required` | 403 |
| Staff deactivated through the API (role reverted to CUSTOMER) | 403 | 403 |
| Customer, admin | 403 | 403 |
| Anonymous, or a revoked/expired session, or an account that is not ACTIVE | 401 | 401 |
| Owner without a provider | 404 `Provider profile not found` | 404 `Provider profile not found` |

Scope:

- The provider is derived only from the authenticated user.
- `provider_staff.user_id` is UNIQUE, so a staff member has at most one provider and there is no provider-selection case.
- A provider id in the query (`providerId`, `provider`, `ownerId`) or in the body is an unknown property and gets 400.

### 13.3 `GET /api/providers/me/reviews`

**Query:**

| Param | Rule |
|---|---|
| `page` | 1–1000, default 1 |
| `limit` | 1–50, default 20 |
| `maxId` | positive bigint string |
| `rating` | integer 1–5 |
| `visibility` | `all` \| `visible` \| `hidden` |
| `responded` | `all` \| `responded` \| `unresponded` |
| `sort` | `newest` \| `oldest` \| `rating_desc` \| `rating_asc` |

- Numbers are converted only from canonical decimal strings.
- Anything else, including unknown parameters, gets 400.

**Ordering** is total and deterministic:

| `sort` | ORDER BY |
|---|---|
| `newest` | `created_at DESC, id DESC` |
| `oldest` | `created_at ASC, id ASC` |
| `rating_desc` | `rating DESC, created_at DESC, id DESC` |
| `rating_asc` | `rating ASC, created_at DESC, id DESC` |

**`maxId` with every sort:**

- `maxId` is a set filter (`reviews.id <= maxId`), not a cursor.
- Every sort key (`created_at`, `rating`, `id`) is immutable after insert.
- So the frozen set keeps the same order across pages, and no combination needs to be restricted.
- **Limit:** the `visibility` and `responded` filters select on mutable state. An admin hide/restore or a new response between two page requests can move a row in or out of a filtered page. This is the same limitation as the inbox `status` filter, and it is documented rather than prevented.

**Response:**

- `200 { items, meta, query }`. `query` echoes `{ rating|null, visibility, responded, sort, maxId|null }`.
- The anchor is `max(id)` **within the caller's provider**, so it reveals nothing about other providers.
- With no reviews: `items: []`, `totalPages: 0`, `maxId: null`.
- A page past the end returns 200, empty, with accurate totals.

**Item:** exactly the §4 shape:

- `id, rating, comment, isVisible, createdAt`;
- `booking { id, service { id, name }, slot { slotDate, startTime } }`;
- `customer { fullName }`;
- `response { text, respondedAt, respondedBy { id, fullName } | null } | null`.

Hidden reviews are included with `isVisible: false` (D3). The public list, `/reviews/mine` and the aggregates are unchanged.

### 13.4 `POST /api/providers/me/reviews/:reviewId/response`

**Body:** `{ "text": string }` only. `respondedBy`, `respondedAt`, `providerId`, `userId` and any other property get 400.

**Text normalization:**

1. CRLF and CR become LF.
2. `String.prototype.trim()`.
3. The result must be 1–1000 **Unicode code points** (`Array.from(text).length`, the same count as PostgreSQL `char_length`).
4. NUL is rejected.

So 1000 emoji (2000 UTF-16 units) is accepted.

**Success:** `201` with the review in the list-item shape.

**Errors:**

| Status | Message |
|---|---|
| 400 | Validation errors, or an invalid `reviewId` |
| 401 | Unauthenticated, or the account or session was invalidated meanwhile |
| 403 | Role is not owner; provider is not APPROVED; role changed meanwhile |
| 404 | `Review not found` (missing, or another provider's, with an identical body); `Provider profile not found` |
| 409 | `Hidden reviews cannot be responded to` (D4) |
| 409 | `Review already has a response` (D2; also identical replays and concurrent losers) |

No new error-code field was introduced. The project's review/booking APIs use the Nest default `{ statusCode, message, error }`, and the messages above are stable constants exported from `provider-reviews.service.ts`.

### 13.5 Transaction and locking (supersedes §8 step list)

The write runs in one READ COMMITTED transaction:

1. **Resolve and check policy.** Find the owner's provider with an unlocked read. Not found: 404. Then `assertProviderCanRespondToReviews`: 403.
2. **Lock the review.** `SELECT … FROM reviews r JOIN bookings b … WHERE r.id = $1 AND b.provider_id = $2 FOR UPDATE OF r`. No row: 404.
3. **Lock the provider.** `providers` row `FOR SHARE`. If `owner_id` is not the caller: 404. If the status is not APPROVED: 403.
4. **Lock the user.** `users` row `FOR SHARE`. If the account is not ACTIVE: 401. If the role is not PROVIDER_OWNER: 403.
5. **Lock the session.** `auth_sessions` row `FOR SHARE`. If it is revoked or expired: 401. Steps 4–5 are new compared to §8: the actor must remain authorized throughout the write.
6. **State checks.** Hidden: 409. Already responded: 409.
7. **Write.**

   ```sql
   UPDATE reviews
   SET provider_response = $text, responded_by = $user, responded_at = now(), updated_at = now()
   WHERE id = $1 AND provider_response IS NULL AND is_visible
   ```

   0 rows: 409.
8. **Read back** the projection inside the transaction, then commit.

**Lock order is review → provider → user → session.** Every existing lock in the code base was checked:

- admin hide/restore: review → provider;
- review creation: booking → provider, never an existing review;
- provider suspension: provider only;
- login/refresh: user FOR SHARE → session;
- account suspension: user → sessions → tokens;
- nothing locks provider/user/session first and then a review.

So the order adds no cycle.

**Other properties:**

- No external call is made while locks are held.
- The log line has ids only: `Provider <id> responded to review <id> (user <id>)`. The response text is never logged.

### 13.6 Migration `1797500000000-AddReviewResponseConstraints` (D9)

> **Superseded in part by BE08-03 (§14).** The text CHECK's `btrim` set is now the full ECMAScript trim set (25 code points), not the 6 ASCII characters shown below. The rest of this section is unchanged.

```sql
chk_reviews_response_consistency CHECK (
  (provider_response IS NULL AND responded_by IS NULL AND responded_at IS NULL)
  OR (provider_response IS NOT NULL AND responded_at IS NOT NULL))
chk_reviews_response_text CHECK (
  provider_response IS NULL OR (
    char_length(provider_response) BETWEEN 1 AND 1000
    AND provider_response = btrim(provider_response, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13))))
```

- **Responder:** a responded row may have `responded_by IS NULL`, but only after the responder account was physically deleted (`fk_reviews_responder ON DELETE SET NULL`, unchanged). The API always sets it.
- **Character rule:**
  - `char_length` counts code points, the same as the DTO.
  - The DB rejects leading/trailing ASCII whitespace.
  - The API trims a superset of that, the ECMAScript whitespace set, so every API value passes.
  - Blank text fails both the API and the DB.
- **Preflight:** `up` counts violating rows and aborts with counts only (no row content). `down` drops both constraints with no data loss.
- **Order:** after `1797000000000` (BE07). Migration 17 needs BE07's migration 16 deployed first.

### 13.7 Test evidence (2026-11-14, disposable databases only)

| Check | Result |
|---|---|
| Focused Jest `src/reviews` + lifecycle policy | 3 suites, **88/88** |
| `qa:provider-feedback` (`pawflow_qa_provider_feedback`, 2 API instances, final run) | **50/50** |
| Related Jest regression: `src/reviews`, `src/admin`, `src/providers`, `src/bookings`, `app.module.spec`, `common/pipes`, `auth/authorization` | 22 suites, **577/577** |
| `qa:mvp-e2e` (`pawflow_qa_mvp_e2e`; P2-14 E1–E3, complaints, payments) | **110/110** |
| `tsc --noEmit` (app and spec configs), `npm run lint`, `npm run build` | all exit 0 |

QA suite coverage (brief items 1–32 plus extras):

- **Migration:**
  - order and 0 pending DDL;
  - down/up on existing data with an unchanged fingerprint;
  - the preflight abort;
  - CHECK matrix (empty, blank, tab/newline, leading/trailing whitespace, 1000/1001 ASCII, 1000/1001 emoji, 1000 Vietnamese, consistency combinations);
  - responder deletion → `SET NULL` with text kept.
- **Scope:**
  - owner A/B isolation, including totals and anchors;
  - active staff read;
  - inactive staff, both variants;
  - customer, admin, anonymous, owner without a provider;
  - query tampering.
- **Writes:**
  - actor and DB-clock timestamp;
  - forged fields;
  - staff write;
  - cross-provider 404 identical to missing;
  - hidden 409;
  - duplicate and identical replay 409;
  - **12 concurrent POSTs on two instances: exactly 1×201 + 11×409**;
  - invalid text;
  - Unicode boundary;
  - suspended provider.
- **Locked races.** A second connection holds the row lock, the API request is observed blocked in `pg_stat_activity`, then the change commits:
  - suspension → 403;
  - ownership change → 404;
  - hide → 409;
  - a response committed first → 409;
  - account suspension → 401;
  - logout → 401;
  - no change → 201.
- **Hide vs response:**
  - 6 real admin hide ∥ response pairs (no 5xx; every outcome consistent);
  - response-then-hide keeps the response (D4) and it reappears on restore.
- **Listing:** hidden flags for owner and staff; filters equal DB counts; stable paging for all four sorts with a review inserted mid-paging; past-the-end page; empty provider.
- **Regression:**
  - P2-14 (409 / 404 / 400 / 403 / 201 / duplicate 409, also when the existing review is hidden);
  - public list projection and hidden exclusion;
  - aggregates equal visible rows;
  - `/reviews/mine` shape unchanged;
  - admin hide/restore activity logs.
- **Data exposure:** no contact data, ids or notes in provider bodies.
- **Logs and runtime:** no secrets or response text in logs; no 5xx; 0 deadlocks.

`pet_care_db` was only read: 15 migrations, no BE07/BE08 objects. The only pre-existing QA database, `pawflow_qa_push_delivery`, was left in place.

### 13.8 Remaining for BE08-03 / BE08-04

- **BE08-03:**
  - add `respondedBy` to the admin review projection (verified absent today);
  - extend the real hide∥response race to force the response-first interleaving. Today it is covered deterministically by the locked-race and response-then-hide checks, but in 6/6 real races the hide won;
  - optionally add a `createReview` unit test, since P2-14 relies on HTTP QA;
  - review the documented mutable-filter paging limit with FE.
- **BE08-04:**
  - BE07-04B first (migration 16);
  - then a migration-17 rehearsal on a copy of `pet_care_db`;
  - backup and rollback;
  - full regression and smoke;
  - separate deployment approval.

Status of these items after BE08-03 (§14):

- Admin `respondedBy`: done.
- Response-first race: done, forced deterministically.
- Mutable-filter paging: still documented.
- `createReview` unit test: not added; P2-14 remains covered by HTTP QA.

---

## 14. BE08-03 record (moderation integration and security)

Full record: [p3-be08-moderation-security.md](p3-be08-moderation-security.md). Summary:

**Admin projection.** `/admin/reviews` list, detail, hide and restore add `respondedBy: { id, fullName } | null`:

- `null` when there is no response;
- also `null` when the responder was deleted, with the text and time kept.

It comes from one LEFT JOIN, and the Swagger schema is `ADMIN_REVIEW_SCHEMA`.

**Integrity fix in the pending migration 17.** The text CHECK now trims the 25 code points of `String.prototype.trim`, so the DB rejects Unicode-blank or padded text that the API never produces. It previously trimmed only 6 ASCII characters.

```sql
chk_reviews_response_text CHECK (
  provider_response IS NULL OR (
    char_length(provider_response) BETWEEN 1 AND 1000
    AND provider_response = btrim(provider_response,
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) ||
      chr(8192) || … || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279))))
```

The consistency CHECK is unchanged.

**Races forced in both directions** with row-lock barriers:

- admin hide wins: response 409, nothing written;
- response wins: 201, then hide; the response is kept internally and hidden publicly;
- restore vs response: exactly one response;
- revocation (ownership, provider suspension, account suspension, session): 404 / 403 / 401 / 401.

**QA results:**

| Check | Result |
|---|---|
| `qa:review-moderation` | 41/41 |
| `qa:provider-feedback` | 50/50 |
| `qa:mvp-e2e` | 110/110 |
| Focused unit tests | 72/72 |
| Related Jest | 598/598 |
| tsc, lint, build | pass |
