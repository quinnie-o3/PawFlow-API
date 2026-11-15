# PawFlow API — Deployment and Rollback Runbook (P3-BE12)

**Status:** prepared and reviewed for safety. **Not executed** on any staging or production environment. None has been provisioned. Every command below was rehearsed only against disposable local QA databases. The evidence is listed per step.

This document is the **single release procedure** for staging and production. It extends the BE11 staging runbook, [p3-be11-staging-runbook.md](p3-be11-staging-runbook.md), whose §1 (prerequisites), §2 (database roles), §4 (public HTTPS checks) and §6 (approval checklist) remain valid and are referenced here. Its §3 and §5 are superseded by §3–§6 below.
Backups and restores: [p3-be12-backup-restore-runbook.md](p3-be12-backup-restore-runbook.md). Configuration: [p3-be12-release-contract-freeze.md](p3-be12-release-contract-freeze.md) §4.

## 1. Topology assumptions (must hold before any deployment)

| Assumption | Requirement | Evidence today |
|---|---|---|
| HTTPS termination | Cloudflare (proxied hostname) terminates client TLS, with **SSL mode Full (strict)**. The origin presents a valid certificate (Cloudflare Origin CA or public CA). The API itself serves HTTP behind the proxy or tunnel. | Not verified (no environment). |
| Trusted proxy chain | `TRUST_PROXY` lists exactly the peers that connect to the API: the published Cloudflare ranges (https://www.cloudflare.com/ips/), or the address/CIDR of your own reverse proxy if one sits between Cloudflare and the API. `request.ip` is then the client, and `request.secure` reflects `X-Forwarded-Proto`. `CF-Connecting-IP` is never read. | Local only: `qa:release-security` (spoofing, trusted proxy, IPv6 /64). |
| Origin access | The origin accepts connections **only** from the trusted proxy (firewall allowlist or Cloudflare Tunnel). Otherwise a direct client can spoof `X-Forwarded-For` within the trusted ranges, or bypass Cloudflare. | Not verified. |
| Cloudflare address maintenance | Cloudflare's ranges change rarely but do change. Re-check them each release (approval checklist). Stale ranges make all clients share one rate-limit budget (symptom: legitimate 429s), or trust an address that is no longer Cloudflare. | Process only. |
| Rate-limit consistency | Counters live in PostgreSQL (`auth_rate_limits`), so limits are exact across any number of instances (local evidence: 24 concurrent requests on 2 instances → 10 × 200, 14 × 429). A Cloudflare WAF rate limit, if added, is an extra outer layer. | Local only. |
| Health checks | Load balancer / platform: liveness `GET /api/health/live`, readiness `GET /api/health/ready`. Both are exempt from rate limits and contain no secrets. | Local only. |
| Database | PostgreSQL 15, TLS (`DB_SSL=require`), dedicated database, least-privilege application role (DML only), separate migration-owner role. | Local role rehearsal (`qa:release-security`). |
| Push worker | At most **one** running worker per environment (`PUSH_WORKER_ENABLED=true` on one instance only, or on none). | Design (BE06); single-worker lease rehearsed in BE06. |

## 2. Pre-deployment checklist (gate: every line ticked and recorded)

| # | Item | How |
|---|---|---|
| P1 | Target environment confirmed | Hostname, platform project and database identity (backup runbook §1). Never `pet_care_db`. |
| P2 | Source commit | Exact SHA of the merged commit on `main` (or the release tag). The build must come from that SHA. |
| P3 | CI green on that SHA | `verify` (lint, typecheck, build, **contract:check**, Jest) and `postgres-qa` (E2E + `qa:all`, including migration and backup rehearsals). |
| P4 | Build artefact | `npm ci && npm run build` from the SHA (or the CI artefact). Record the artefact checksum. `npm run openapi:check` passes. |
| P5 | Environment validated | All variables of `.env.staging.example` set in the secret store (production uses the same rules). No placeholder left. Startup refuses violations (§3.5); `contract:check` B5–B8 prove the template is refused as-is and accepted when complete. |
| P6 | Secrets available | `JWT_SECRET`, `RATE_LIMIT_HASH_SECRET` (different), DB passwords, `TURNSTILE_SECRET_KEY` (real widget), `PUSH_REGISTRATION_KEYS` / `PUSH_REGISTRATION_HASH_KEY`. Never rotate the hash keys. Firebase via platform credentials only, if push is enabled. |
| P7 | Database identity | `SELECT current_database(), current_user, version()`. Application role cannot `CREATE TABLE` (expect `42501`). |
| P8 | Backup taken and verified | Backup runbook §4: exit 0, SHA-256, `pg_restore --list`. **No backup → no deployment.** |
| P9 | Migration state known | `npm run typeorm -- migration:show -d database/data-source.ts` (§3.3). **Count the `[ ]` lines.** TypeORM exits 0 even when migrations are pending (`qa:migration-cli` 1.2). |
| P10 | External dependencies decided | `PUSH_DELIVERY_MODE` (`disabled`, or `firebase` with `STAGING_ALLOW_REAL_PUSH=true` on staging and a per-environment Firebase project). `MAIL_TRANSPORT` (`disabled` or SMTP). Turnstile widget for the exact frontend hostname. |
| P11 | Proxy and HTTPS | §1 assumptions confirmed. `TRUST_PROXY` equals the current ranges. Origin locked down. |
| P12 | CORS | `CORS_ORIGINS` = exact https origin(s) of this environment's frontend (no wildcard, path or localhost; enforced at startup). |
| P13 | Health checks configured | Liveness and readiness paths as in §1. Readiness timeout above `HEALTH_DB_TIMEOUT_MS` (default 2 s). |
| P14 | Rollback owner and window | Who decides, which previous artefact SHA, the restore point (P8). |

## 3. Deployment sequence

1. **Stop writers (only when the release contains migrations).** Put the API in maintenance mode, or scale it to zero, and stop the push worker. A release without migrations (BE09–BE12 add none) can be rolled instance by instance instead (§3.6).
2. **Final backup** (P8), after writers stop: this is the restore point.
3. **Migrations**, run by an operator with the **migration-owner** role. The application never runs migrations itself (`synchronize: false`, no `migrationsRun`; `contract:check` C7):
   ```bash
   export DB_HOST=<host> DB_PORT=5432 DB_DATABASE=<db> DB_USERNAME=<owner-role> DB_SSL=require
   read -rs DB_PASSWORD && export DB_PASSWORD           # never on the command line
   npm run typeorm -- migration:show -d database/data-source.ts   # review: N "[ ]" lines
   npm run typeorm -- migration:run  -d database/data-source.ts   # one transaction for the whole run (default)
   npm run typeorm -- migration:show -d database/data-source.ts   # expect 17 "[X]", 0 "[ ]"
   ```
   `database/data-source.ts` reads the same `DB_*` / `DB_SSL` variables as the application. `dotenv` never overrides exported variables. Run the command from the release checkout, never from a directory whose `.env` points elsewhere. On Windows, run it from the repository's drive: the TypeORM CLI resolves globs against the working directory's drive. Rehearsed by `qa:migration-cli`: show/run/no-op/revert/re-run with the official command, plus `DB_SSL=require` honoured.
4. **Re-apply grants** to the application role if the release added tables (staging runbook §2; default privileges cover new tables created by the owner role).
5. **Start one instance** (`node dist/main.js`, `NODE_ENV=staging|production`, `MIGRATIONS_CHECK=enforce`, `PUSH_WORKER_ENABLED=false` at first). Startup refuses, with exit code 1 and a JSON line `app.startup_refused` that names variables only, when:
   - the configuration violates a rule (BE11 validator);
   - the schema is not at this build's level ("N pending", rehearsed `qa:migration-cli` 3.3; "not in this build" for a database ahead of the build).
6. **Readiness gate.** `GET /api/health/ready` must return `200 {"status":"ready","checks":{"database":"up","schema":"current"}}` before the instance gets traffic. Then add further instances one by one, each gated the same way. For a release without migrations, replace old instances one at a time (old and new builds share the schema).
7. **Smoke tests** (§4) with real HTTP through the public hostname.
8. **Background jobs.** The rate-limit cleanup timer runs in every instance (harmless, idempotent). Enable the push worker on exactly one instance (`PUSH_WORKER_ENABLED=true`, push mode not `disabled`) only after the smoke tests, and only if push delivery was approved (P10). E-mail has no worker (sent during the request, after the response).
9. **Open traffic / end maintenance.** Record the SHA, the artefact checksum, the backup name and the smoke results in the release log.

Safe failure: any failed gate in steps 3–7 → stop and go to §5 (case B if traffic has not been accepted yet).

## 4. Post-deployment smoke sequence

Use test accounts created for the environment, never real users' data. Push stays disabled unless P10 approved it.

| # | Check | Expected |
|---|---|---|
| S1 | `GET /api/health/live`, `GET /api/health/ready` | 200 / 200 `schema: current` |
| S2 | Security headers on any response | `x-content-type-options: nosniff`, `x-frame-options: DENY`, CSP `default-src 'none'`, `strict-transport-security` (HTTPS), `x-request-id`, no `x-powered-by` |
| S3 | Request correlation | Send `X-Request-ID: smoke-<date>-01`; the same value comes back and appears in the JSON log line `http.request.completed` |
| S4 | CORS | Allowed origin → `access-control-allow-origin` = that origin; foreign origin → no CORS headers (staging runbook §4 #4–#5) |
| S5 | Authentication | Register/login **from the real frontend** (Turnstile enforced): 200 with tokens; `GET /api/auth/me` 200; `POST /api/auth/refresh` rotates; `POST /api/auth/logout` 204; the old access token then gets 401 |
| S6 | Authorization | Customer token on `GET /api/admin/statistics` → 403; no token → 401 |
| S7 | Booking | Test provider (approved by the test admin) publishes a slot; test customer books with an `Idempotency-Key` (201); replay returns the same booking with `Idempotent-Replayed: true`; provider confirms (201) |
| S8 | Admin audit | The admin approval of S7 appears in `GET /api/admin/activity-logs` with `metadata.requestId` |
| S9 | Notification inbox | The customer sees `BOOKING_CONFIRMED` in `GET /api/notifications`, and `unread-count` decreases after `read` |
| S10 | Push | With `PUSH_DELIVERY_MODE=disabled`: no rows are delivered (inbox only). With `firebase` (approved): one test device receives exactly one push |
| S11 | Rate limiting | Staging runbook §4 #7–#8: 121st public request in 60 s → 429 + `Retry-After`; two client networks have independent budgets |
| S12 | Swagger | `GET /api/docs` → 404 unless `SWAGGER_ENABLED=true` was approved |

Not verified until executed on a real environment: S1–S12 have only been run locally (`qa:all`, `qa:release-security`, `qa:contract-smoke`).

## 5. Rollback

First decide which case applies. Never "revert all migrations" on a database that holds real data. A `down()` drops the tables and columns its `up()` created, together with their data.

### Case A — application-only rollback (schema unchanged)

When the release added no migration (true for BE09, BE10, BE11 and BE12), or the previous build is compatible with the current schema level:

1. Redeploy the previous artefact (SHA from P14), instance by instance.
2. The startup check confirms compatibility. A previous build refuses to start with "not in this build" if the database is **ahead** of it. That means the release did add migrations: use case B or C.
3. Readiness gate and smoke S1–S6.

### Case B — migration failure before accepting traffic

Writers are stopped (§3.1) and no user write happened after the backup:

1. `migration:run` executes all pending migrations of one run in a single transaction (TypeORM CLI default `--transaction all`; `database/data-source.ts` does not override it; PostgreSQL DDL is transactional, and no PawFlow migration disables transactions or uses `CONCURRENTLY`). A failing migration should therefore roll back the whole run. That failure path was **not** rehearsed with a deliberately failing migration. Always check with `migration:show` and compare against the pre-deployment state (P9).
2. If the database is unchanged: fix the cause, or abort the release and keep the previous build running (case A).
3. If a partial or unexpected state remains: **restore the P8 backup into a new database** and switch to it (backup runbook §5). This is lossless because nothing was written after the backup.
4. Use `migration:revert` only for a migration verified as lossless (table below), after a fresh backup. Each call reverts exactly one migration (rehearsed: `qa:migration-cli` 3.1).

### Case C — incompatibility discovered after accepting writes

Users have written data under the new schema/build. Options, in order of preference:

1. **Roll forward:** a hotfix build on the same schema. No data is lost.
2. **Previous build on the new schema:** possible only if the release's migrations are additive and the old build tolerates them. The startup check refuses this (database "ahead"). Deliberately overriding it with `MIGRATIONS_CHECK=off` requires an explicit owner decision and a compatibility review of the migrations involved.
3. **Restore the pre-release backup:** loses every write since the backup. Requires the post-restore steps of the backup runbook §6 (revoke sessions, keep the push worker off, reconcile business events). Owner decision only.
4. **`migration:revert`:** only for the lossless migrations below. Never for the others once real data exists.

### Reversibility of the frozen chain

| Migration(s) | `down()` effect | Revert with data? |
|---|---|---|
| `AddReviewResponseConstraints1797500000000` (BE08) | drops two CHECK constraints | **Lossless**: safe, after a backup |
| `CreateNotificationPreferences1797000000000` (BE07) | drops `notification_preferences` | Loses every user's preferences |
| `CreateNotificationDeliveries1796500000000` (BE06) | drops the outbox and the push send log | Loses delivery history and pending jobs |
| `CreatePushDevices1796000000000` (BE05) | drops `push_devices` + triggers | Every device must re-register |
| `CreateNotifications1795500000000` (BE04) | drops the inbox | Loses every notification |
| `CreateAuthRateLimits1795000000000` (BE03) | drops counters | Lossless in practice (counters only), but the application needs the table |
| `AddAccountRecovery1794690000000` (BE02) | drops reset/verification tokens and `users.email_verified_at`; rewrites `PASSWORD_*` revocation reasons to `LOGOUT_ALL` | Loses verification state: avoid |
| `CreateAuthSessions1794103044835` and earlier (core data) | drop sessions, bookings, users… | **Never** with real data |

All 17 `down()` methods do succeed on a schema that holds no data (`qa:release-security`: 17 × down, re-up). That proves reversibility of the DDL only, not that reverting with data is harmless.

### What cannot be automated

- Choosing between case A, B and C (owner).
- Reconciling writes lost by a restore, and deciding whether restored outbox jobs may still be delivered.
- Cloudflare, DNS, certificates and firewall changes (outside this repository; never changed by BE12).

## 6. Status of this runbook

| Gate | Status |
|---|---|
| Procedure written, reviewed against the code | ✅ |
| Commands rehearsed on disposable local databases (`qa:migration-cli`, `qa:backup-restore`, `qa:release-security`) | ✅ (results: freeze document §9) |
| Executed on a real staging environment | ⬜ not done: no environment provisioned, no authorization |
| Executed on production | ⬜ not done |
