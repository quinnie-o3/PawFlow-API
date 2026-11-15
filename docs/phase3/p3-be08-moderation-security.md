# P3-BE08-03 — Review Moderation Integration & Security Hardening

Status: **PASS (2026-11-14)**. Not committed. Migration `1797500000000` has not been applied to `pet_care_db`.

Baseline:

- branch `feature/provider-feedback`, HEAD `57ebede`;
- uncommitted BE08-02 work.

Related docs: [p3-be08-feedback-contract.md](p3-be08-feedback-contract.md) (§1–§13) and [p3-be08-progress.md](p3-be08-progress.md).

Decisions D1–D10 are unchanged.

## 1. Changes

| Change | Files |
|---|---|
| Admin review projection gains `respondedBy` | `src/admin/admin.service.ts` (type, query, mapper) |
| Swagger schema for admin review responses (list, detail, hide, restore) | `src/admin/dto/admin-review.schema.ts` (new), `src/admin/admin-reviews.controller.ts` |
| **Integrity fix:** the text CHECK now trims the full ECMAScript whitespace set | `src/database/migrations/1797500000000-AddReviewResponseConstraints.ts` (pending migration), `src/reviews/review-response-text.ts` |
| Focused unit tests | `src/reviews/review-moderation-security.spec.ts` (new) |
| PostgreSQL QA suite | `test/qa/review-moderation.cjs` (new); `package.json` `qa:review-moderation` |

Unchanged:

- the BE08-02 endpoints and the provider service;
- P2-14 review creation;
- the public review list;
- `/reviews/mine`;
- the hide/restore transaction and its audit logging;
- bookings, complaints, notifications and push.

## 2. Admin review projection

`GET /admin/reviews`, `GET /admin/reviews/:id`, `PATCH /admin/reviews/:id/hide` and `PATCH /admin/reviews/:id/restore` all return the same shape. One mapper serves all four, so list and detail are identical.

```json
{
  "id": "41", "bookingId": "310", "rating": 2, "comment": "…",
  "providerResponse": "Sorry for the wait",
  "respondedBy": { "id": "12", "fullName": "Tran Binh" },
  "respondedAt": "2026-11-14T09:00:00.000Z",
  "isVisible": false,
  "createdAt": "…", "updatedAt": "…",
  "booking": { "id": "310", "customerId": "7", "providerId": "1", "serviceId": "3", "status": "COMPLETED" }
}
```

| State | `providerResponse` | `respondedBy` | `respondedAt` |
|---|---|---|---|
| No response | `null` | `null` | `null` |
| Response | text | `{ id, fullName }` | DB time |
| Responder account deleted (`ON DELETE SET NULL`) | text (kept) | `null` (no responder is invented) | DB time (kept) |

- **Representation:** `{ id, fullName }`, the same as the provider-facing view. No email, phone, role, status or session data, verified by key-set and value checks.
- **Query cost:** one `LEFT JOIN users` inside the existing query builder. No per-row lookup.
- **Pagination:** the admin list was unpaginated before and still is; BE08-03 does not change that.

## 3. Hidden-review access matrix (verified)

| Actor | Visible review | Hidden review | Where enforced | QA |
|---|---|---|---|---|
| Public visitor | read | not accessible | SQL `is_visible = true` in `GET /reviews/provider/:id`. No public detail endpoint exists. | 10, 12 |
| Review author | own | own, `isVisible:false` | `/reviews/mine` (unchanged) | 13, 33 |
| Provider owner | own provider | own provider, `isVisible:false` | `GET /providers/me/reviews` | 14 |
| ACTIVE staff | assigned provider | same, flagged | same endpoint, read-only | 15 |
| Inactive staff, other provider | none | none | scope from the token in SQL | 16 |
| Admin | read | read and moderate | `/admin/reviews` (ADMIN only) | 1–8 |

### Public read paths that reuse review data (inventory)

| Path | Hidden reviews | Notes |
|---|---|---|
| `GET /reviews/provider/:providerId` | excluded (SQL) | Unpaginated, so there are no counts to leak |
| `providers.rating_avg` / `rating_count` (public detail, search items, `sort=rating_desc`, `minRating`) | excluded | Recomputed from visible rows on review creation, hide and restore |
| `GET /providers/public/search?q=` | n/a | Matches provider and service fields, never review text. Searching the hidden comment's unique token returns 0 results. |
| Provider dashboard average and DSS low-rating alert | excluded | Provider-facing; `isVisible = true` in both queries |
| Admin statistics `ratings.total` | included | Admin-only count of all reviews |

## 4. Moderation and audit (unchanged in meaning)

Admin-only behaviour, unchanged:

