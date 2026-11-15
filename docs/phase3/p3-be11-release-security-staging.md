# P3-BE11 — Release Security & Staging

**Acceptance criterion:** *"HTTPS-aware staging API; 429 policy; secure headers/CORS; health check; migrations and env verified."*

**Scope.** Code, configuration and local verification only. Nothing was deployed, no cloud resource, DNS or Cloudflare setting was touched, and `pet_care_db` was not accessed. Deployment is a separate approval gate: see [p3-be11-staging-runbook.md](p3-be11-staging-runbook.md).

## 1. Baseline security inventory (before BE11)

| Area | Before | Gap | Change |
|---|---|---|---|
| Rate limiting | BE03 PostgreSQL fixed-window limiter (`auth_rate_limits`, atomic upsert, shared by instances, HMAC buckets, IPv6 /64, fail-closed 503) on login, register, forgot and reset only | Refresh, verify-email, resend and change-password were unthrottled. No limit at all on the rest of the API (public search, authenticated reads/writes, admin, 401 floods). `Retry-After` was only set on the auth controller. | Same limiter extended: 4 endpoint policies and 4 API-wide policies (global per-IP guard, per-user interceptor). `Retry-After` set globally. |
| Security headers | none (Express defaults, `X-Powered-By: Express`) | No nosniff, frame protection, CSP, referrer or permissions policy, HSTS | Middleware with an explicit header set. HSTS only on trusted HTTPS. `X-Powered-By` removed. |
| CORS | single `FRONTEND_URL` (default `http://localhost:3001`), credentials on | Staging and production silently inherited a localhost default; no environment separation; methods and headers implicit | Exact-origin allowlist `CORS_ORIGINS` (https only, no localhost, wildcard or path in staging/production); explicit methods, headers and max-age |
| Reverse proxy / Cloudflare | `TRUST_PROXY` parser (BE03) refuses `true`; default off | Not required in deployed environments: behind a proxy every client shares one rate-limit bucket | `TRUST_PROXY` must be set explicitly in staging/production. `CF-Connecting-IP` / `X-Real-IP` never read. Behaviour proven by tests (spoofing, trusted path, IPv6, malformed). |
| HTTPS awareness | none | — | `req.secure` (trusted `X-Forwarded-Proto` only) drives HSTS. No redirects, so no loop behind Cloudflare. |
| Health checks | `GET /api` returns "Hello World!" | No liveness/readiness, no database check | `GET /api/health/live`, `GET /api/health/ready` (bounded DB probe + schema status) |
| Staging configuration | `NODE_ENV=staging` recognised only by push delivery | **Defect:** Turnstile, auth rate limit, file mail, text logs and push-key rules checked `NODE_ENV === 'production'` only, so staging started with development shortcuts. No validation of DB, TLS, secrets, origins or proxy. | `loadReleaseConfig` (fail-closed, all violations reported, values never printed). Five loaders fixed to treat staging as deployed. |
| Database | no TLS option; `.env` dev DB | Staging could point at `pet_care_db`, use `postgres`, run without TLS | `DB_SSL` (require / no-verify / disable-loopback-only). Dev DB name and superusers refused. Least-privilege role rehearsed. |
| Migration readiness | migrations run manually | App could start on a stale schema | Startup schema check (`MIGRATIONS_CHECK=enforce` default when deployed). Full 17-step down/up rehearsal. |
| Swagger | always public | Internal docs exposed in any deployment | Off by default in staging/production (`SWAGGER_ENABLED`). Documentation CSP. |
| Secrets in git | `.env` ignored | A real `.env.staging` / `.env.production` would not be ignored | Added to `.gitignore`; templates end in `.example`. |
| Automated QA | BE10: 20 PostgreSQL QA suites (890 checks), Jest 1756, E2E 4 | No proof of headers, CORS, proxy, 429, health, staging boot or rollback | `qa:release-security` (34 checks) plus 4 Jest suites (110 tests) |

## 2. Rate-limit policy

All policies are fixed windows counted in PostgreSQL. One atomic multi-row upsert per check is exact across any number of instances. Every request counts whatever its outcome, so failures cannot probe accounts. Buckets are HMAC-SHA256 values (`RATE_LIMIT_HASH_SECRET`, defaulting to `JWT_SECRET`), so no raw IP, e-mail or user id is stored. Override any policy with `RATE_LIMIT_<NAME>=<limit>/<windowSeconds>`.

