# P3-BE10 — Automated API QA

**Acceptance criterion:** *"Automated positive/negative API suites cover core roles, conflicts, concurrency and audit atomicity."*

**Subtask:** integration/E2E tests for auth, RBAC, booking, audit rollback and notification.

BE10 extends the existing QA framework; it does not replace it.

- It adds three PostgreSQL QA suites, one real full-application Jest E2E suite, a run-all runner with machine-counted results, and a CI workflow.
- It fixes two harness defects.
- It aligns one existing suite with the "no external calls" policy.
- No production code changed, no migration was added, and `pet_care_db` was never connected to.

## 1. Existing QA inventory

| Layer | What it proves | Where |
|---|---|---|
| Unit (mocked repositories/services) | Business rules, DTO validation, guards in isolation | 61 Jest suites (`src/**/*.spec.ts`) |
| HTTP contract (Nest app, real guards/pipes, mocked services) | Status codes, JWT strategy, Swagger shape, BE09 headers and logs | `bookings.*.http.spec.ts`, `http-observability.spec.ts` and others |
| Real PostgreSQL + real HTTP, 2 app instances | End-to-end behaviour on the migrated schema | 17 suites in `test/qa/*.cjs` |
| Concurrency / races | Locks, idempotency, lease fencing | Sections in `mvp-e2e` (D), `auth-sessions` (7), `account-recovery` (7), `notifications` (5), `push-devices` (7), `push-outbox` (2), `booking-events` (C), `review-moderation` (4, barriers), `provider-feedback` (3, barriers), `observability-audit` (3) |
| Failure injection (QA-only triggers) | Transaction atomicity | `auth-sessions` (8), `account-recovery` (8), `observability-audit` (4), `push-worker` (6, DB outage), `push-dispatch` (3, SIGKILL) |
| Scale | 150,000 notifications | `notifications` (8) |
| Full-application Jest E2E | — | `test/app.e2e-spec.ts` was the unmodified Nest scaffold (see defect H1) |
| CI | — | none |

**BE08/BE09 QA counts.** BE08 reported 719 checks for 16 suites. That is the exact sum of its per-suite table. The BE09 report said "707 checks for 17 suites", which was an **arithmetic error in the report**. The BE09 run actually logged 718 for the same 16 suites (`push-worker` 32 before the startup-error fix, then 33/33 when re-run) plus 25 for `observability-audit`, so **744** after the fix. No coverage was lost. BE10 removes hand arithmetic: `test/qa/run-all.cjs` counts `PASS`/`FAIL`/`SKIP` lines and writes `summary.json`.

## 2. Coverage matrix

Legend: ✅ existing evidence at the right level · 🆕 added by BE10 · Priority is for the gap, if there is one.

