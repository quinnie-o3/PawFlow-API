# PawFlow — P3-BE12 Release Contract Freeze

Phase 3, P0, Backend / Documentation. Depends on P3-BE10, P3-BE11, FE-060.
Acceptance: *repeatable deploy/rollback; final Swagger/env.example; FE feature → endpoint → error → evidence map complete.*

**Verdict summary:** see §10. Local contract freeze: verified. Live staging: **not deployed**. Production readiness: **not verified**. FE-060: **not available**, so frontend integration is unverified.

| Deliverable | Location |
|---|---|
| Final OpenAPI contract (generated, 121 operations) | [docs/api/openapi.json](../api/openapi.json), usage: [docs/api/README.md](../api/README.md) |
| Frozen inventories (migrations, error codes, schema gaps) | [docs/api/release-manifest.json](../api/release-manifest.json) |
| Environment contract | §4 below, [.env.example](../../.env.example), [.env.staging.example](../../.env.staging.example) |
| Migration freeze | §5 |
| Backup / restore runbook | [p3-be12-backup-restore-runbook.md](p3-be12-backup-restore-runbook.md) |
| Deployment / rollback runbook | [p3-be12-deploy-rollback-runbook.md](p3-be12-deploy-rollback-runbook.md) (extends [p3-be11-staging-runbook.md](p3-be11-staging-runbook.md)) |
| FE → API → error → evidence matrix | [p3-be12-fe-be-traceability.md](p3-be12-fe-be-traceability.md) |
| Drift checks | `npm run contract:check` (`test/qa/release-contract.cjs`, CI `verify`), `qa:migration-cli`, `qa:backup-restore`, `qa:contract-smoke` (`qa:all`, CI `postgres-qa`) |
| Release acceptance checklist | §8 |

## 1. Freeze policy and finding classes

No feature was added and no module was redesigned. Every change is one of: a documentation-only change of the OpenAPI output, a configuration-validation fix, a documentation fix, or a new check/test. Findings are classified as **[RB]** release-blocking contract defect, **[SEC]** security/configuration defect, **[DOC]** documentation inconsistency, **[EVID]** missing validation evidence, **[IMP]** non-blocking improvement, **[FUT]** future scope. The full list is in §7.

## 2. Release inventory (from the code, not hand counts)

**Modules** (`src/app.module.ts`): Users, Pets, Providers (staff, working hours, public catalogue), Services, Availability, Bookings, Payments, Reviews (incl. BE08 provider responses and moderation), Complaints, Admin (users, providers, pet types, service categories, reviews, complaints, statistics, activity logs), Dashboard, Auth (sessions, recovery, bot protection, rate limiting), Notifications, NotificationPreferences, PushDevices, PushDelivery (outbox + worker), Health. Supporting: Mail, common (observability, security headers, OpenAPI), config (release validation).

**HTTP routes** (`test/qa/route-inventory.cjs`, Nest metadata of the compiled build): **121** in 31 controllers.

| Class | Count | Notes |
|---|---|---|
| Public | 20 | root `GET /api`, 2 health, 6 auth entry points (register, login, refresh, forgot-password, reset-password, verify-email; all rate-limited), 11 catalogue/search routes (providers, services, availability, provider reviews, pet types, service categories) |
| Any authenticated user | 19 | auth session endpoints, `/users/me`, notifications, preferences, push devices |
| Role-guarded | 82 | ADMIN 34 · PROVIDER_OWNER 33 · CUSTOMER 15 · PROVIDER_STAFF 7 (staff shares the 6 `/bookings/provider*` routes and `GET /providers/me/reviews` with owners) |

By controller group: admin 34 (incl. 4 review moderation), auth 13, providers 16 (incl. 2 public, 2 review responses), bookings 10, services 8 (+1 service categories), availability 8, pets 5 (+1 pet types), notifications 5, complaints 3, reviews 3, payments 3, push devices 3, notification preferences 2, users 2, health 2, dashboard 1, root 1 = 121. The per-route list is in the traceability matrix.

