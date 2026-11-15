# PawFlow — FE Feature → API → Error → Evidence Traceability (P3-BE12)

Status: **backend contract complete (121/121 routes mapped with automated evidence); frontend integration largely unverified** (see §2).
Part of the release contract freeze: [p3-be12-release-contract-freeze.md](p3-be12-release-contract-freeze.md).
`npm run contract:check` (check D1/D2) fails if a route or a machine-readable error code is missing from this document.

## 1. How to read the matrix

| Column | Source |
|---|---|
| UI action | The operation's Swagger `summary` (what the user does), from [docs/api/openapi.json](../api/openapi.json). |
| HTTP endpoint | Runtime route metadata (`test/qa/route-inventory.cjs`), relative to `/api`. |
| Auth / role | Guards and `@Roles` of the handler. `+ auth rate limit` = endpoint policy of P3-BE03/BE11. |
| Request → response | Request DTO schema → documented success status and response schema. `(no schema)` = one of the 68 frozen response-schema gaps (`docs/api/release-manifest.json`); the response shape is then documented in [docs/phase2/mvp-fe-api-contract.md](../phase2/mvp-fe-api-contract.md) or the module document. |
| Error codes | Documented 4xx/5xx statuses. `+429/503` = API-wide rate limiter (every route except health): `429 RATE_LIMITED` + `Retry-After`, `503 RATE_LIMIT_UNAVAILABLE`. |
| Automated evidence | QA/E2E suites whose source calls the endpoint (text search of `test/qa/*.cjs` and `test/app.e2e-spec.ts`; first three shown, `(+n)` more) plus **matrix** = `qa:api-security-matrix`, which calls *every* route anonymously, with each role and with forged tokens, and asserts 401/403/no side effects. `qa:contract-smoke` (new in BE12) covers the 32 routes that had no functional suite and checks every observed status against Swagger. |
| Verification status | **BE ✅** = backend behaviour asserted by at least one functional suite (all 121 routes). Frontend: **FE real (unverified)** = the frontend calls the endpoint in code but the call was never executed against this backend; **FE mock** = a frontend screen exists but uses local fixtures (no HTTP call); **FE none** = no frontend code for it. |

## 2. Frontend repository facts (read-only inspection)

- Repository `../pet-care-web`, branch `dev`, HEAD `b70d18b` (FE-013/FE-014/FE-015 merged), plus 31 uncommitted modified files in the owner's working tree (not inspected for intent, not changed).
- **FE-060 deliverable: not found.** No branch, document or code mentions FE-060. The FE documents go up to FE-015.
- Real HTTP calls: **2** (`src/features/auth/services/loginCustomer.ts`, `registerCustomer.ts`), base URL `NEXT_PUBLIC_API_URL` (`.env.example`: `http://localhost:8000/api`). Every other screen uses local mock fixtures that are explicitly labelled "not an API contract".
- FE-012's own report states that a successful login/register against the real backend was never tested.

Consequently: **backend contract documented = yes; frontend integration inferred (mock screens) = yes; frontend integration actually verified = no** (not even login/register). FE-060 remains an open dependency of P3-BE12.

### Feature summary

| # | FE feature | Frontend today | Routes | Backend evidence |
|---|---|---|---|---|
| F01 | Registration & login | REAL calls (unverified); `/auth/me` not called | 3 | ✅ |
| F02 | Refresh, logout, logout-all, sessions | none | 5 | ✅ |
| F03 | Account recovery & e-mail verification | none | 5 | ✅ |
| F04 | User profile | none | 2 | ✅ |
| F05 | Pet management | none | 6 | ✅ |
| F06 | Provider onboarding | none | 1 | ✅ |
| F07 | Provider management (profile, staff, hours, dashboard, payments) | mock (`/dashboard`, `/dashboard/profile`) | 15 | ✅ |
| F08 | Services | mock (`/dashboard/services`) | 6 | ✅ |
| F09 | Availability | mock (`/dashboard/availability`) | 5 | ✅ |
| F10 | Search & public catalogue | none | 9 | ✅ |
| F11 | Booking (customer), reviews, complaints | none | 9 | ✅ |
| F12 | Booking status changes (provider/staff) | mock (`/dashboard/bookings`, `/staff/bookings`) | 6 | ✅ |
| F13 | Admin management & audit | mock (`/admin/*`) | 30 | ✅ |
| F14 | Notification inbox | mock (`/dashboard/notifications`) | 5 | ✅ |
| F15 | FCM devices | none | 3 | ✅ |
| F16 | Notification preferences | none | 2 | ✅ |
| F17 | Provider feedback & moderation | mock (`/admin/reviews`) | 6 | ✅ |
| F18 | Health & diagnostics | n/a (operations) | 3 | ✅ |