| Domain | Scenario | Existing evidence | Missing evidence (before BE10) | BE10 test | Priority |
|---|---|---|---|---|---|
| Auth | Login ok / wrong password / unknown account / malformed / missing | ✅ `auth-sessions` 1, `bot-protection` 1, Jest `auth.*.spec` | — | — | — |
| Auth | Expired, forged, unknown-session, other-user-session, logged-out, suspended tokens | ✅ partially (`auth-sessions` 5–6, `mvp-e2e` F: 7 routes) | Not checked on **every** guarded route | 🆕 `api-security-matrix` §2: 101 routes × 8 credentials | P0 |
| Auth | Refresh rotation, reuse detection, logout, logout-all, session list, account switch, concurrent refresh | ✅ `auth-sessions` 2–4, 7 | No full-stack Jest E2E | 🆕 `app.e2e-spec.ts` (register → login → me → rotate → reuse → logout) | P1 |
| Auth | Revoke own vs foreign session | ✅ `auth-sessions` 3 | — | 🆕 `api-security-matrix` §8 (cross-user 404) | P2 |
| Recovery | Forgot (anti-enumeration), reset, expiry, reuse, session revocation, e-mail verification | ✅ `account-recovery` 3–9 (incl. races and triggers) | — | — | — |
| Bot protection | Valid / missing / invalid / expired / timeout / provider error / fail-closed / 429 | ✅ `bot-protection` 1–5 (local Siteverify stub) | Section 6 called the real Cloudflare endpoint by default | Made opt-in (`QA_ALLOW_EXTERNAL=1`), reported as SKIP | P1 |
| RBAC | Unauthenticated → 401 on protected routes | ✅ 7 hand-picked routes (`mvp-e2e` F) | 94 routes unchecked; no guard on a new route would go unnoticed | 🆕 `api-security-matrix` §0 (public allowlist from metadata), §2 | **P0** |
| RBAC | Wrong role → 403 | ✅ some routes per suite | Not systematic | 🆕 §3: 82 role routes × every forbidden role (239 requests) | **P0** |
| RBAC | Role claim tampering (signed token, wrong role) | — | Missing | 🆕 §3: 403 on all 34 ADMIN routes | P0 |
| RBAC | Rejected requests change nothing | ✅ `mvp-e2e` F (selected tables) | Not byte-level | 🆕 §2, §3, §5, §6: md5 of every table before and after | P0 |
| RBAC | DTO privilege escalation (role, status, owner, customer, approval, rating) | ✅ strict DTOs in Jest | No HTTP + DB proof with positive controls | 🆕 §5: 9 injections → 400 + controls → 2xx | P0 |
| RBAC | IDOR with valid foreign ids | ✅ `mvp-e2e` A/B, `notifications` 3, `push-devices` 2 | Slots, services, staff links, working hours, payments, complaints, pets | 🆕 §6: 22 attempts (8 resource types, valid bodies) → 404 (C-01 policy), DB unchanged, owners' positive controls 200 | P0 |
| RBAC | Swagger documents every route | ✅ booking schemas only (`mvp-e2e` F) | Not global | 🆕 §1: 119 routes = 119 operations | P2 |
| Errors | 400 / 401 / 403 / 404 / 409 / 500 contract, no stack or SQL, `X-Request-ID` | ✅ `observability-audit`, Jest HTTP specs | Not global | 🆕 §4, §7: about 1,560 responses checked | P0 |
| Booking | Create → confirm → complete / no-show / cancel / reject; capacity; logs | ✅ `mvp-e2e` A–C | — | — | — |
| Booking | Idempotency-Key (double click, lost response, restart, payload change) | ✅ `mvp-e2e` D1–D5 | Concurrent same-key burst across instances | 🆕 `booking-races` B3 | P1 |
| Booking | Capacity race | ✅ `mvp-e2e` D6 (12 on capacity 5) | Distinct customers on the last seat | 🆕 B2 (8 customers, capacity 1) | P1 |
| Booking | Concurrent transitions on one booking (confirm × confirm, cancel vs confirm both orders, reject vs cancel, complete vs no-show, cancel vs complete) | ✅ only 6× cancel (`mvp-e2e` C), confirm vs suspend (D7) | **Missing** | 🆕 R1–R6 (row-lock barrier, forced order), B1 (unordered bursts) | **P0** |
| Booking | Mutation after terminal state, invalid transitions, inactive staff, ineligible slot/service/pet | ✅ partially (`mvp-e2e` C) | Several cases | 🆕 T1–T4 | P1 |
| Booking | Notifications per transition, no duplicates | ✅ `booking-events` A–D | Under races | 🆕 R1–R6 and B1 (event keys) | P1 |
| Audit | Success / actor / requestId / pagination / filters | ✅ `observability-audit` 2, 5; `review-moderation` 2 | — | — | — |
| Audit | Rollback when the audit insert fails | ✅ one action (`PROVIDER_APPROVED`) | **18 of 19 actions** | 🆕 `admin-audit-atomicity`: all 19 | **P0** |
| Audit | Duplicate / conflicting requests → one row | ✅ provider approve, review hide | 17 actions | 🆕 all 19 (repeat + 6-way race on 2 instances) | P0 |
| Audit | Suspension rollback keeps sessions | — | Missing | 🆕 `USER_SUSPENDED` step b (token still 200) | P0 |
| Notification | Inbox, unread, read-all, pagination, isolation, deep links | ✅ `notifications` 1–9 | — | — | — |
| Notification | Device lifecycle, rotation, revocation, logout cleanup, account switch, invalid tokens | ✅ `push-devices` 0–9 | — | — | — |
| Notification | Preferences, default off, consent recheck, fail-closed | ✅ `notification-preferences`, `push-consent` | — | — | — |
| Notification | Outbox atomicity, duplicates, retry, terminal, crash, lease fencing, two workers, mock FCM outcomes | ✅ `push-outbox`, `push-worker`, `push-dispatch`, `push-pipeline` | — | — | — |
| Infra | Run all suites, unique DB per run, machine counts | — | Missing | 🆕 `run-all.cjs` (`npm run qa:all`, `qa:be10`) | P1 |
| Infra | Full AppModule boot on real PostgreSQL in Jest | ✗ scaffold pointed at `pet_care_db` | Missing | 🆕 `test:e2e` (disposable DB, isolation guard) | P1 |
| Infra | CI | — | Missing | 🆕 `.github/workflows/ci.yml` | P1 |
| Rate limiting (429) | Login / register / forgot | ✅ `bot-protection` 5 | Other endpoints have no rate limit | Out of scope (P3-BE11) | — |

## 3. New suites