**Background work:** push delivery worker (`PUSH_WORKER_ENABLED`, default off, one per environment); rate-limit counter purge timer (every instance, idempotent); e-mail sent after the response (`BackgroundTasks`, no outbox); startup schema check (`SchemaStatusService`).

**Persistence:** 25 entities, 26 tables (+ `migrations`), 17 migrations (§5), `synchronize: false` everywhere (C7).

**Configuration:** 74 variables read by the code (§4) + `TZ` (runtime) + `GOOGLE_APPLICATION_CREDENTIALS` (read by the Firebase SDK, never set in files).

**Tests and CI before BE12:** Jest 1866 / 65 suites, `qa:all` 21 suites (924 PASS, 1 SKIP), E2E 4. CI `.github/workflows/ci.yml`: `verify` (lint, typecheck, build, Jest) and `postgres-qa` (E2E + `qa:all` on a `postgres:15` service).

## 3. Swagger / OpenAPI audit

Method: the generated document compared with the runtime route metadata, operation by operation (`contract:check` A1–A20), and runtime statuses compared with the documented ones (`qa:contract-smoke`).

| Check | Before BE12 | After BE12 |
|---|---|---|
| Runtime routes documented / extra operations | 121/121, 0 extra | 121/121, 0 extra (A3, A4) |
| Summary on every operation | 120 (root `GET /api` missing) | 121 (A5) |
| Bearer security + 401 on every `JwtAuthGuard` route; no security on public routes | ✅ | ✅ (A6–A8) |
| 403 on every role-guarded route | ✅ | ✅ (A9) |
| Request schema for every `@Body` handler (38) | ✅ | ✅ (A10) |
| Path parameters | ✅ | ✅ (A11) |
| 429 on auth rate-limited routes (8) | ✅ | ✅ (A12) |
| API-wide limiter (P3-BE11) | **undocumented** on 111 operations | 429 `RATE_LIMITED` + 503 `RATE_LIMIT_UNAVAILABLE` + `Retry-After` on all 119 limited operations (A13) |
| `X-Request-ID` response header | **undocumented** | on every response (A14) |
| Error body schema | **none** | `ErrorResponse` on every 4xx/5xx without content (A18) |
| Machine-readable error codes | partly in descriptions | all 6 documented (A19) |
| Success response schema | missing on 71 operations | missing on **68**, frozen baseline that may only shrink (A16, A17); health and root now documented |
| Observed runtime statuses ⊆ documented statuses | not checked | 52 operations, 158 requests, 0 undocumented (`qa:contract-smoke`) |
| Served document = exported document | n/a | equal (`qa:migration-cli` 4.1) |

Corrections are documentation only. `src/common/openapi/openapi-document.ts` (shared by `main.ts` and the export) adds the cross-cutting behaviour that global guards/interceptors implement and per-route decorators cannot show. `app.controller.ts` and `health.controller.ts` gained Swagger decorators. No route, status, DTO or validation rule changed.

**Remaining gap [IMP]:** 68 operations (mostly Phase 2 CRUD and admin lists) document their success status but not the body schema. Their shapes are documented in [mvp-fe-api-contract.md](../phase2/mvp-fe-api-contract.md) and the module documents, and are exercised by QA. Adding 68 response DTO classes during a freeze was judged riskier than useful. The frozen list in `release-manifest.json` makes any **new** undocumented response fail CI.

Reproducible export: `npm run build && npm run openapi:export` (no database, no secret, preview mode; details in [docs/api/README.md](../api/README.md)); `npm run openapi:check` detects drift.

## 4. Environment contract

Validation layers: (1) `loadReleaseConfig` (BE11) refuses unsafe staging/production configuration before any connection; (2) each module loader refuses its own unsafe values (Turnstile, rate limits, mail, logging, push keys, push delivery/worker); (3) `contract:check` B1–B11 keeps `.env.example`, `.env.staging.example`, `.gitignore` and the code in sync.