## 3. FE–BE consistency findings

Real calls (verified by reading the code):

| # | Finding | Impact | Owner / action |
|---|---|---|---|
| T1 | `loginCustomer` / `registerCustomer` send no `turnstileToken`. Staging and production **must** run `TURNSTILE_MODE=enforce` (BE11 validator), so every login/register there returns `403 TURNSTILE_REQUIRED`. | **Blocks login/register on any deployed environment.** Works locally only with `TURNSTILE_MODE=disabled`. | FE: render the Turnstile widget (action `login` / `register`) and send `turnstileToken` ([bot-protection.md](bot-protection.md) §2). |
| T2 | Login keeps only `accessToken` (in `localStorage`); `refreshToken` is ignored, there is no refresh, logout or 401 handling. | Users are signed out after `JWT_ACCESS_TOKEN_TTL_SECONDS` (15 min); logout does not revoke the server session. | FE: implement [auth-sessions.md](auth-sessions.md) §3 (single-flight refresh, logout). |
| T3 | Error text: login shows `body.message` only if it is a string; register passes `body.message` through (an array for DTO validation errors becomes a comma-joined English string). `403`/`429`/`503` codes are not handled. | English or generic messages for validation, Turnstile and rate-limit errors; no `Retry-After` handling. | FE: normalise `message` (string \| string[]), map `code` (`TURNSTILE_*`, `RATE_LIMITED`) to Vietnamese text. |
| T4 | Login uses `credentials: "include"`; the API uses no cookies. | Harmless (CORS allows credentials for allowlisted origins only), but the FE origin must be in `CORS_ORIGINS` on every deployed environment. | Ops: set `CORS_ORIGINS` to the exact FE origin. |
| T5 | FE `README.md` says `NEXT_PUBLIC_API_URL=http://localhost:3000/api`; the backend and the FE `.env.example` use port 8000. | Developer confusion only. | FE documentation. |
| T6 | Register sends `phone` always; the backend treats an empty phone as absent. | Compatible. | — |

Mock screens (inferred: the fixtures are not an API contract; recorded so that FE-060 does not rediscover them):

| # | Finding | Backend contract |
|---|---|---|
| T7 | Provider notification kinds `newBooking`, `bookingCancelled`, `newReview`, `profileApproved`, `bookingCompleted`, `upcomingBooking`. | Map to `BOOKING_CREATED`, `BOOKING_CANCELLED`, `REVIEW_RECEIVED`, `PROVIDER_APPROVED`, `BOOKING_COMPLETED`. **`upcomingBooking` has no backend type** (no reminder job): future scope. Deep links: use `target { type, id }`, not a `bookingId` field ([notification-inbox.md](notification-inbox.md) §3). |
| T8 | Provider profile mock has logo/cover image upload. | **No upload endpoint** exists (`PATCH /providers/me` takes text fields only): future scope. |
| T9 | Provider "customers" screen (`/dashboard/customers`). | **No customers endpoint**; must be derived from `GET /bookings/provider` or added later: future scope. |
| T10 | Admin categories screen shows service categories and counts. | `GET /admin/service-categories` and `GET /admin/pet-types` are separate resources; verify counts against the real list response before wiring. |
| T11 | Staff bookings (`/staff/bookings`) and provider bookings act on bookings. | Staff and owners share `/bookings/provider/*`; staff cannot use owner-only routes (`/services`, `/availability`, `/providers/staff`), which return 403. |

Pagination: the lists with a documented page schema (`GET /providers/public/search`, `/services/public/search`, `/availability/public/search`, `/notifications`, `/providers/me/reviews`) return `{ items, meta: { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage } }` (search adds `query`); `/bookings/mine` and `/bookings/provider` return arrays. The admin list responses are among the frozen response-schema gaps: FE-060 must take their shape from the running Swagger/QA evidence, not from the mock fixtures. No FE code consumes a list yet, so no pagination mismatch can be observed today.