| Category | Policy | Default | Key | Where enforced |
|---|---|---|---|---|
| Every request except health | `api_ip` | 600 / 60 s | client IP | global guard, **before** authentication (bounds 401 floods) |
| Public catalogue, search, auth entry points | `public_ip` | 120 / 60 s | client IP | global guard (routes without `JwtAuthGuard`) |
| Authenticated reads (GET/HEAD/OPTIONS) | `user_read` | 300 / 60 s | verified user id | global interceptor (after `JwtAuthGuard`) |
| Authenticated writes (incl. admin actions) | `user_write` | 60 / 60 s | verified user id | global interceptor |
| Login | `login_ip`, `login_email` | 20 / 300 s, 10 / 900 s | IP, e-mail | BE03, unchanged |
| Register | `register_ip` | 10 / 3600 s | IP | BE03 |
| Forgot / reset password | `forgot_ip`, `forgot_email`, `reset_ip` | 10 / 900, 5 / 3600, 10 / 900 | IP, e-mail | BE03 |
| Refresh token | `refresh_ip` | 60 / 300 s | IP | **new** |
| Verify e-mail (public) | `verify_ip` | 20 / 900 s | IP | **new** |
| Resend verification | `verify_resend_user` | 5 / 3600 s | user | **new** (plus the BE02 cooldown) |
| Change password | `change_password_user` | 5 / 900 s | user | **new** |

**Design choices**

- **Identity.**
  - Client IP is `request.ip`, which honours `TRUST_PROXY` only. IPv4-mapped IPv6 is normalized, and IPv6 is grouped per /64.
  - The user id comes only from `request.user`, which `JwtAuthGuard` sets after validating the session in the database. `X-User-Id`, JWT claims and `CF-Connecting-IP` are never used.
- **Shared networks.** Per-IP ceilings (600/min overall, 120/min public) leave room for many users behind one NAT. Authenticated traffic is additionally budgeted per user, so one heavy user does not consume a shared IP's allowance faster than allowed.
- **Exemptions.** Only `/api/health/*`, because probes are continuous and must answer even when the counter store is down. They read no business data.
- **Storage and topology.** PostgreSQL is the only shared store the deployment already has, so no Redis or paid dependency is needed. **Multi-instance enforcement is VERIFIED:** 24 concurrent requests on 2 instances against a limit of 10 gave exactly 10 × 200 and 14 × 429, with counter = 24.
- **Cost.** Up to two upserts per request (IP before auth, user after). Expired windows are purged every 5 minutes.
- **Failure.** If the store is unavailable the API fails closed with 503 `RATE_LIMIT_UNAVAILABLE` and `Retry-After: 5`. It never serves traffic unmetered.

### 429 contract

```
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds until the window resets, >= 1>
X-Request-ID: <correlation id>
Content-Type: application/json; plus every security header

{"statusCode":429,"error":"Too Many Requests","message":"Too many requests; please try again later","code":"RATE_LIMITED","retryAfterSeconds":<same as Retry-After>}
```

This body is the BE03 body, unchanged. The `Retry-After` header is now added by the global exception filter on every controller. The log line contains policy names only: no IP, bucket or e-mail.

## 3. CORS policy

| | Development / test | Staging / production |
|---|---|---|
| Origins | `CORS_ORIGINS`, else `FRONTEND_URL`, else `http://localhost:3000,3001` | `CORS_ORIGINS` **required**: https, no localhost, no wildcard, no path/query/credentials |
| Matching | exact string match of the normalized origin. No reflection of unknown origins, no suffix/prefix/substring logic. | same |
| Disallowed or absent Origin | no CORS headers at all (the browser blocks the response; the request is still authenticated normally) | same |
| Methods | GET, HEAD, POST, PUT, PATCH, DELETE | same |
| Request headers | Authorization, Content-Type, Idempotency-Key, X-Request-ID | same |
| Exposed headers | Idempotent-Replayed, X-Request-ID, Retry-After | same |
| Credentials | `Access-Control-Allow-Credentials: true`. Auth is header-based (no cookies), but the existing frontend sends `credentials: "include"`. This is safe only because origins are an exact allowlist. | same |
| Preflight | 204, `Access-Control-Max-Age: 600` | same |

## 4. HTTP security headers