Legend: **R** required (startup refuses without it) · **R\*** required under a condition · **–** optional with a default · **S** secret (never commit, never log; examples contain placeholders only, B9). *Deployed* = staging and production, identical rules unless noted. *Test* = QA harness / CI (`test/qa/qa-env.cjs`).

### Runtime, HTTP and logging

| Variable | Purpose | Development | Test | Staging | Production | Req. | S |
|---|---|---|---|---|---|---|---|
| `NODE_ENV` | environment class; unknown values refused | `development` (default) | `test` | `staging` | `production` | – | |
| `PORT` | listen port | `8000` (.env.example; code default 3000) | per suite | platform | platform | – | |
| `TZ` | business time zone of slots | `Asia/Ho_Chi_Minh` | `Asia/Ho_Chi_Minh` | `Asia/Ho_Chi_Minh` | `Asia/Ho_Chi_Minh` | (runtime) | |
| `CORS_ORIGINS` | exact allowed origins | unset → `FRONTEND_URL` or localhost:3000/3001 | unset | https FE origin(s), no localhost/wildcard | same | R (deployed) | |
| `FRONTEND_URL` | legacy CORS origin outside deployed; e-mail link base fallback | `http://localhost:3000` | localhost:3000 | optional | optional | – | |
| `TRUST_PROXY` | peers allowed to set `X-Forwarded-*` | unset (none) | per suite | Cloudflare/proxy CIDRs, `loopback` or `false` | same | R (deployed) | |
| `HSTS_MAX_AGE_SECONDS` | HSTS on HTTPS requests | `0` | `0` | default 15552000 | default 15552000 | – | |
| `SWAGGER_ENABLED` | serve `/api/docs` | default `true` | `true` | default `false` | default `false` | – | |
| `LOG_FORMAT` | `json` / `text` | `json` (text allowed) | `json` | `json` (text refused) | `json` (text refused) | – | |
| `LOG_LEVEL` | log threshold | default `debug` | `debug` | default `info` | default `info` | – | |
| `HEALTH_DB_TIMEOUT_MS` | readiness probe bound (100–10000) | 2000 | 2000 | 2000 | 2000 | – | |

### Database and schema

| Variable | Purpose | Development | Test | Staging | Production | Req. | S |
|---|---|---|---|---|---|---|---|
| `DB_HOST` / `DB_PORT` | PostgreSQL address | localhost:5432 | QA server | managed host | managed host | R | |
| `DB_USERNAME` | role | `postgres` (local) | QA admin role | DML-only role; `postgres`/`root`/`admin` refused | same | R | |
| `DB_PASSWORD` | role password | local | QA | ≥ 12 chars, no placeholder | same | R | S |
| `DB_DATABASE` | database | `pet_care_db` | `pawflow_qa_*` only (harness refuses others) | dedicated (`pet_care_db` refused) | dedicated | R | |
| `DB_SSL` | `disable` / `require` / `no-verify` (app and migration CLI) | `disable` | `disable` | explicit; `disable` only for loopback | same | R (deployed) | |
| `MIGRATIONS_CHECK` | refuse start when schema ≠ build | default `off` | `off` (`enforce` in rehearsals) | default `enforce` | default `enforce` | – | |

### Authentication, sessions, account recovery, e-mail