## 4. Machine-readable error codes

| Code | Status | Where | FE handling |
|---|---|---|---|
| `RATE_LIMITED` | 429 | every route except health (API-wide limiter) and the auth endpoint policies | Wait `Retry-After` seconds; do not retry immediately. |
| `RATE_LIMIT_UNAVAILABLE` | 503 | every route except health (limiter store unavailable, fail-closed) | Retry after `retryAfterSeconds` (5 s). |
| `TURNSTILE_REQUIRED` | 403 | register, login, forgot-password, reset-password (`TURNSTILE_MODE=enforce`) | Show the widget, resubmit with a token. Not an auth failure: no refresh. |
| `TURNSTILE_INVALID` | 403 | same | `turnstile.reset()`, solve again. |
| `TURNSTILE_EXPIRED` | 403 | same | `turnstile.reset()`, resubmit with a new token. |
| `TURNSTILE_UNAVAILABLE` | 503 | same | Temporary; retry later. |

Every other error uses the `ErrorResponse` shape without `code` (`statusCode`, `message` string or string[], `error`); see [mvp-fe-api-contract.md](../phase2/mvp-fe-api-contract.md) §1.

## 5. Matrix by feature

Generated from the route metadata, `docs/api/openapi.json` and the test sources on 2026-11-15 (121 routes).

### F01 Registration & login

Frontend: REAL: `/register`, `/login` call these endpoints (code read; never run against this backend); none: not called (the access token is only stored in localStorage).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Log in | `POST /auth/login` | public + auth rate limit | `LoginDto` → 200 (no schema) | 400 401 403 503 · +429/503 | `qa:account-recovery` `qa:admin-audit-atomicity` `qa:auth-sessions` (+16) + matrix | BE ✅ · FE real (unverified) |
| Get current authenticated user | `GET /auth/me` | any authenticated | 200 (no schema) | 401 · +429/503 | `qa:account-recovery` `qa:admin-audit-atomicity` `qa:auth-sessions` (+3) + matrix | BE ✅ · FE none |
| Register a customer account | `POST /auth/register` | public + auth rate limit | `RegisterDto` → 201 (no schema) | 400 403 409 503 · +429/503 | `qa:account-recovery` `qa:auth-sessions` `qa:booking-events` (+5) + matrix | BE ✅ · FE real (unverified) |

### F02 Refresh token, logout, sessions

Frontend: none.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Log out of the current session | `POST /auth/logout` | any authenticated | 204 | 401 · +429/503 | `qa:account-recovery` `qa:auth-sessions` `qa:notification-preferences` (+5) + matrix | BE ✅ · FE none |
| Log out of every session | `POST /auth/logout-all` | any authenticated | 204 | 401 · +429/503 | `qa:account-recovery` `qa:auth-sessions` `qa:push-devices` (+1) + matrix | BE ✅ · FE none |
| Rotate the refresh token | `POST /auth/refresh` | public + auth rate limit | `RefreshTokenDto` → 200 (no schema) | 400 401 · +429/503 | `qa:account-recovery` `qa:auth-sessions` + matrix | BE ✅ · FE none |
| List my active sessions | `GET /auth/sessions` | any authenticated | 200 (inline schema) | 401 · +429/503 | `qa:auth-sessions` + matrix | BE ✅ · FE none |
| Revoke one of my sessions | `DELETE /auth/sessions/:id` | any authenticated | 204 | 400 401 404 · +429/503 | `qa:auth-sessions` + matrix | BE ✅ · FE none |

### F03 Account recovery & e-mail verification

Frontend: none.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Change my password | `POST /auth/change-password` | any authenticated + auth rate limit | `ChangePasswordDto` → 204 | 400 401 409 · +429/503 | `qa:account-recovery` `qa:push-devices` + matrix | BE ✅ · FE none |
| Request a password reset link | `POST /auth/forgot-password` | public + auth rate limit | `ForgotPasswordDto` → 202 `ForgotPasswordResponseDto` | 400 403 503 · +429/503 | `qa:account-recovery` `qa:bot-protection` `qa:push-devices` (+1) + matrix | BE ✅ · FE none |
| Reset the password with an e-mailed token | `POST /auth/reset-password` | public + auth rate limit | `ResetPasswordDto` → 204 | 400 403 503 · +429/503 | `qa:account-recovery` `qa:bot-protection` `qa:push-devices` (+1) + matrix | BE ✅ · FE none |
| Verify my e-mail address with an e-mailed token | `POST /auth/verify-email` | public + auth rate limit | `VerifyEmailDto` → 200 `VerifyEmailResponseDto` | 400 · +429/503 | `qa:account-recovery` + matrix | BE ✅ · FE none |
| Resend the verification e-mail | `POST /auth/verify-email/resend` | any authenticated + auth rate limit | 202 `VerificationEmailSentResponseDto` | 401 409 · +429/503 | `qa:account-recovery` + matrix | BE ✅ · FE none |

