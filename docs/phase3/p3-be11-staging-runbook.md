# PawFlow API — Staging Deployment Runbook (P3-BE11)

**Status of this document:** prepared, **not executed**. Each stage below has a gate; nothing past "Local tests passed" has been done.

| Stage | Meaning | Status |
|---|---|---|
| Code ready | BE11 controls implemented and reviewed | ✅ (pending owner review / merge) |
| Configuration ready | `.env.staging.example` complete; validator enforces it | ✅ |
| Local tests passed | Jest, E2E, `qa:all` incl. `release-security` | ✅ (see p3-be11-release-security-staging.md §11) |
| Cloud resources provisioned | staging DB, compute, Cloudflare zone, secrets | ⬜ **not done** (needs authorization) |
| Live staging deployed | API running on staging infrastructure | ⬜ **not done** |
| Public HTTPS verified | checks of §4 against the public hostname | ⬜ **not done** |

## 1. Prerequisites (owner decisions)

1. Staging hostnames, for example `api-staging.<domain>` (API) and `staging.<domain>` (frontend).
2. Hosting for one or more API instances, and a managed PostgreSQL 15+ with TLS.
3. Cloudflare zone, with the API hostname proxied (orange cloud).
4. Secret store for the variables of `.env.staging.example`.
5. Turnstile widget for the staging frontend hostname (real secret, not a test key).

## 2. Database preparation (once)

Run as the database **owner** role (never the application role):

```sql
CREATE DATABASE pawflow_staging;
CREATE ROLE pawflow_staging_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
\c pawflow_staging
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE pawflow_staging TO pawflow_staging_app;
GRANT USAGE ON SCHEMA public TO pawflow_staging_app;
-- after migrations (step 3), and again after every release that adds tables:
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pawflow_staging_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pawflow_staging_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pawflow_staging_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pawflow_staging_app;
```

The privilege model was rehearsed locally by `qa:release-security` §2. The application role cannot create or drop tables.

## 3. Release procedure

> **Superseded by P3-BE12:** the authoritative release procedure (pre-deployment gates, migration policy, readiness, smoke tests, worker start) is [p3-be12-deploy-rollback-runbook.md](p3-be12-deploy-rollback-runbook.md) §2–§4. The steps below are kept as the BE11 record; where they differ, BE12 applies.

1. **Backup** (restore point): `pg_dump -Fc -d pawflow_staging -f pre-<release>.dump` (and on managed platforms, a snapshot). Record its checksum.
2. **Build:** `npm ci && npm run build` (CI artefact of the merged commit).
3. **Migrate** with the owner role, using the project's official command (the one used in the BE07/BE08 rehearsals). `dotenv/config` never overrides exported variables:
   ```
   export DB_HOST=<staging-db-host> DB_PORT=5432 DB_DATABASE=pawflow_staging DB_USERNAME=<owner-role> DB_PASSWORD=<owner-password>
   npm run typeorm -- migration:show -d database/data-source.ts   # review pending migrations
   npm run typeorm -- migration:run  -d database/data-source.ts
   ```
   Expected: 17 `[X]`, 0 `[ ]`. Export `DB_SSL=require` (or `no-verify`) for a TLS-only database: `database/data-source.ts` reads the same `DB_SSL` contract as the application (BE11).
4. **Configure** the runtime with the application role (`.env.staging.example` values), `NODE_ENV=staging`, `MIGRATIONS_CHECK=enforce`.
5. **Start** one instance, `node dist/main.js`. Startup refuses (exit code 1, JSON line `app.startup_refused` naming the variables) if any rule is violated or the schema is not at this build's level.
6. **Readiness:** `GET /api/health/ready` returns 200 `{"status":"ready","checks":{"database":"up","schema":"current"}}`, then add the instance to the load balancer.

## 4. Verification on the public hostname (gate "Public HTTPS verified")