| Variable | Purpose | Development | Test | Staging | Production | Req. | S |
|---|---|---|---|---|---|---|---|
| `JWT_SECRET` | access-token signing; fallback HMAC key | any | random per run | ≥ 32 random chars, no placeholder | same | R | S |
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | access-token lifetime | 900 | 900 | 900 | 900 | – | |
| `REFRESH_SESSION_TTL_SECONDS` | absolute session lifetime | 2592000 | 2592000 | 2592000 | 2592000 | – | |
| `PASSWORD_RESET_TOKEN_TTL_SECONDS` | reset link lifetime | 1800 | 1800 / suite | 1800 | 1800 | – | |
| `EMAIL_VERIFICATION_TOKEN_TTL_SECONDS` | verification link lifetime | 86400 | 86400 / suite | 86400 | 86400 | – | |
| `AUTH_EMAIL_COOLDOWN_SECONDS` | min. interval per account and kind | 60 | 60 / suite | 60 | 60 | – | |
| `AUTH_RECOVERY_MIN_RESPONSE_MS` | constant-time forgot-password | 250 | 250 | 250 | 250 | – | |
| `MAIL_TRANSPORT` | `disabled` / `smtp` / `file` | `disabled` (`file` allowed) | `file` in recovery suites | `disabled` or `smtp` (`file` refused) | same | – | |
| `MAIL_FROM` | sender | default | default | real sender | real sender | – | |
| `MAIL_LINK_BASE_URL` | frontend base of e-mailed links | unset → `FRONTEND_URL` | per suite | **https FE URL when `smtp`** (BE12) | same | R\* | |
| `MAIL_OUTBOX_DIR` | `file` transport directory | `./.tmp/mail-outbox` | temp dir | n/a | n/a | R\* (file) | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_REQUIRE_TLS` / `SMTP_USER` | SMTP connection | unset | unset | staging SMTP | production SMTP | R\* (smtp) | |
| `SMTP_PASSWORD` | SMTP credential | unset | unset | secret store | secret store | R\* (smtp+user) | S |

### Bot protection and rate limiting

| Variable | Purpose | Development | Test | Staging | Production | Req. | S |
|---|---|---|---|---|---|---|---|
| `TURNSTILE_MODE` | `disabled` / `enforce` | `disabled` | `disabled` (`enforce` in bot suite) | `enforce` (required) | `enforce` (required) | R (deployed) | |
| `TURNSTILE_SECRET_KEY` | Cloudflare secret; test keys refused when deployed | Cloudflare test key | stub | real widget secret | real widget secret | R\* (enforce) | S |
| `TURNSTILE_EXPECTED_HOSTNAMES` | allowed FE hostnames | `localhost` | stub | FE hostname | FE hostname | R\* (enforce) | |
| `TURNSTILE_CHECK_ACTION` | action must match endpoint | `true` | `true` | `true` (`false` refused) | `true` (`false` refused) | – | |
| `TURNSTILE_TIMEOUT_MS` | siteverify bound | 3000 | 3000 | 3000 | 3000 | – | |
| `TURNSTILE_SITEVERIFY_URL` | local stub URL (QA only) | unset | stub URL | refused | refused | – | |
| `AUTH_RATE_LIMIT` | auth endpoint policies | `enabled` | `disabled` (functional suites) | `enabled` (disabled refused) | same | – | |
| `API_RATE_LIMIT` | API-wide limits | `enabled` | `enabled`, ceilings 10000000/60 | `enabled` (disabled refused) | same | – | |
| `RATE_LIMIT_HASH_SECRET` | HMAC of counter buckets | falls back to `JWT_SECRET` | random | ≥ 32 chars, ≠ `JWT_SECRET` | same | – (recommended) | S |
| `RATE_LIMIT_<POLICY>` (14) | `<limit>/<window s>` overrides: `LOGIN_IP` 20/300, `LOGIN_EMAIL` 10/900, `REGISTER_IP` 10/3600, `FORGOT_IP` 10/900, `FORGOT_EMAIL` 5/3600, `RESET_IP` 10/900, `REFRESH_IP` 60/300, `VERIFY_IP` 20/900, `VERIFY_RESEND_USER` 5/3600, `CHANGE_PASSWORD_USER` 5/900, `API_IP` 600/60, `PUBLIC_IP` 120/60, `USER_READ` 300/60, `USER_WRITE` 60/60 | defaults | API policies raised for load | defaults (tune after load test) | defaults | – | |

### Push devices and delivery

| Variable | Purpose | Development | Test | Staging | Production | Req. | S |
|---|---|---|---|---|---|---|---|
| `PUSH_REGISTRATION_KEYS` | AES keys for device tokens (`k1:<b64>`, rotation by prepending) | derived from `JWT_SECRET` | derived / suite | random, required | random, required | R (deployed) | S |
| `PUSH_REGISTRATION_HASH_KEY` | HMAC for token de-duplication (never rotate) | derived | derived / suite | random, required | random, required | R (deployed) | S |
| `PUSH_DEVICE_STALE_DAYS` | stale device cutoff | 30 | 30 | 30 | 30 | – | |
| `PUSH_DELIVERY_MODE` | `disabled` / `mock` / `firebase` | unset → `disabled` | `mock` in push suites | explicit `disabled` or `firebase` (mock refused) | explicit | R (deployed) | |
| `STAGING_ALLOW_REAL_PUSH` | confirms real pushes on staging | n/a | n/a | `true` required with `firebase` | n/a | R\* | |
| `FIREBASE_PROJECT_ID` | per-environment Firebase project | unset | unset | R\* (firebase) | R\* (firebase) | R\* | |
| `PUSH_DELIVERY_TTL_SECONDS` | job deadline (60–2419200) | 86400 | per suite | 86400 | 86400 | – | |
| `PUSH_SEND_TIMEOUT_MS` | provider call bound | 10000 | per suite | 10000 | 10000 | – | |
| `PUSH_WORKER_ENABLED` | run the outbox worker (one instance) | `false` | per suite | `false` until approved | one instance `true` | – | |
| `PUSH_WORKER_BATCH_SIZE` / `_POLL_MS` / `_LEASE_SECONDS` / `_JOB_TIMEOUT_MS` / `_SHUTDOWN_GRACE_MS` | worker tuning | 5 / 2000 / 120 / 60000 / 10000 | per suite | defaults | defaults | – | |
| `PUSH_DELIVERY_MAX_ATTEMPTS` / `PUSH_RETRY_BASE_MS` / `PUSH_RETRY_MAX_MS` | retry policy | 8 / 30000 / 3600000 | per suite | defaults | defaults | – | |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firebase Admin SDK credentials (platform-provided, outside the repo) | unset | unset | platform (if firebase) | platform (if firebase) | – | S |

### Validation results (what is enforced, with evidence)

| Risk | Enforcement | Evidence |
|---|---|---|
| Missing required variables, placeholders | release + module loaders refuse; template refused as-is | Jest `deployment-environment.spec.ts`; `contract:check` B5–B7; `qa:release-security` startup refusals |
| Unsafe staging/production fallbacks (Turnstile off, rate limits off, test secrets, file mail, text logs, derived push keys, mock push) | refused for both staging and production (BE11 fix) | Jest regression; `qa:release-security` |
| **E-mail links falling back to `http://localhost:3000` with SMTP on (BE12)** | `MAIL_LINK_BASE_URL`/`FRONTEND_URL` must be https and non-local when `MAIL_TRANSPORT=smtp` (deployed) | Jest (+8) |
| Wrong database (`pet_care_db`), superuser, weak password, missing TLS | refused | Jest; `qa:release-security` |
| Insecure CORS / proxy trust | https exact origins only; `TRUST_PROXY` explicit, `true` refused | Jest `http-security.spec.ts`; `contract:check` B8; `qa:release-security` |
| Unintended Firebase delivery | staging requires `STAGING_ALLOW_REAL_PUSH=true`; worker off by default | Jest; `contract:check` B7 |
| Swagger exposure | off by default when deployed | `qa:release-security` |
| Secret leakage | examples hold placeholders (B9); `.gitignore` covers env files, dumps, credentials (B10); nothing tracked (B11); generated documents contain no key material or local secret (E1, E2); refusal messages name variables only | `contract:check` |
| Docs ↔ code drift | every variable read is documented, none obsolete | `contract:check` B1–B3 |