### F04 User profile

Frontend: none.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get current user profile | `GET /users/me` | any authenticated | 200 (no schema) | 401 404 · +429/503 | `qa:account-recovery` `qa:fe-smoke` + matrix | BE ✅ · FE none |
| Update current user profile | `PATCH /users/me` | any authenticated | `UpdateUserProfileDto` → 200 (no schema) | 400 401 404 · +429/503 | `qa:release-security` + matrix | BE ✅ · FE none |

### F05 Pet management

Frontend: none (customer app not built).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get active pet types | `GET /pet-types` | public | 200 (inline schema) |  · +429/503 | `qa:backup-restore` `qa:fe-smoke` + matrix | BE ✅ · FE none |
| Get my pets | `GET /pets` | CUSTOMER | 200 (no schema) | 401 403 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Create a pet profile | `POST /pets` | CUSTOMER | `CreatePetDto` → 201 (no schema) | 400 401 403 404 · +429/503 | `qa:backup-restore` `qa:booking-events` `qa:mvp-e2e` (+2) + matrix | BE ✅ · FE none |
| Deactivate one of my pets | `DELETE /pets/:id` | CUSTOMER | 204 | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE none |
| Get one of my pets | `GET /pets/:id` | CUSTOMER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE none |
| Update one of my pets | `PATCH /pets/:id` | CUSTOMER | `UpdatePetDto` → 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE none |

### F06 Provider onboarding