Headers sent on every response: success, 4xx, 5xx, 429 and health.

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | API: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. `/api/docs*`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; …` (Swagger UI scripts are external files; its page has one inline `<style>`). |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, sensors, display-capture all `()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cache-Control` | `no-store` (API responses; not on Swagger assets) |
| `Strict-Transport-Security` | `max-age=<HSTS_MAX_AGE_SECONDS>; includeSubDomains`, **only** when `req.secure` is true (TLS connection, or `X-Forwarded-Proto: https` from a `TRUST_PROXY` peer) and HSTS is configured (default 180 days when deployed, 0 locally) |
| `X-Powered-By` | removed |

`Cross-Origin-Resource-Policy` is deliberately not set: the API is consumed cross-origin by the frontend, and the header adds nothing for JSON fetched with CORS.

## 5. Trusted proxy, Cloudflare and client IP

```
Browser --TLS--> Cloudflare edge --TLS (Full strict)--> reverse proxy / LB --> PawFlow API (Express)
                                 X-Forwarded-For: <client>        trust proxy = TRUST_PROXY
                                 X-Forwarded-Proto: https         request.ip / request.secure
```

**Client IP resolution** is Express `trust proxy` (proxy-addr), configured from `TRUST_PROXY`:

| Request path | `TRUST_PROXY` | `request.ip` | `request.secure` |
|---|---|---|---|
| Direct client | `false` (or unset locally) | TCP peer | actual TLS of the connection |
| Spoofed headers from an untrusted peer | anything not matching the peer | TCP peer (forwarded headers ignored) | actual TLS (spoofed `X-Forwarded-Proto` ignored) |
| Through a trusted proxy | proxy CIDR / addresses / hop count | rightmost untrusted address of `X-Forwarded-For` | from `X-Forwarded-Proto` |
| Malformed `X-Forwarded-For` | trusted proxy | non-IP value → normalized to one shared `unknown` bucket | — |

**Rules:**
- `TRUST_PROXY=true` is refused.
- Staging and production must set `TRUST_PROXY` explicitly (`false` is accepted for deliberate direct exposure).
- `CF-Connecting-IP`, `X-Real-IP` and `Forwarded` are never read. Behind Cloudflare, list the Cloudflare ranges (or your own proxy) in `TRUST_PROXY`, and Cloudflare's appended `X-Forwarded-For` entry becomes the client.
- Raw client IPs are not logged (BE09). Counters store HMACs only.

**Origin protection** (prerequisites for the trust model, configured outside the application):
- The origin must not be reachable except through the edge or proxy: firewall, security group, or Cloudflare Tunnel / authenticated origin pulls.
- If the origin is reachable directly while `TRUST_PROXY` lists broad ranges, a client inside those ranges could forge `X-Forwarded-For`.
- Cloudflare SSL mode: **Full (strict)**. "Always Use HTTPS" at the edge.
- The API itself never redirects, so there is no redirect loop.

## 6. Health and readiness

| Endpoint | Purpose | Healthy | Unhealthy |
|---|---|---|---|
| `GET /api/health/live` | Process serves HTTP. Touches no dependency. | 200 `{"status":"ok"}` | (no response) |
| `GET /api/health/ready` | Can serve traffic: `SELECT 1` bounded by `HEALTH_DB_TIMEOUT_MS` (2 s), and schema status computed at startup | 200 `{"status":"ready","checks":{"database":"up","schema":"current"}}` | 503 `{"status":"unavailable","checks":{"database":"down"\|"timeout","schema":"current"\|"pending"\|"ahead"\|"unknown"}}` |

- **Public.** No host, port, version, error or stack is exposed.
- **Rate limiting.** Exempt from the API limits.
- **Responses.** Carry `X-Request-ID` and the security headers.
- **Migrations.** Health checks never run migrations.
- **Recovery.** Readiness recovers without a restart once the database is back (verified).

## 7. Environment matrix

| Variable | Development | Test (QA) | Staging | Production |
|---|---|---|---|---|
| `NODE_ENV` | unset / `development` | `test` | `staging` | `production` |
| Unknown `NODE_ENV` (e.g. `prod`) | refused | refused | refused | refused |
| `JWT_SECRET` | any | random per run | ≥ 32 chars, no placeholder | same |
| `RATE_LIMIT_HASH_SECRET` | optional | optional | recommended, ≥ 32, ≠ JWT | same |
| `DB_DATABASE` | `pet_care_db` | `pawflow_qa_*` (run-owned) | dedicated (not `pet_care_db`) | dedicated |
| `DB_USERNAME` | any | QA superuser (admin of disposable DBs) | least-privilege role (not postgres/admin/root) | same |
| `DB_PASSWORD` | any | — | ≥ 12 chars, no placeholder | same |
| `DB_SSL` | `disable` | `disable` | `require` / `no-verify` (`disable` only for loopback) | same |
| `MIGRATIONS_CHECK` | `off` | `off` (enforced in `release-security`) | `enforce` | `enforce` |
| `CORS_ORIGINS` | optional (localhost) | optional | required, https | required, https |
| `TRUST_PROXY` | optional | optional | **required** | **required** |
| `HSTS_MAX_AGE_SECONDS` | 0 | 0 | 15552000 | 15552000 |
| `SWAGGER_ENABLED` | true | true | false (opt-in) | false (opt-in) |
| `AUTH_RATE_LIMIT` / `API_RATE_LIMIT` | enabled (disable allowed) | auth disabled / API enabled with raised ceilings in functional suites | enabled (disable refused) | enabled |
| `TURNSTILE_MODE` | optional | disabled | `enforce`, real secret, action check | same |
| `PUSH_DELIVERY_MODE` | disabled/mock | mock/disabled | explicit `disabled` or `firebase` + `STAGING_ALLOW_REAL_PUSH=true` | explicit |
| `PUSH_REGISTRATION_KEYS/HASH_KEY` | derived dev keys | derived | required | required |
| `MAIL_TRANSPORT` | disabled/file/smtp | disabled/file | disabled/smtp (file refused) | disabled/smtp |
| `LOG_FORMAT` | json/text | json | json (text refused) | json |

A full template is in `.env.staging.example`. Real files (`.env.staging`, `.env.production`) are git-ignored.

## 8. Database isolation and migration verification

- **Staging database separation by configuration:**
  - `DB_DATABASE=pet_care_db` refuses the start before any connection is opened (verified: no Nest module initialized).
  - Superuser accounts are refused.
  - Remote databases require TLS.
- **Least privilege** (rehearsed):
  - A run-owned role with `CONNECT`, schema `USAGE`, table `SELECT/INSERT/UPDATE/DELETE` and sequence `USAGE/SELECT` runs the whole staging instance.
  - `CREATE TABLE` / `DROP TABLE` as that role fail with 42501.
  - Migrations are run by the database owner, never by the application.
- **Migration chain** (17 migrations; BE09, BE10 and BE11 add none):
  - clean apply = 17, with 0 pending DDL;
  - re-run = 0 executed (no-op);
  - every migration's `down` executes in order (17 × 1), leaving no application table;
  - re-apply = 17, with 0 pending DDL;
  - the build's expected migration names (derived from file names) equal the applied names.
- **Startup schema check.** The application compares the applied migrations with its build:
  - a pending migration or an unknown (newer) one → refuses to start under `enforce`;
  - verified with a database one migration behind: "1 pending, 0 not in this build".

## 9. Threat / test matrix

| Threat | Control | Evidence |
|---|---|---|
| Credential stuffing / token guessing | `login_*`, `api_ip` before auth | QA §5: 30 × 401 then 429; login 5 × 403 then 429 |
| Rate-limit bypass with spoofed `X-Forwarded-For` / `CF-Connecting-IP` | `TRUST_PROXY` only; other headers never read | QA §5 (direct exposure); Jest (untrusted / trusted) |
| Bypass with malformed or rotating IPv6 | normalization: `unknown` bucket, /64 grouping | QA §5; Jest unit |
| Per-instance counting | PostgreSQL atomic upsert | QA §5: 2 instances, exact 10/14 |
| Rate-limit store outage | fail closed 503 | QA §5 (trigger); Jest unit |
| Spoofed HTTPS (`X-Forwarded-Proto`) | `req.secure` via `TRUST_PROXY` | QA §4; Jest |
| Cross-origin data theft | exact allowlist, no reflection | QA §4; Jest (7 hostile origins) |
| Clickjacking / MIME sniffing / referrer leak | headers | Jest (all response kinds); QA §4 |
| Internal docs exposure | Swagger off when deployed | QA §4 (404) |
| Staging with development shortcuts | `loadReleaseConfig` + 5 loaders | QA §3 (15 refusals); Jest (26 + 3 regression cases) |
| Staging on the development DB / superuser / no TLS | release config | QA §3; Jest |
| Stale schema serving traffic | startup schema check, readiness | QA §1, §3; Jest |
| Secret leakage in logs or errors | sanitized refusal; BE09 logger | QA §3, §7 |
| Privilege escalation / IDOR / auth bypass | BE10 matrix (unchanged, re-run with limits enabled) | `api-security-matrix` 32/32 |

## 10. Validation commands

```
npm run typecheck && npm run lint && npm run build
npm test                         # Jest (unit + HTTP contract)
npm run test:e2e                 # full AppModule on a disposable database
npm run qa:release-security      # P3-BE11 staging rehearsal (disposable databases + a run-owned role)
npm run qa:all                   # every PostgreSQL QA suite (21)
```

## 11. Results

Final run on 2026-11-15, branch `feature/release-security-staging` at `4b80b75` plus the BE11 working-tree changes, local PostgreSQL 15.

| Gate | BE10 baseline | BE11 actual | Verdict |
|---|---|---|---|
| Typecheck (`tsconfig.json`, `tsconfig.spec.json`) | PASS | exit 0 / exit 0 | PASS |
| Lint | PASS, 1 pre-existing warning | 0 errors, the same 1 pre-existing warning (`bot-protection.cjs:189`) | PASS |
| Build | PASS | exit 0 | PASS |
| Jest | 1756 / 61 suites | **1866 / 65 suites** (+110 tests: release config 53, HTTP security 39, API rate limit 11, schema status 7) | PASS |
| E2E (`test:e2e`) | 4 | **4/4** (real AppModule now includes the health module, global rate-limit guard and interceptor) | PASS |
| PostgreSQL QA (existing 20 suites) | 890 PASS, 1 SKIP | **890 PASS, 1 SKIP**, now running with the API-wide limits enabled | PASS |
| Rate-limit security | new | `release-security` §5: 12 checks (boundary, 429 contract, 401 floods, spoofing, trusted-proxy isolation, IPv6 /64, malformed, 2-instance concurrency, window expiry, per-user, auth-before-bot, fail closed) | PASS |
| Proxy / CORS / headers | new | `release-security` §4: 6 checks; Jest 39 | PASS |
| Staging configuration | new | `release-security` §3: 9 + 6 refusals and the schema refusal; real `NODE_ENV=staging` instances with a least-privilege role; Jest 53 | PASS |
| Migration rehearsal | new | `release-security` §1: clean 17, no-op re-run, 17 × down, re-up 17, 0 DDL, names match | PASS |
| **QA total** (`npm run qa:all`) | 20 suites, 890 | **21/21 suites OK, 924 PASS, 0 FAIL, 1 SKIP** (opt-in Cloudflare protocol check) | PASS |

**Databases and roles.**
- Created and dropped by the runs: `pawflow_qa_<suite>_<runId>`, `pawflow_qa_release_security_<runId>` and its `_mig` copy, `pawflow_qa_e2e_<id>`, and the role `pawflow_qa_role_<run>`.
- Afterwards the only QA database is the pre-existing `pawflow_qa_push_delivery` (untouched), and no QA role remains.
- `pet_care_db` was never connected to. The one CLI check of `database/data-source.ts` targeted a non-existent `pawflow_qa_never_used` and failed to connect, as intended.

## 12. Remaining blockers and risks

- **Live staging is not deployed.** Public HTTPS, Cloudflare proxying, origin lockdown, the managed database's TLS certificate and real Turnstile/FCM credentials are unverified. They require the deployment approval in the runbook.
- **Cloudflare IP ranges change.** `TRUST_PROXY` must be refreshed from https://www.cloudflare.com/ips/ (or use a single own proxy address).
- **Rate-limit cost.** Each API request performs up to two counter upserts on the primary database. This is acceptable for staging volumes; load-test before production.
- **CI.** The `postgres-qa` job now also runs `release-security`. GitHub Actions has still not run the BE10/BE11 workflow from this machine (first remote run pending).

## 13. Deployment approval checklist

See the runbook §6. Every item must be ticked with evidence by the repository owner. BE11 does not tick any of the "live" items.

## 14. Rollback and recovery preparation

See the runbook §5:
- an application rollback is a redeploy of the previous image (no schema change in BE11);
- a database rollback is restore from the pre-migration backup;
- per-migration `down` has been rehearsed but is the fallback, not the primary path.