- hide: VISIBLE → HIDDEN; hiding a hidden review returns 409;
- restore: HIDDEN → VISIBLE; restoring a visible review returns 409;
- each runs in one transaction that locks the review, then the provider, recomputes the rating and writes `admin_activity_logs` (`REVIEW_HIDDEN` / `REVIEW_RESTORED`, `admin_user_id`, metadata `fromVisible`, `toVisible`, `ratingCount`, `ratingAvg`).

Verified that providers **cannot**:

| Attempt | Result |
|---|---|
| Hide or restore (owner, staff, customer) | 403 |
| Forge an admin identity: a JWT with `role: ADMIN` signed with another secret, or an `alg: none` token | 401 |
| Send `isVisible`, `is_visible`, `adminUserId`, `role` or `providerResponse` in the response body | 400 |
| `PATCH /providers/me/reviews/:id`, or `PATCH` / `PUT` / `DELETE …/response` | 404 (no such route) |
| Respond to another provider's review | 404 |

The review row stayed unchanged in every case.

Responses through moderation:

- An answered review keeps its text, responder and `respondedAt` through hide and restore.
- Restore never creates or changes a response.

## 5. Locking and concurrency

**Lock order:**

- Provider response: **review → provider → user → session**. Unchanged from BE08-02. The review is `FOR UPDATE`; the other three are `FOR SHARE`.
- Admin hide/restore: review `FOR UPDATE` → provider `FOR UPDATE`.

Both start at the review, so they serialize on that row and the response's decision ("is it visible? already answered?") is made after any committed moderation.

**Deterministic barriers.** In each race below, a second connection holds a row lock that one of the two transactions needs next. The QA observes both transactions waiting in `pg_stat_activity`, then releases the barrier. Both orders are therefore **forced**, not left to timing.

| Race | Barrier | Order forced | Result |
|---|---|---|---|
| **A: admin hide wins** | provider row `FOR SHARE` (hide holds the review lock and waits for the provider) | hide, then response | hide 200; response **409** `Hidden reviews cannot be responded to`; `provider_response` / `responded_by` / `responded_at` all NULL; `REVIEW_HIDDEN` audit present |
| **B: response wins** | owner's `users` row `FOR UPDATE` (the response holds the review lock and waits for the user) | response, then hide | response **201**; then hide 200; one response with `responded_by` = owner and `responded_at` between DB clock readings; excluded from the public list and aggregates; visible to the owner (`isVisible:false`) and to admin with `respondedBy` |
| **C1: restore first** | provider `FOR SHARE` (restore waits) | restore, then two responses | restore 200; exactly **one 201 + one 409**; one stored response |
| **C2: response on a hidden review first** | `users` `FOR UPDATE` (the response waits) | response, then restore | response **409**; restore 200; nothing written. Afterwards 201, then 409. |
| **D: access revocation** | provider / users / auth_sessions row `FOR UPDATE`, then a change is committed | revocation, then response | ownership change 404; provider SUSPENDED 403; account SUSPENDED 401; session revoked 401; nothing written in any case. A revoked token stays rejected (401). |
| Duplicates | none (real concurrency, 2 instances) | — | 10 parallel POSTs: exactly 1×201 + 9×409 |

**Other properties:**

- 0 deadlocks; no 5xx.
- No external call is made while row locks are held. The response transaction does only database work.
- The `updated_at` written by a failed response is never committed, because the whole transaction rolls back.

## 6. Data integrity and Unicode

### Finding: integrity gap, fixed

The BE08-02 text CHECK trimmed only the 6 ASCII whitespace characters. The API trims with `String.prototype.trim`, which removes 25 code points. The database would therefore have accepted text that the API can never produce:

- NBSP-only (`' '`), which is blank;
- `'　hi'`;
- `'hi '`;
- `'﻿hi'`.

**Fix (smallest safe change):** the pending migration's `btrim` set now lists exactly the ECMAScript trim set, written as `chr()` codes:

```
9 10 11 12 13 32 160 5760 8192–8202 8232 8233 8239 8287 12288 65279
```

- A unit test computes the set from the running JS engine (Node 22.19, Unicode 16) and asserts equality.
- Another unit test asserts that the migration installs exactly the entity's CHECK strings.
- The migration had not been applied to any persistent database, so editing it is safe. The only other copies were disposable QA databases.
- **Not a whitespace character:** U+180E (MONGOLIAN VOWEL SEPARATOR). JS does not trim it, and the DB accepts it, so the two stay consistent.

### Length rule

The rule is **1–1000 Unicode code points after normalization** (CRLF/CR → LF, then trim).

| Measure | Used for | Example: `'é'` × 500 | Example: 👨‍👩‍👧 |
|---|---|---|---|
| Code points (`Array.from(s).length`, PostgreSQL `char_length`) | **the rule** (DTO and CHECK) | 1000 → accepted (1001 rejected) | 5 |
| UTF-16 units (`s.length`) | not used | 1000 | 8 |
| Grapheme clusters | not used | 500 | 1 |