Frontend: none.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Register a provider profile | `POST /providers` | CUSTOMER | `CreateProviderDto` → 201 (no schema) | 400 401 403 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-consent` (+1) + matrix | BE ✅ · FE none |

### F07 Provider management

Frontend: mock: `/dashboard`; none (payment UI not built); mock: `/dashboard/profile` (profile only; no staff or working-hours screen).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get my provider dashboard | `GET /dashboard/provider` | PROVIDER_OWNER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE mock |
| Get payments for my provider | `GET /payments/provider` | PROVIDER_OWNER | 200 (no schema) | 401 403 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Get payment for one provider booking | `GET /payments/provider/booking/:id` | PROVIDER_OWNER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Create or update payment status for a completed booking | `PUT /payments/provider/booking/:id` | PROVIDER_OWNER | `UpdatePaymentDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Get my provider profile | `GET /providers/me` | PROVIDER_OWNER | 200 (no schema) | 401 403 404 · +429/503 | `qa:fe-smoke` + matrix | BE ✅ · FE mock |
| Update my provider profile | `PATCH /providers/me` | PROVIDER_OWNER | `UpdateProviderDto` → 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Get staff members for my provider | `GET /providers/staff` | PROVIDER_OWNER | 200 (no schema) | 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Add a staff member to my provider | `POST /providers/staff` | PROVIDER_OWNER | `CreateProviderStaffDto` → 201 (no schema) | 400 401 403 404 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-pipeline` + matrix | BE ✅ · FE mock |
| Deactivate one staff member for my provider | `DELETE /providers/staff/:id` | PROVIDER_OWNER | 204 | 400 401 403 404 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-pipeline` + matrix | BE ✅ · FE mock |
| Get one staff member for my provider | `GET /providers/staff/:id` | PROVIDER_OWNER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Update one staff member for my provider | `PATCH /providers/staff/:id` | PROVIDER_OWNER | `UpdateProviderStaffDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:provider-feedback` + matrix | BE ✅ · FE mock |
| Get working hours for my provider | `GET /providers/working-hours` | PROVIDER_OWNER | 200 (no schema) | 401 403 404 · +429/503 | `qa:fe-smoke` + matrix | BE ✅ · FE mock |
| Create a working-hour entry for my provider | `POST /providers/working-hours` | PROVIDER_OWNER | `CreateProviderWorkingHourDto` → 201 (no schema) | 400 401 403 404 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-consent` (+1) + matrix | BE ✅ · FE mock |
| Deactivate one working-hour entry for my provider | `DELETE /providers/working-hours/:id` | PROVIDER_OWNER | 204 | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Update one working-hour entry for my provider | `PATCH /providers/working-hours/:id` | PROVIDER_OWNER | `UpdateProviderWorkingHourDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:mvp-e2e` + matrix | BE ✅ · FE mock |

### F08 Services

Frontend: mock: `/dashboard/services`.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get active service categories | `GET /service-categories` | public | 200 (inline schema) |  · +429/503 | `qa:fe-smoke` + matrix | BE ✅ · FE mock |
| Create a service for my provider | `POST /services` | PROVIDER_OWNER | `CreateServiceDto` → 201 (no schema) | 400 401 403 404 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-consent` (+1) + matrix | BE ✅ · FE mock |
| Get all services for my provider | `GET /services/mine` | PROVIDER_OWNER | 200 (no schema) | 401 403 404 · +429/503 | `qa:fe-smoke` + matrix | BE ✅ · FE mock |
| Deactivate one service for my provider | `DELETE /services/mine/:id` | PROVIDER_OWNER | 204 | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Get one service for my provider | `GET /services/mine/:id` | PROVIDER_OWNER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Update one service for my provider | `PATCH /services/mine/:id` | PROVIDER_OWNER | `UpdateServiceDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |

### F09 Availability (provider slots)

Frontend: mock: `/dashboard/availability`.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Create an availability slot for my provider | `POST /availability` | PROVIDER_OWNER | `CreateAvailabilitySlotDto` → 201 (no schema) | 400 401 403 404 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-consent` (+1) + matrix | BE ✅ · FE mock |
| Get all availability slots for my provider | `GET /availability/mine` | PROVIDER_OWNER | 200 (no schema) | 401 403 404 · +429/503 | `qa:fe-smoke` + matrix | BE ✅ · FE mock |
| Cancel one availability slot for my provider | `DELETE /availability/mine/:id` | PROVIDER_OWNER | 204 | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Get one availability slot for my provider | `GET /availability/mine/:id` | PROVIDER_OWNER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Update one availability slot for my provider | `PATCH /availability/mine/:id` | PROVIDER_OWNER | `UpdateAvailabilitySlotDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |

### F10 Search & public catalogue

Frontend: none (customer app not built).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get publicly bookable availability slots | `GET /availability/public` | public | 200 (inline schema) |  · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE none |
| Get one publicly bookable availability slot | `GET /availability/public/:id` | public | 200 (inline schema) | 400 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Search publicly bookable availability slots | `GET /availability/public/search` | public | 200 (inline schema) | 400 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Get one publicly visible provider | `GET /providers/public/:id` | public | 200 (inline schema) | 400 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` `qa:provider-feedback` (+1) + matrix | BE ✅ · FE none |
| Search publicly visible providers | `GET /providers/public/search` | public | 200 (inline schema) | 400 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` `qa:review-moderation` + matrix | BE ✅ · FE none |
| Get public reviews for a provider | `GET /reviews/provider/:providerId` | public | 200 (no schema) | 400 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` `qa:provider-feedback` (+1) + matrix | BE ✅ · FE none |
| Get publicly available services | `GET /services/public` | public | 200 (inline schema) |  · +429/503 | `qa:release-security` + matrix | BE ✅ · FE none |
| Get one publicly available service | `GET /services/public/:id` | public | 200 (inline schema) | 400 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Search publicly available services | `GET /services/public/search` | public | 200 (inline schema) | 400 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |

### F11 Booking (customer)