A successful local start is **not** evidence that a remote staging deployment is configured correctly. Only the deployment runbook's checks on the real environment can show that.

## 5. Migration and schema freeze

| # | Migration (name = class) | Phase | Effect |
|---|---|---|---|
| 1 | `CreateUsers1789872733739` | P1 | users |
| 2 | `CreatePetTypesAndPets1789873768008` | P1 | pet_types, pets |
| 3 | `CreateProviders1789874921794` | P1 | providers, provider_staff, provider_working_hours |
| 4 | `CreateServices1789875356682` | P1 | service_categories, services |
| 5 | `CreateAvailabilitySlots1789875959693` | P1 | availability_slots |
| 6 | `CreateBookings1789876260241` | P1 | bookings, booking_status_logs |
| 7 | `CreatePaymentsAndFeedback1789876572501` | P1 | payments, reviews, complaints |
| 8 | `CreateAdminActivityLogs1792598599145` | P2 | admin_activity_logs |
| 9 | `CreateBookingIdempotencyKeys1793624455115` | P2 | booking_idempotency_keys |
| 10 | `CreateAuthSessions1794103044835` | BE01 | auth_sessions, auth_refresh_tokens |
| 11 | `AddAccountRecovery1794690000000` | BE02 | auth_user_tokens, users.email_verified_at, revocation reasons |
| 12 | `CreateAuthRateLimits1795000000000` | BE03 | auth_rate_limits |
| 13 | `CreateNotifications1795500000000` | BE04 | notifications (+ guard trigger) |
| 14 | `CreatePushDevices1796000000000` | BE05 | push_devices (+ session revocation trigger) |
| 15 | `CreateNotificationDeliveries1796500000000` | BE06 | notification_deliveries, notification_push_sends |
| 16 | `CreateNotificationPreferences1797000000000` | BE07 | notification_preferences |
| 17 | `AddReviewResponseConstraints1797500000000` | BE08 | two CHECK constraints on reviews |