| Suite | Checks | Highlights |
|---|---|---|
| `test/qa/api-security-matrix.cjs` | 32 | Routes read from `dist` controller metadata (`route-inventory.cjs`), so new routes are covered automatically. Includes: reviewed public allowlist (18); 101 guarded routes × 8 bad credentials; 82 role routes × forbidden roles; tampered role claim; malformed and missing ids never 5xx; DTO injection with positive controls; IDOR; Swagger completeness; byte-level table fingerprints around every rejected sweep; global response contract. |
| `test/qa/admin-audit-atomicity.cjs` | 101 | All 19 `ADMIN_ACTIVITY_ACTIONS`, each through 403/401 → injected audit failure (rollback) → success (actor, target, `requestId`) → repeat (409, or 200 no-op) → 6-way race on 2 instances. Global: 38 rows exactly, all ADMIN actors, no trigger left behind. |
| `test/qa/booking-races.cjs` | 15 | Six ordered races with a row-lock barrier; unordered bursts (5 actions × 6 rounds); last-seat race (8 customers); concurrent same Idempotency-Key; transition matrix and eligibility; global invariants (capacity, log chain, no duplicate status or notification, 0 deadlocks). |
| `test/app.e2e-spec.ts` (`npm run test:e2e`) | 4 | Real `AppModule` on a disposable migrated database. Includes an isolation guard (`current_database()`), API root plus `X-Request-ID`, the full auth/session journey, and the 401 contract. |

## 4. Environment and database isolation

- **QA databases** are named `pawflow_qa_*` only. `qa-env.cjs` refuses any other name or the `.env` `DB_DATABASE`, and verifies `current_database()` before writing.
- **Per-run names.** `run-all.cjs` gives each suite `pawflow_qa_<suite>_<runId>`, and the Jest E2E uses `pawflow_qa_e2e_<id>`. Each suite drops only its own database; `QA_KEEP_DB=1` keeps it for diagnosis. Pre-existing databases (for example `pawflow_qa_push_delivery`) are never touched.
- **App instances** start from an empty temporary directory with explicit environment variables, so the repository `.env` cannot redirect them.
- **No Firebase credentials.** Push suites use `mock` / `disabled` modes and fake providers. Bot protection uses a local Siteverify stub. External calls happen only with `QA_ALLOW_EXTERNAL=1`.
- **Environment variables:**
  - `QA_DB_HOST`, `QA_DB_PORT`, `QA_DB_USERNAME`, `QA_DB_PASSWORD` (defaults: the `.env` connection values; its database name is never used)
  - `QA_OUT_DIR`
  - `QA_KEEP_DB`
  - `QA_SUITE_TIMEOUT_MS`

## 5. Concurrency methodology

- **Ordered races.** A side connection holds `SELECT … FOR UPDATE` on the booking. Request A is sent and observed waiting in `pg_stat_activity` (`wait_event_type = 'Lock'`), then B is sent and observed waiting, then the barrier commits. Every booking transition locks the booking row first, and waiters are served in arrival order, so the order is forced rather than timed. Each barrier step has a 15 s deadline.
- **Unordered bursts and races.** Only scheduling-independent outcome sets are asserted: exactly one success, the rest 409, one row. Database invariants are always checked.
- **Parallelism is bounded and documented:** 5–8 concurrent requests per scenario, spread over 2 API instances.

## 6. Audit rollback methodology

- A QA-only PL/pgSQL trigger (`qa_fail_audit_<run>`) is created on `admin_activity_logs` for one action at a time. It raises inside the admin transaction **after** the business write, and is dropped in a `finally` block.
- **Assertions after the fault:**
  - HTTP 500 with the generic body
  - unchanged business row (including provider ratings and live sessions)
  - unchanged audit row count
- A global check confirms that no trigger remains.

## 7. Commands

| Layer | Command |
|---|---|
| Typecheck / lint / build | `npm run typecheck` · `npm run lint` · `npm run build` |
| Unit and HTTP contract (no database) | `npm test` |
| Full-application E2E (disposable database) | `npm run build && npm run test:e2e` |
| One QA suite | `npm run build && npm run qa:booking-races` (or `qa:api-security-matrix`, `qa:admin-audit-atomicity`, …) |
| BE10 suites | `npm run qa:be10` |
| Every QA suite | `npm run qa:all` (about 25 minutes) → `summary.json` |
| CI | `.github/workflows/ci.yml`: `verify` (lint, typecheck, build, Jest) and `postgres-qa` (E2E + `qa:all` on a `postgres:15` service container) |

**Interpreting results.** A suite is OK when it exits 0, has at least one `PASS` and no `FAIL`. `FAIL` lines carry the observed values. `SKIP` lines state why a check did not run; currently only the opt-in Cloudflare protocol check skips. Logs and evidence go to `QA_OUT_DIR/<suite>/`.

## 8. Results