1000 emoji (2000 UTF-16 units) is accepted. API and DB agree on every boundary tested.

### Documented policy (unchanged, not new rules)

- **No Unicode normalization (NFC/NFD).** `café` precomposed (4 cp) and decomposed (5 cp) are stored as sent, so their lengths differ by the combining marks.
- **Control characters:** only NUL is rejected (PostgreSQL text cannot hold it). Others, such as U+0007, are accepted and stored as sent.
- **Lone UTF-16 surrogate** in JSON (`"\ud800"`): Node encodes it as U+FFFD when writing UTF-8. The stored and returned text contains U+FFFD, which is 1 code point either way, so lengths still agree.

Rejecting control characters or malformed surrogates would be a new input policy. It is listed as an open item rather than introduced silently.

### CHECK matrix (direct SQL, 23514 = rejected)

| Case | Result |
|---|---|
| NBSP-only; leading U+3000; trailing NBSP; leading BOM; trailing U+2028 | 23514 |
| inner NBSP; leading U+180E; 1000 cp combining | accepted |
| 1001 cp combining | 23514 |
| text without time; time without text; responder without text | 23514 |

BE08-02 cases (ASCII blank and padding, 1000/1001 ASCII and emoji, Vietnamese) were rerun: unchanged.

`responded_by` is set from the authenticated user on creation. `ON DELETE SET NULL` still works: the text and time are kept and the admin and provider views show `respondedBy: null`.

## 7. Focused QA results (2026-11-14, disposable databases only)

| Check | Result |
|---|---|
| New unit spec `review-moderation-security.spec.ts` + `provider-reviews.spec.ts` | 2 suites, **72/72** |
| New `qa:review-moderation` (`pawflow_qa_review_moderation`, 2 API instances) | **41/41** (final run). The first run was 40/41; see below. |
| `qa:provider-feedback` (BE08-02, rerun because the migration changed) | **50/50** |
| `qa:mvp-e2e` (rerun because the admin projection changed; P2-14 E1–E3, admin hide/restore, complaints, payments) | **110/110** |
| Related Jest: `src/reviews`, `src/admin`, `src/providers`, `src/bookings`, `app.module.spec`, `common/pipes`, `auth/authorization` | 23 suites, **598/598** |
| `tsc --noEmit` (app and spec configs), `oxlint src/ test/`, `nest build` | exit 0 |

**The one failure and its resolution.** Check 12 first asserted that `minRating = avg + 0.01` combined with `q="QA Mod A <run>"` returns 0 providers. It returned provider B: search terms match individually, and "A" matches "QA" in B's name. This was a test defect, not a product defect. The assertion now checks that provider A is absent. The `minRating` filter (`rating_avg >= :minRating`) was correct.

Map of brief items to QA checks:

| Brief items | QA checks |
|---|---|
| 1–5 | 1, 1b, 2, 3, 4, 5 |
| 6–16 | 6, 7/8, 9, 10–17 |
| 17–25 | 17, 18, 19, 20, 21a, 21b, 22, 23, 24, 25, 25b |
| 26–30 | 26, 27, 28, 29, 30, plus the documented-policy check |
| 31–35 | 31/32, 33, 34, 35 |

Global checks: logs (no secrets or response text), no 5xx, 0 deadlocks.

`pet_care_db`: read only (15 migrations, 0 reviews). `pawflow_qa_push_delivery` was left in place.

## 8. Known limitations

- Admin review list is unpaginated (pre-existing; not in BE08 scope).
- Removing an abusive provider response is still deferred (D7). Hiding the review is the only tool, and it also removes the review from the rating.
- Control characters other than NUL are accepted; lone surrogates become U+FFFD. Both are documented, with no new policy.
- No Unicode normalization: visually identical texts can differ in code-point length.
- Paging with `visibility`/`responded` filters can shift when moderation or responses happen between page requests (BE08-02 §13.3).
- QA covers 2 API instances on one PostgreSQL, not multi-node PostgreSQL.

## 9. BE08-04 prerequisites

1. **Source freeze** of the uncommitted BE08 tree, then a commit and PR plan:
   - BE06 → `dev` is still pending;
   - BE07 commit `57ebede` is not in `dev`.
2. **BE07-04B deployed first** (migration 16 `1797000000000`) with its own approval.
3. **Migration 17 rehearsal on a copy of `pet_care_db`:**
   - preflight counts;
   - `up` / `down` / `up`;
   - CHECK definitions as in §6.
4. **Backup and rollback runbook.** `down` drops only the two constraints.
5. **Full repository regression**, plus `qa:provider-feedback`, `qa:review-moderation` and `qa:mvp-e2e`.
6. **Development smoke** of `/providers/me/reviews` and `/admin/reviews`.
7. **Separate deployment approval.**