Frontend: none (customer app not built).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Create a booking | `POST /bookings` | CUSTOMER | `CreateBookingDto` → 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:booking-events` `qa:booking-races` `qa:fe-smoke` (+3) + matrix | BE ✅ · FE none |
| Create a complaint for my booking | `POST /bookings/:id/complaints` | CUSTOMER | `CreateComplaintDto` → 201 (no schema) | 400 401 403 404 409 · +429/503 | `qa:mvp-e2e` `qa:review-moderation` + matrix | BE ✅ · FE none |
| Submit a review for a completed booking | `POST /bookings/:id/reviews` | CUSTOMER | `CreateReviewDto` → 201 (no schema) | 400 401 403 404 409 · +429/503 | `qa:mvp-e2e` `qa:provider-feedback` `qa:review-moderation` + matrix | BE ✅ · FE none |
| Get my booking history | `GET /bookings/mine` | CUSTOMER | 200 (inline schema) | 401 403 · +429/503 | `qa:account-recovery` `qa:backup-restore` `qa:fe-smoke` (+2) + matrix | BE ✅ · FE none |
| Get one of my bookings | `GET /bookings/mine/:id` | CUSTOMER | 200 (inline schema) | 400 401 403 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` `qa:notifications` + matrix | BE ✅ · FE none |
| Cancel one of my bookings | `POST /bookings/mine/:id/cancel` | CUSTOMER | `CancelBookingDto` → 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:booking-events` `qa:booking-races` `qa:fe-smoke` (+2) + matrix | BE ✅ · FE none |
| Get my complaints | `GET /complaints/mine` | CUSTOMER | 200 (no schema) | 401 403 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE none |
| Get one of my complaints | `GET /complaints/mine/:id` | CUSTOMER | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE none |
| Get my reviews | `GET /reviews/mine` | CUSTOMER | 200 (no schema) | 401 403 · +429/503 | `qa:fe-smoke` `qa:provider-feedback` `qa:review-moderation` + matrix | BE ✅ · FE none |

### F12 Booking status changes (provider / staff)

Frontend: mock: `/dashboard/bookings`, `/staff/bookings`.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get bookings for my provider | `GET /bookings/provider` | PROVIDER_OWNER / PROVIDER_STAFF | 200 (inline schema) | 401 403 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE mock |
| Get one booking for my provider | `GET /bookings/provider/:id` | PROVIDER_OWNER / PROVIDER_STAFF | 200 (inline schema) | 400 401 403 404 · +429/503 | `qa:fe-smoke` `qa:mvp-e2e` + matrix | BE ✅ · FE mock |
| Complete a confirmed booking | `POST /bookings/provider/:id/complete` | PROVIDER_OWNER / PROVIDER_STAFF | 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:booking-races` + matrix | BE ✅ · FE mock |
| Confirm a pending booking | `POST /bookings/provider/:id/confirm` | PROVIDER_OWNER / PROVIDER_STAFF | 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:backup-restore` `qa:booking-races` `qa:fe-smoke` (+2) + matrix | BE ✅ · FE mock |
| Mark a confirmed booking as no-show | `POST /bookings/provider/:id/no-show` | PROVIDER_OWNER / PROVIDER_STAFF | `NoShowBookingDto` → 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:booking-races` + matrix | BE ✅ · FE mock |
| Reject a pending booking | `POST /bookings/provider/:id/reject` | PROVIDER_OWNER / PROVIDER_STAFF | `RejectBookingDto` → 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:booking-races` + matrix | BE ✅ · FE mock |

### F13 Admin management & audit

Frontend: mock: `/admin`, `/admin/users`, `/admin/providers`, `/admin/categories`, `/admin/complaints`, `/admin/activity-logs`.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| List administrative activity logs | `GET /admin/activity-logs` | ADMIN | 200 (no schema) | 400 401 403 · +429/503 | `qa:observability-audit` + matrix | BE ✅ · FE mock |
| Get one administrative activity log | `GET /admin/activity-logs/:id` | ADMIN | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:observability-audit` + matrix | BE ✅ · FE mock |
| List complaints for administrative handling | `GET /admin/complaints` | ADMIN | 200 (no schema) | 400 401 403 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Get complaint administrative detail | `GET /admin/complaints/:id` | ADMIN | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Reject an in-review complaint | `PATCH /admin/complaints/:id/reject` | ADMIN | `AdminComplaintActionDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:admin-audit-atomicity` `qa:mvp-e2e` + matrix | BE ✅ · FE mock |
| Resolve an in-review complaint | `PATCH /admin/complaints/:id/resolve` | ADMIN | `AdminComplaintActionDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:admin-audit-atomicity` `qa:mvp-e2e` `qa:review-moderation` + matrix | BE ✅ · FE mock |
| Mark an open complaint as in review | `PATCH /admin/complaints/:id/review` | ADMIN | `AdminComplaintActionDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:admin-audit-atomicity` `qa:mvp-e2e` `qa:review-moderation` + matrix | BE ✅ · FE mock |
| List pet types | `GET /admin/pet-types` | ADMIN | 200 (no schema) | 400 401 403 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Create a pet type | `POST /admin/pet-types` | ADMIN | `CreateAdminPetTypeDto` → 201 (no schema) | 400 401 403 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-consent` (+1) + matrix | BE ✅ · FE mock |
| Get one pet type | `GET /admin/pet-types/:id` | ADMIN | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Update a pet type name | `PATCH /admin/pet-types/:id` | ADMIN | `UpdateAdminPetTypeDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Activate an inactive pet type | `PATCH /admin/pet-types/:id/activate` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Deactivate an active pet type | `PATCH /admin/pet-types/:id/deactivate` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| List providers for administrative review | `GET /admin/providers` | ADMIN | 200 (no schema) | 400 401 403 · +429/503 | `qa:mvp-e2e` + matrix | BE ✅ · FE mock |
| Get provider administrative detail | `GET /admin/providers/:id` | ADMIN | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Approve a pending provider | `PATCH /admin/providers/:id/approve` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:observability-audit` (+2) + matrix | BE ✅ · FE mock |
| Reactivate a suspended provider | `PATCH /admin/providers/:id/reactivate` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:mvp-e2e` + matrix | BE ✅ · FE mock |
| Reject a pending provider | `PATCH /admin/providers/:id/reject` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Suspend an approved provider | `PATCH /admin/providers/:id/suspend` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:mvp-e2e` `qa:provider-feedback` + matrix | BE ✅ · FE mock |
| List service categories | `GET /admin/service-categories` | ADMIN | 200 (no schema) | 400 401 403 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Create a service category | `POST /admin/service-categories` | ADMIN | `CreateAdminServiceCategoryDto` → 201 (no schema) | 400 401 403 409 · +429/503 | `qa:booking-events` `qa:mvp-e2e` `qa:push-consent` (+1) + matrix | BE ✅ · FE mock |
| Get one service category | `GET /admin/service-categories/:id` | ADMIN | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Update editable service category fields | `PATCH /admin/service-categories/:id` | ADMIN | `UpdateAdminServiceCategoryDto` → 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Activate an inactive service category | `PATCH /admin/service-categories/:id/activate` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Deactivate an active service category | `PATCH /admin/service-categories/:id/deactivate` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Get platform-wide record totals | `GET /admin/statistics` | ADMIN | 200 (no schema) | 401 403 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| List user accounts for administration | `GET /admin/users` | ADMIN | 200 (no schema) | 400 401 403 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Get user administrative detail | `GET /admin/users/:id` | ADMIN | 200 (no schema) | 400 401 403 404 · +429/503 | `qa:contract-smoke` + matrix | BE ✅ · FE mock |
| Reactivate a suspended user account | `PATCH /admin/users/:id/reactivate` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:account-recovery` `qa:admin-audit-atomicity` `qa:auth-sessions` (+1) + matrix | BE ✅ · FE mock |
| Suspend an active user account | `PATCH /admin/users/:id/suspend` | ADMIN | 200 (no schema) | 400 401 403 404 409 · +429/503 | `qa:account-recovery` `qa:admin-audit-atomicity` `qa:auth-sessions` (+7) + matrix | BE ✅ · FE mock |

