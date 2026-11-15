# P3-BE09 — Observability & Audit

Roadmap acceptance: *"Admin activity log implemented; add request correlation IDs and structured logs without PII/tokens."*

The Admin Activity Log already existed (P1) and was **not** reimplemented. BE09 adds request correlation, structured logs that leave out sensitive data, safe error observability and job correlation, and links each audit row to the request that caused it.

No database migration. No new dependency. No public API contract change except one new response header, which is additive.

## 1. Request correlation: `X-Request-ID`

| Aspect | Contract |
|---|---|
| Request header | Optional `X-Request-ID`. It is kept only when it is one header value of **8–128 characters** from `[A-Za-z0-9._:-]` that starts with a letter or digit (`REQUEST_ID_PATTERN`). UUIDs, ULIDs and most tracing IDs qualify. |
| Otherwise | The server generates a UUID v4 (`crypto.randomUUID`). This applies when the header is absent, repeated, too short or long, or contains spaces, control characters, non-ASCII, quotes or markup. |
| Response header | **Every** response carries the authoritative `X-Request-ID`, including body-parser errors, 401/403 from guards, 400 validation errors, 404, 409 and 500. CORS exposes the header. |
| Propagation | `AsyncLocalStorage` (`observability-context.ts`). The context is created by the first middleware, before body parsing, routing and guards, and is also attached to `req`. There are no request-scoped providers and no global "current request". Concurrent requests never share or overwrite a context (Jest: 60 concurrent requests; QA: concurrent actions on 2 instances). |
| Trust | Correlation only. It is never an authentication or authorization input, and a client-chosen value is not trusted evidence. |
| Swagger | Documented as a global optional header parameter, together with the response-header behaviour. |

## 2. Structured logs

Every line is one JSON object (default `LOG_FORMAT=json`), with keys in a fixed order:

```
timestamp, level, event, context?, requestId?, jobId?, attempt?, <allowlisted fields>, message?, errorName?
```

| Event | Emitted by | Fields |
|---|---|---|
| `http.request.completed` | One per request, when the response finishes | `method`, `route` (template such as `/api/admin/providers/:id/approve`, or `/(unmatched)`), `statusCode`, `durationMs`, plus `errorCode` / `errorName` / `dbCode` on failures |
| `http.request.aborted` | Instead of the above, when the client disconnects first | same |
| `push.job.completed` / `.expired` / `.lease_lost` / `.persist_failed` | Push delivery worker | `jobId`, `attempt`, `notificationId`, `outcome`, `state`, `category`, `code`, `retryDelayMs`, `durationMs` |
| `app.log` | Every ordinary `Logger` call (existing messages unchanged) | `context`, `message`, plus `requestId` / `jobId` from the context |

**Severity.** HTTP 5xx → `error`. HTTP 4xx and aborted requests → `warn`. Other requests → `info`. A successful `GET /api` readiness probe → `debug`.

**Default level.** `LOG_LEVEL` is `info` in production and `debug` otherwise.

**Startup.** An invalid `LOG_FORMAT` / `LOG_LEVEL` stops the startup. `LOG_FORMAT=text` (human-readable) is refused when `NODE_ENV=production`.

**Errors.** Unexpected errors keep Nest's response body: `{"statusCode":500,"message":"Internal server error"}`. Nest's `ExceptionsHandler` used to print the error message and stack, and PostgreSQL errors include row values. Now only the error class (`errorName`) and the SQLSTATE (`dbCode`) are logged, inside the single completion event. For `HttpException` bodies, a valid `code` (for example `RATE_LIMITED` or `REGISTRATION_TRANSFERRED`) is logged as `errorCode`.

**Failure policy.** Operational logging is best effort. A logging failure is swallowed and never fails a request or job. The persistent audit trail is separate (§3).

### Safe-logging policy

1. **Allowlist (primary guarantee).** Event fields go through `FIELD_RULES` in `log-fields.ts`. Each key has a type, range and character-set validator, and unknown keys or invalid values are dropped. The logs never contain bodies, headers, cookies, query strings, raw URLs, DTOs, identity or contact fields.
2. **Free-text messages (defense in depth).** Messages are made single-line (control characters and U+2028/2029 become spaces, which blocks log injection), capped at 512 characters, and scrubbed of the following:
   - `Bearer` / `Basic` credentials
   - JWTs
   - `password=` / `token:` / `api-key=`-style pairs
   - e-mail addresses
   - Vietnamese phone numbers
   - opaque strings of 40 or more characters (FCM tokens, keys)

   Pattern matching cannot find every secret, so code must still never put secrets into messages. Existing messages already used IDs and masked recipients only.
3. **Error objects** are never serialized. Only the class name and the scrubbed message are kept, so startup configuration errors stay explainable. Properties such as a database `detail` and stack traces are never written. Request-path errors never reach this path: the exception filter logs class and SQLSTATE only.

## 3. Admin Activity Log (existing), verified and extended

The following behaviour was verified and left unchanged:
- `ADMIN`-only `GET /admin/activity-logs` and `GET /admin/activity-logs/:id` (`JwtAuthGuard` + `RolesGuard`).
- The actor comes from the authenticated session (`@CurrentUser`), not from client input.
- Every audit row is written with the business mutation's `EntityManager`, inside the same transaction, under a `pessimistic_write` lock.
- An invalid or no-op transition throws 409 before any write, so no row is created. A master-data update with no changed field writes no row.
- Metadata holds transitions and field names only. It never holds note text or credentials.

BE09 adds one thing: when the action runs inside an HTTP request, `record()` adds **`metadata.requestId`**.
- It uses the existing `jsonb` column, so there is no schema change. Older rows simply lack the key and stay readable.
- It links an audit row to the request's log lines. It is a correlation hint, not actor evidence.
- Outside a request (for example a job), metadata is unchanged.

## 4. Background jobs

Each push delivery attempt runs in its own job context, `runWithJobContext({ jobId, attempt })`. Every log line of that attempt carries `jobId` / `attempt`, including executor lines such as consent checks. A job is never tied to the request that enqueued it.

The existing message text is kept, so `qa:push-worker` regexes still match. The following were not changed:
- retry semantics
- leases and idempotency
- consent enforcement
- outbox state transitions

Development push delivery stays disabled.

## 5. Configuration

```
LOG_FORMAT=json | text      # default json; text refused in production
LOG_LEVEL=debug | info | warn | error | fatal   # default info (production) / debug
```

## 6. Files

| File | Responsibility |
|---|---|
| `src/common/observability/request-id.ts` | Header name, input contract, generation |
| `src/common/observability/observability-context.ts` | AsyncLocalStorage request/job context, `logEvent` |
| `src/common/observability/log-fields.ts` | Field allowlist, message sanitizer |
| `src/common/observability/structured-logger.ts` | JSON/text `LoggerService`, `loadLoggingConfig` |
| `src/common/observability/http-observability.ts` | Request middleware, completion event, route templates, exception filter, `applyHttpObservability` |
| `src/main.ts` | Installs logger and observability, CORS exposure, Swagger header |
| `src/common/filters/retry-after.filter.ts` | Records `errorCode` (controller-scoped filter precedes the global one) |
| `src/admin/admin-activity-log.service.ts` | `metadata.requestId` |
| `src/push-delivery/worker/push-delivery.worker.ts` | Job context and structured job events |
| `test/qa/observability-audit.cjs` | Real HTTP + PostgreSQL QA (25 checks) |
| `test/qa/bot-protection.cjs` | One log regex made tolerant of JSON escaping (`Trust proxy: [\"loopback\"]`) |