| # | Check | Expected |
|---|---|---|
| 1 | `curl -sI https://api-staging.<domain>/api/health/live` | 200, `strict-transport-security`, `x-content-type-options: nosniff`, `x-request-id`, no `x-powered-by` |
| 2 | `curl -sI http://api-staging.<domain>/api/health/live` | redirected to https by Cloudflare (edge), not by the API |
| 3 | `curl -s https://api-staging.<domain>/api/health/ready` | `{"status":"ready",…}` |
| 4 | `curl -sI -H 'Origin: https://staging.<domain>' …/api/health/live` | `access-control-allow-origin: https://staging.<domain>` |
| 5 | `curl -sI -H 'Origin: https://evil.example' …/api/health/live` | no `access-control-allow-origin` |
| 6 | `curl -s https://api-staging.<domain>/api/docs` | 404 (unless `SWAGGER_ENABLED=true` was approved) |
| 7 | 130 × `GET /api/services/public` from one client | 121st → 429 with `Retry-After` |
| 8 | Two different client networks | independent budgets (proves `TRUST_PROXY` / `X-Forwarded-For` is correct; if both share one budget, the trusted proxy setting is wrong) |
| 9 | Direct request to the origin IP, bypassing Cloudflare | refused at the network layer (firewall / tunnel) |
| 10 | Login from the staging frontend | Turnstile passes, tokens issued; `X-Request-ID` visible in browser devtools |

## 5. Rollback and recovery

> **Superseded by P3-BE12:** rollback cases A/B/C and the reversibility of each migration are in [p3-be12-deploy-rollback-runbook.md](p3-be12-deploy-rollback-runbook.md) §5. Restores go into a **new** database ([p3-be12-backup-restore-runbook.md](p3-be12-backup-restore-runbook.md) §5); the `pg_restore --clean --if-exists` hint below is withdrawn.

| Situation | Action |
|---|---|
| New build misbehaves, schema unchanged (BE11 adds no migration) | Redeploy the previous artefact. The startup schema check confirms compatibility. |
| A release with migrations must be reverted | Stop the instances. Restore `pre-<release>.dump` (`pg_restore --clean --if-exists`), or use the platform snapshot. Redeploy the previous artefact. The per-migration `down` chain (rehearsed: 17 × down succeeds) is a fallback for a single recent migration only, and runs after a fresh backup. |
| Readiness 503 `database: down` | Check database availability and credentials. Instances recover without a restart once the database answers. |
| Readiness 503 `schema: pending` | Migrations were not applied for this build: run step 3.3, or roll back the deployment. |
| 503 `RATE_LIMIT_UNAVAILABLE` everywhere | The counter table cannot be written (database read-only or full). Fix the database. The API stays closed deliberately (fail closed). |
| Legitimate users throttled | Raise the specific `RATE_LIMIT_<NAME>`. If every client shares one budget, `TRUST_PROXY` does not match the proxy. |

## 6. Deployment approval checklist (owner)

- [ ] Staging database created; application role is least-privilege (`\du`, attempt `CREATE TABLE` → denied).
- [ ] Pre-deployment backup taken and its restore tested.
- [ ] All `.env.staging.example` placeholders replaced in the secret store. No secret in git.
- [ ] `TRUST_PROXY` equals the real proxy/Cloudflare ranges. Origin not reachable directly.
- [ ] Cloudflare SSL mode Full (strict); Always Use HTTPS on; API hostname proxied.
- [ ] `CORS_ORIGINS` = the staging frontend origin(s) only.
- [ ] `PUSH_DELIVERY_MODE` decided (`disabled`, or `firebase` with `STAGING_ALLOW_REAL_PUSH=true` and a staging Firebase project).
- [ ] `MAIL_TRANSPORT` decided (`disabled` or a staging SMTP).
- [ ] CI green on the release commit (`verify` + `postgres-qa`).
- [ ] §4 checks executed and recorded.
- [ ] Rollback owner and window agreed.