### F14 Notification inbox

Frontend: mock: `/dashboard/notifications` (+ details).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| List my notifications | `GET /notifications` | any authenticated | 200 (inline schema) | 400 401 · +429/503 | `qa:notification-preferences` `qa:notifications` `qa:push-consent` (+3) + matrix | BE ✅ · FE mock |
| Get one of my notifications | `GET /notifications/:id` | any authenticated | 200 (inline schema) | 400 401 404 · +429/503 | `qa:notification-preferences` `qa:notifications` `qa:push-devices` + matrix | BE ✅ · FE mock |
| Mark one of my notifications as read | `PATCH /notifications/:id/read` | any authenticated | 200 (inline schema) | 400 401 404 · +429/503 | `qa:notifications` + matrix | BE ✅ · FE mock |
| Mark my notifications as read | `PATCH /notifications/read-all` | any authenticated | `MarkAllNotificationsReadDto` → 200 (inline schema) | 400 401 · +429/503 | `qa:notification-preferences` `qa:notifications` + matrix | BE ✅ · FE mock |
| Count my unread notifications | `GET /notifications/unread-count` | any authenticated | 200 (inline schema) | 401 · +429/503 | `qa:notification-preferences` `qa:notifications` `qa:push-devices` + matrix | BE ✅ · FE mock |