Final run on 2026-11-15, branch `feature/automated-api-qa` at `4de1838` plus the BE10 working-tree changes, on local PostgreSQL 15.

| Gate | Previous baseline (BE09) | Final result | Verdict |
|---|---|---|---|
| Typecheck (`tsc -p tsconfig.json` and `tsconfig.spec.json`) | PASS | exit 0 / exit 0 | PASS |
| Lint (`oxlint src/ test/`) | PASS, 1 pre-existing warning | 0 errors, the same 1 pre-existing warning (`bot-protection.cjs:189`, untouched line) | PASS |
| Build | PASS | exit 0 | PASS |
| Jest (unit + HTTP contract) | 1756 / 61 suites | **1756/1756, 61/61 suites** (BE10 adds no unit tests) | PASS |
| Full-application Jest E2E (`test:e2e`) | broken scaffold | **4/4** | PASS |
| PostgreSQL QA, existing 17 suites | 17 suites, 744 checks (reported as 707) | **17/17 OK, 742 PASS + 1 SKIP**: `bot-protection` §6 (2 checks) is now opt-in, so 744 − 2 = 742 | PASS |
| New BE10 QA suites | N/A | **3/3 OK, 148 PASS** (32 + 101 + 15). Re-run twice more: 148/148 each time | PASS |
| **QA total** (`npm run qa:all`) | | **20/20 suites OK, 890 PASS, 0 FAIL, 1 SKIP** | PASS |
| Concurrency | existing sections | Plus: R1–R6 ordered races, B1 30 bursts, B2 last-seat race, B3 idempotency burst, 19 × 6-way admin races | PASS |
| Atomicity / rollback | 1 audited action + auth/recovery triggers | Plus: all 19 audited actions under injected audit failure | PASS |
| Security negative tests | 7-route sample | 101 × 8 (401) + 239 (403) + 34 tampered-claim + 421 allowed-role + 9 injection + 22 IDOR requests, every table fingerprinted | PASS |

**Databases.** Run-owned databases were created and dropped by the runner (`pawflow_qa_<suite>_mwhg…`) and by the E2E suite (`pawflow_qa_e2e_…`). Four E2E databases left by failed development attempts in this session were dropped by name. Afterwards the only QA database left is the pre-existing `pawflow_qa_push_delivery`, untouched. `pet_care_db` was never connected to.

Evidence: `QA_OUT_DIR` of the run (`summary.json`, `<suite>.log`, application logs).

## 9. Verified defects

| Id | Kind | Finding | Fix |
|---|---|---|---|
| H1 | Test harness and safety | `npm run test:e2e` ran the generated Nest scaffold. It imported `AppModule` with the repository `.env` (connecting to `pet_care_db`), expected a non-existent `GET /` "Hello World!", and its Jest config lacked the ESM transform, so it could not have passed. | Replaced by a real E2E on a disposable database, with global setup and teardown and an isolation guard. Config: `test/jest-e2e.config.cjs`. |
| H2 | Test harness | Default QA made a real network call to `challenges.cloudflare.com` (`bot-protection` §6, Cloudflare's public test secrets). | Opt-in with `QA_ALLOW_EXTERNAL=1`; reported as SKIP otherwise. |
| R1 | Report error | BE09 report stated 707 QA checks; the correct total was 744. | Machine counting in `run-all.cjs`. |

No application defect was found. Every BE10 failure seen during development was a harness issue:
- the tampered-claim token was a valid credential and was sent to `logout-all`;
- working hours were missing from the seed;
- `jsonb` key order;
- a capacity fixture was set by hand;
- Jest's loader with TypeORM globs on Windows.

Each was fixed in the test, never by weakening an assertion or changing production code.

## 10. Remaining risks

- The CI workflow was written but **has not run on GitHub yet**. Its first run will validate it; no repository setting was changed.
- Resource-level (IDOR) evidence covers bookings, pets, slots, services, staff links, working hours, payments, complaints (`api-security-matrix` §6), sessions (§8), notifications, devices and reviews (existing suites). Review responses across providers rely on `provider-feedback` §1–2.
- 429 exists only for authentication endpoints. Wider rate limiting is P3-BE11 scope.
- Passing BE10 is not a production-readiness claim. Security headers, proxy and Cloudflare configuration, and staging are P3-BE11.

## 11. Verdict

**P3-BE10 acceptance: MET.** Automated positive and negative API suites now cover:
- the four roles, with route-level and resource-level checks;
- conflicts (409 paths on every audited action and on booking transitions);
- concurrency (ordered and unordered races on two instances);
- audit atomicity (all 19 actions under fault injection).

Every check is asserted on both HTTP and PostgreSQL, and all gates pass.

This verdict is for BE10 only; it is not a production-readiness statement (see §10).