BE09, BE10, BE11 and BE12 add **no migration**. No new migration was needed: no schema defect was found.

| Check | Result | Evidence |
|---|---|---|
| Ordered, unique identities; names = `<Name><timestamp>`; up/down present | ✅ | `contract:check` C1–C5 |
| Chain = frozen manifest = startup check's expectation | ✅ | C2, C6 |
| Synchronization / implicit migrations never enabled | ✅ | C7 (app module and CLI data source) |
| Clean apply with the **official CLI** (`npm run typeorm -- migration:run -d database/data-source.ts`), in order | ✅ 17 | `qa:migration-cli` 2.1 |
| Re-run is a no-op; entities need no further DDL | ✅ | 2.3, 2.4 (also every QA suite's setup) |
| Pending status reported | ✅ `[ ]` lines; **exit code 0 even when pending**, so preflight counts lines | 1.1, 1.2, 3.2 |
| Revert exactly one migration; app refuses to start on pending schema; re-apply | ✅ | 3.1–3.5 |
| All 17 `down()` succeed and re-apply (DDL reversibility, empty schema) | ✅ | `qa:release-security` |
| CLI honours `DB_SSL` | ✅ (`require` refused by the non-TLS local server) | 5.1 |
| Restore of a populated database keeps the migration history | ✅ | `qa:backup-restore` 3.8, 4.1 |

Required privileges: migrations run as the database **owner** role, the application as a DML-only role (staging runbook §2). Preflight, execution, verification and failure handling: deploy runbook §2–§3 and §5. Reversibility per migration: deploy runbook §5.

**Development database status: UNVERIFIED.** Earlier phase reports did not confirm that migrations 16 (BE07) and 17 (BE08) were applied to `pet_care_db`. BE12 did not connect to it. Check before use: `npm run typeorm -- migration:show -d database/data-source.ts` with the development `.env`, and count the `[ ]` lines.

## 6. Backup/restore and deploy/rollback

See the two runbooks. Both are rehearsed locally and not executed on a real environment. Key decisions: restore into a new database and switch, never `--clean` the live one; revoke restored sessions; keep the push worker off after a restore; roll back without data loss only for a build change or the lossless BE08 migration; otherwise roll forward or restore with an owner decision.

## 7. Findings

| # | Class | Finding | Resolution | Evidence |
|---|---|---|---|---|
| F1 | [SEC] | Deployed + `MAIL_TRANSPORT=smtp` without `MAIL_LINK_BASE_URL`/`FRONTEND_URL` started and would e-mail `http://localhost:3000/...#token=` links (reproduced with the BE11 validator). | Validator rule (deployed + smtp only); templates document it. No behaviour change for development/test or when e-mail is disabled. | Jest +8; reproduction before/after |
| F2 | [DOC]/[SEC] | `.env.example` did not document `NODE_ENV`, `STAGING_ALLOW_REAL_PUSH`, `TURNSTILE_SITEVERIFY_URL`; several comments still said "production only" for rules that BE11 extended to staging. | Documented, comments corrected. Drift now fails CI. | `contract:check` B1/B2 |
| F3 | [SEC] | `.gitignore` covered `*.backup` only at the repository root and no `*.dump`. | `*.backup`, `*.dump`, `*.dump.sha256` ignored everywhere. | B10/B11 |
| F4 | [RB]→fixed | OpenAPI did not document the API-wide 429/503 + `Retry-After`, the `X-Request-ID` header, an error schema, the root endpoint summary or the health bodies. | Shared OpenAPI builder (documentation only). | A13–A19; Jest `openapi-document.spec.ts` |
| F5 | [DOC] | BE11 runbook advised `pg_restore --clean --if-exists` (in place); `auth-sessions.md` still listed limits resolved by BE03/BE11. | Superseded/annotated; single release procedure in the BE12 runbook. | — |
| F6 | [EVID] | 32 routes (Phase 2 CRUD: admin master data, admin users/statistics, owner profile/staff/hours/services/slots, pets, complaints) had only the auth/role matrix as automated evidence. | `qa:contract-smoke`: happy path for all 32 and error paths; every observed status checked against Swagger. | 48 checks |
| F7 | [DOC] | TypeORM `migration:show` exits 0 with pending migrations; on Windows the CLI must run from the repository drive. | Runbook preflight counts `[ ]`; test documents both. | `qa:migration-cli` 1.2 |
| F8 | [IMP] | 68 success responses without schema. | Frozen baseline (shrink-only). | A16/A17 |
| F9 | [IMP] | `PORT` defaults to 3000 in code (the Next.js dev port); every example uses 8000. | Documented; default unchanged (behaviour freeze). | — |
| F10 | [RB for FE] | Frontend login/register send no `turnstileToken`; staging/production enforce Turnstile, so login/register would be refused there. Frontend ignores refresh tokens. | Frontend work (FE-060); not a backend defect. | Traceability T1–T3 |
| F11 | [FUT] | FE mocks need an upcoming-booking reminder, provider image upload and a customers endpoint. None exists in the backend. | Future scope. | Traceability T7–T9 |

## 8. Release acceptance checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | API contract documented and internally consistent | ✅ | §3, `contract:check` A1–A20 |
| 2 | Generated OpenAPI matches routes and observed behaviour | ✅ routes/auth/roles/requests/statuses · ⚠️ 68 response bodies untyped | A3–A17, `qa:contract-smoke`, `qa:migration-cli` 4.1 |
| 3 | `.env.example` / `.env.staging.example` final and validated | ✅ | §4, B1–B11, Jest |
| 4 | Migration chain verified on isolated databases | ✅ | §5 |
| 5 | Backup and restore rehearsed on disposable databases | ✅ | backup runbook §8 |
| 6 | Deploy/rollback runbook reproducible and reviewed | ✅ written and rehearsed locally · ⬜ never executed on a real environment | deploy runbook |
| 7 | FE feature → endpoint → error → evidence map | ✅ backend side complete (121/121) · ⬜ FE integration unverified, FE-060 absent | traceability matrix |
| 8 | Local regression gates pass | see §9 | §9 |
| 9 | CI changes executed on GitHub | ⬜ not yet (runs after the owner pushes) | — |
| 10 | Live staging deployed and verified | ⬜ not done | — |
| 11 | Production readiness | ⬜ not verified | — |

## 9. Validation results (final regression, 2026-11-15, final code)

Local machine: Windows, Node 22, PostgreSQL 15.18 (server and client tools). Disposable `pawflow_qa_*` databases only. Afterwards only the preserved `pawflow_qa_push_delivery` remains, and no QA role is left. `pet_care_db` was never connected to. No Firebase, e-mail, Cloudflare or other external service was contacted.

| Gate | BE11 baseline | BE12 result |
|---|---|---|
| Typecheck (app + spec) | PASS | PASS |
| Lint (`src/ test/ scripts/`) | 1 pre-existing warning | the same single pre-existing warning (`bot-protection.cjs:189`) |
| Build | PASS | PASS |
| `openapi:check` | n/a | PASS (121 operations) |
| `contract:check` | n/a | **42/42 PASS**; mutation test: corrupting OpenAPI, an env variable, the migration list or a traceability row each fails |
| Jest | 1866 / 65 suites | **1880 / 66 suites** (+6 OpenAPI builder, +8 e-mail link rule) |
| Full-app E2E | 4 | **4/4** |
| `qa:all` | 21 suites, 924 PASS, 1 SKIP | **25/25 suites, 1056 PASS, 0 FAIL, 2 SKIP** |
| of which `release-contract` / `migration-cli` / `backup-restore` / `contract-smoke` | new | 42 / 15 / 27 (+1 SKIP) / 48 |
| Migration rehearsal | 17 | 17 via the official CLI (show/run/no-op/revert/re-run, TLS honoured) + 17 × down/up (`release-security`) |
| Backup/restore rehearsal | n/a | PASS (§8 of the backup runbook) |
| CI workflow on GitHub | n/a | **not executed** (runs after the owner pushes) |
| Live staging | NOT VERIFIED | NOT VERIFIED |

SKIPs: `bot-protection` 1 (live Cloudflare check, opt-in with `QA_ALLOW_EXTERNAL=1`, intentionally not run). `backup-restore` 2.4 (POSIX file mode cannot be checked on Windows; it runs on the Linux CI runner).

## 10. Verdict

| Status | Result |
|---|---|
| CODE_CONTRACT_FROZEN | ✅ |
| SWAGGER_VERIFIED | ✅ routes, auth, roles, request schemas, statuses, cross-cutting headers · ⚠️ 68 success-response bodies untyped (frozen, shrink-only) |
| ENVIRONMENT_CONTRACT_VERIFIED | ✅ (locally; real staging values not yet set) |
| MIGRATION_CHAIN_VERIFIED | ✅ on isolated databases · development database status UNVERIFIED |
| BACKUP_RESTORE_REHEARSED | ✅ disposable QA databases |
| DEPLOY_ROLLBACK_RUNBOOK_READY | ✅ written, reviewed, rehearsed locally · never executed on a real environment |
| FE_BE_TRACEABILITY_COMPLETE | ✅ backend side (121/121 with evidence) · ❌ FE integration unverified, FE-060 absent |
| LOCAL_QA_VERIFIED | ✅ |
| LIVE_STAGING_VERIFIED | ❌ not deployed |
| PRODUCTION_READY | ❌ |