### F15 FCM devices

Frontend: none (no FCM SDK / service worker).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| List my active push devices | `GET /push-devices` | any authenticated | 200 (inline schema) | 401 · +429/503 | `qa:push-devices` + matrix | BE ✅ · FE none |
| Register or refresh this installation for push | `POST /push-devices` | any authenticated | `RegisterPushDeviceDto` → 200 (inline schema) | 400 401 409 · +429/503 | `qa:backup-restore` `qa:notification-preferences` `qa:push-consent` (+3) + matrix | BE ✅ · FE none |
| Revoke one of my push devices | `DELETE /push-devices/:id` | any authenticated | 204 | 400 401 404 · +429/503 | `qa:push-devices` + matrix | BE ✅ · FE none |

### F16 Notification preferences

Frontend: none.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| Get my push notification preference | `GET /notification-preferences` | any authenticated | 200 (inline schema) | 401 · +429/503 | `qa:notification-preferences` `qa:push-consent` + matrix | BE ✅ · FE none |
| Opt in or out of push notifications | `PATCH /notification-preferences` | any authenticated | `UpdateNotificationPreferencesDto` → 200 (inline schema) | 400 401 · +429/503 | `qa:backup-restore` `qa:notification-preferences` `qa:push-consent` (+2) + matrix | BE ✅ · FE none |

### F17 Provider feedback & moderation

Frontend: mock: `/admin/reviews` (admin side); provider side: none.

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| List reviews for moderation | `GET /admin/reviews` | ADMIN | 200 (inline schema) | 401 403 · +429/503 | `qa:review-moderation` + matrix | BE ✅ · FE mock |
| Get review moderation detail | `GET /admin/reviews/:id` | ADMIN | 200 (inline schema) | 400 401 403 404 · +429/503 | `qa:provider-feedback` `qa:review-moderation` + matrix | BE ✅ · FE mock |
| Hide a visible review | `PATCH /admin/reviews/:id/hide` | ADMIN | 200 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:admin-audit-atomicity` `qa:mvp-e2e` `qa:provider-feedback` (+1) + matrix | BE ✅ · FE mock |
| Restore a hidden review | `PATCH /admin/reviews/:id/restore` | ADMIN | 200 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:admin-audit-atomicity` `qa:mvp-e2e` `qa:provider-feedback` (+1) + matrix | BE ✅ · FE mock |
| List the reviews of my provider | `GET /providers/me/reviews` | PROVIDER_OWNER / PROVIDER_STAFF | 200 (inline schema) | 400 401 403 404 · +429/503 | `qa:review-moderation` + matrix | BE ✅ · FE mock |
| Respond to a review of my provider | `POST /providers/me/reviews/:reviewId/response` | PROVIDER_OWNER | `CreateReviewResponseDto` → 201 (inline schema) | 400 401 403 404 409 · +429/503 | `qa:provider-feedback` `qa:review-moderation` + matrix | BE ✅ · FE mock |

### F18 Health & diagnostics

Frontend: n/a (operations / load balancer).

| UI action (Swagger summary) | HTTP endpoint | Auth / role | Request → response | Error codes | Automated evidence | Verification status |
|---|---|---|---|---|---|---|
| API root: plain-text greeting (use /api/health/live and /api/health/ready for probes) | `GET /` | public | 200 (inline schema) |  · +429/503 | `qa:account-recovery` `qa:admin-audit-atomicity` `qa:auth-sessions` (+20) + matrix | BE ✅ · n/a |
| Liveness: the API process is running | `GET /health/live` | public | 200 (inline schema) |  | `qa:release-security` + matrix | BE ✅ · n/a |
| Readiness: database reachable and schema at this build's migration level | `GET /health/ready` | public | 200 (inline schema) | 503 | `qa:release-security` + matrix | BE ✅ · n/a |
