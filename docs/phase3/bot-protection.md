# PawFlow — Bot Protection: Cloudflare Turnstile & Auth Rate Limiting (P3-BE03)

Server-side Turnstile verification and per-IP / per-e-mail rate limiting for the public authentication endpoints.
Verified by `npm test` (unit) and `npm run qa:bot-protection` (real HTTP + PostgreSQL, two instances, Siteverify stub + the real Cloudflare endpoint with the official test keys).
Source: `src/auth/bot-protection/*`, `src/auth/rate-limit/*`, `src/common/filters/retry-after.filter.ts`, `src/common/utils/trust-proxy.ts`, migration `1795000000000-CreateAuthRateLimits`.

## 1. Protected endpoints

| Endpoint | Turnstile `action` | Rate limits (default) |
|---|---|---|
| `POST /api/auth/login` | `login` | 20 / 5 min per IP; 10 / 15 min per e-mail |
| `POST /api/auth/register` | `register` | 10 / hour per IP |
| `POST /api/auth/forgot-password` | `forgot_password` | 10 / 15 min per IP; 5 / hour per e-mail |
| `POST /api/auth/reset-password` | `reset_password` | 10 / 15 min per IP |

Nothing else changed: refresh, logout, sessions, change-password, verify-email and resend do not take a challenge. (`resend` and `change-password` require a logged-in user; `refresh` requires a refresh token.)

Order of checks in every protected request: **rate limit → body validation → Turnstile → the existing logic**. A request that fails one step changes nothing:

- **Login:** no password check and no session.
- **Register:** no user, session or token rows.
- **Forgot-password:** no account lookup and no e-mail.
- **Reset-password:** the reset token is not consumed and the password is unchanged.

## 2. Request contract

Add one optional field to the JSON body of the four endpoints:

```json
{ "email": "customer@example.com", "password": "…", "turnstileToken": "0.zLR6ZQe-…" }
```

- `turnstileToken`: the response token from the Turnstile widget (`turnstile.getResponse()` / the `cf-turnstile-response` value), at most 2048 characters. Send it in the body, not in a header.
- When the server runs with `TURNSTILE_MODE=disabled` (local development), the field may be omitted; if sent, it is ignored.
- When the server runs with `TURNSTILE_MODE=enforce`, the field is required (403 `TURNSTILE_REQUIRED` without it). No header, flag, role or field lets a client skip it.
- A non-string or oversized value is a `400` validation error in every mode.

## 3. Frontend integration (Turnstile widget)

1. Render the widget with the **site key** of the environment, and with the **action of the form**: `data-action="login"`, `register`, `forgot_password` or `reset_password`. The server rejects a token whose action does not match the endpoint.
2. The site must be served from a hostname in the server's `TURNSTILE_EXPECTED_HOSTNAMES` (configured per environment). Tokens from another hostname are rejected.
3. Submit the token with the form. **Tokens are single use and expire after 300 s.** After every submission, whatever the result (`200`, `401` wrong password, `400`, `403`, `409`, `429`, `503`), call `turnstile.reset(widgetId)` before the next attempt. A token cannot be reused for a second request.
4. Disable the submit button until the widget has produced a token, and handle the widget's `expired-callback` (reset and wait for a new token).

### Error handling

All errors keep the existing shape `{ statusCode, error, message }` and add `code` (and, where relevant, `retryAfterSeconds`).

| HTTP | `code` | Meaning | Frontend action |
|---|---|---|---|
| 403 | `TURNSTILE_REQUIRED` | No token sent (enforcement on) | Show the widget, wait for a token, resubmit |
| 403 | `TURNSTILE_INVALID` | Token rejected, wrong hostname or wrong action | `turnstile.reset()`, ask the user to complete the challenge again |
| 403 | `TURNSTILE_EXPIRED` | Token older than 300 s or already used | `turnstile.reset()`, resubmit with the new token |
| 429 | `RATE_LIMITED` | Too many attempts | Show "Too many attempts, try again in N s" using `Retry-After` / `retryAfterSeconds`; do not auto-retry before that |
| 503 | `TURNSTILE_UNAVAILABLE` | Cloudflare could not be reached or answered abnormally | `turnstile.reset()`, offer a retry after `Retry-After` (5 s) |
| 503 | `RATE_LIMIT_UNAVAILABLE` | Rate-limit store (database) unavailable | Retry after `Retry-After` (5 s) |

- `403` here is not an authentication failure: do **not** run the refresh-token logic on it (that logic is for `401`).
- `401 Invalid email or password` etc. are unchanged and are only returned after the challenge passed.
- `forgot-password` still returns the same `202` for every address once the challenge passes. A `403`/`429` never depends on whether the address has an account.

## 4. Server configuration

| Variable | Values / default | Notes |
|---|---|---|
| `TURNSTILE_MODE` | `disabled` \| `enforce` | **Production (`NODE_ENV=production`) refuses to start unless `enforce`.** Unset outside production means disabled, with a startup warning. |
| `TURNSTILE_SECRET_KEY` | — | Required with `enforce`. Production refuses Cloudflare's dummy secrets (`1x…AA`, `2x…AA`, `3x…AA`). Use separate keys (widgets) for staging and production. Never commit it. |
| `TURNSTILE_EXPECTED_HOSTNAMES` | comma-separated hostnames | Required with `enforce`; bare hostnames (`app.pawflow.vn,www.pawflow.vn`). The hostname reported by Cloudflare must be one of them. |
| `TURNSTILE_CHECK_ACTION` | `true` (default) | `false` only outside production (needed with the dummy keys, which return no action). |
| `TURNSTILE_TIMEOUT_MS` | `3000` (500-10000) | Per Siteverify attempt. |
| `TURNSTILE_SITEVERIFY_URL` | official URL | Override for QA stubs only; refused in production. |
| `AUTH_RATE_LIMIT` | `enabled` (default) \| `disabled` | `disabled` refused in production. |
| `RATE_LIMIT_LOGIN_IP`, `RATE_LIMIT_LOGIN_EMAIL`, `RATE_LIMIT_REGISTER_IP`, `RATE_LIMIT_FORGOT_IP`, `RATE_LIMIT_FORGOT_EMAIL`, `RATE_LIMIT_RESET_IP` | `<limit>/<windowSeconds>` | Override a default from §1, e.g. `RATE_LIMIT_LOGIN_IP=20/300`. |
| `RATE_LIMIT_HASH_SECRET` | defaults to `JWT_SECRET` | HMAC key for the stored buckets. |
| `TRUST_PROXY` | unset (= no proxy) | Set when behind a reverse proxy / load balancer: hop count (`1`) or proxy addresses/subnets (`10.0.0.0/8, loopback`). `true` is refused. Without it, `X-Forwarded-For` is ignored. |

Invalid values stop the application at startup with an error naming the variable (never its value).

| Environment | Recommended |
|---|---|
| Local development (current FE without widget) | `TURNSTILE_MODE=disabled` (explicit), `AUTH_RATE_LIMIT=enabled` with defaults (or `disabled` if needed). |
| FE work with the widget | `TURNSTILE_MODE=enforce`, Cloudflare **test** site key `1x00000000000000000000AA` in the FE and secret `1x0000000000000000000000000000000AA`, `TURNSTILE_EXPECTED_HOSTNAMES=example.com`, `TURNSTILE_CHECK_ACTION=false`. The test keys always report hostname `example.com` and no action. |
| Automated QA | Legacy suites: explicitly `disabled` (in `test/qa/qa-env.cjs`); `qa:bot-protection`: enforce against a stub plus the official test keys. |
| Staging | `NODE_ENV=production`, `TURNSTILE_MODE=enforce`, staging widget secret, staging hostname(s), `TRUST_PROXY` as per the hosting. |
| Production | Same, with the production widget secret and hostname(s). |

## 5. Behaviour details

- **Verification:** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, `remoteip` (the client IP, see `TRUST_PROXY`) and `idempotency_key`. Redirects are never followed; the URL is fixed in production.
- **Accepted only if:** `success: true`, hostname in the allowlist, action equals the endpoint's action (production always checks), and (in production) not a test-key result (`metadata.result_with_testing_key`).
- **Fail closed:** every timeout, network error, 5xx, `429` from Cloudflare, non-JSON or malformed body, `invalid-input-secret`, `missing-input-secret`, `bad-request` and `internal-error` → `503 TURNSTILE_UNAVAILABLE`. There is no path that lets a request through without a positive verdict.
- **Retry:** transient transport failures (network, timeout, 5xx/429, non-JSON/malformed) are retried **once** after 250 ms with the **same** `idempotency_key`, so Cloudflare does not treat the retry as a duplicate. Challenge failures (`invalid-input-response`, `timeout-or-duplicate`, hostname/action mismatch) are never retried. Worst case ≈ 2 × `TURNSTILE_TIMEOUT_MS` + 250 ms.
- **No caching:** each request is verified with Cloudflare; a token that passed cannot be used again (`timeout-or-duplicate` → `TURNSTILE_EXPIRED`).
- **Rate limiting:** fixed windows aligned to the database clock, counted in PostgreSQL table `auth_rate_limits` with one atomic upsert per request, so all instances share the counters and limits survive restarts. Every request counts (successful or not), keyed by client IP (IPv6: per /64) and, for login and forgot-password, by the normalized e-mail string, whether or not an account exists. Buckets are HMAC-SHA256 values; the table never holds raw IPs or e-mail addresses. Expired windows are purged every 5 minutes. If the counter cannot be written, the request fails closed (`503 RATE_LIMIT_UNAVAILABLE`).
- **Logging:** rejections are logged with the action, the public code and the Cloudflare error code or mismatch; rate-limit blocks with the policy names. Logs never contain challenge tokens, the secret, passwords, raw e-mail addresses or bucket values.

## 6. Deployment

- Migration `CreateAuthRateLimits1795000000000` adds `auth_rate_limits` (additive; `down` drops it, so counters restart at zero). **Run it before starting the new build.** Without the table, the protected endpoints answer `503 RATE_LIMIT_UNAVAILABLE` (when rate limiting is enabled). The previous build ignores the table, so migrating first is safe.
- Not applied to `pet_care_db` yet (needs approval). Rehearsed up/down/up on a disposable QA database.

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| App does not start: `TURNSTILE_MODE must be set to "enforce"` | `NODE_ENV=production` without `TURNSTILE_MODE=enforce`. |
| Every challenge → `TURNSTILE_UNAVAILABLE`, log `rejected the server configuration … invalid-input-secret` | Wrong `TURNSTILE_SECRET_KEY` (or the secret of another widget). |
| Every challenge → `TURNSTILE_INVALID`, log `hostname mismatch (got X)` | Add `X` to `TURNSTILE_EXPECTED_HOSTNAMES`, or the FE uses the wrong site key. With the dummy keys X is `example.com`. |
| `TURNSTILE_INVALID`, log `action mismatch (got none/...)` | The widget is rendered without `data-action` or with another action. Dummy keys: set `TURNSTILE_CHECK_ACTION=false` (non-production only). |
| Many `TURNSTILE_EXPIRED` | The FE reuses tokens or submits after 300 s; reset the widget after every submission. |
| `TURNSTILE_UNAVAILABLE`, log `timeout after … ms` / `network error` | The server cannot reach `challenges.cloudflare.com` (egress firewall, DNS). |
| All users rate limited together | Behind a proxy without `TRUST_PROXY`: every request has the proxy's IP. |
| Rate limits easy to evade | `TRUST_PROXY` too broad: only list your own proxies. |

## 8. Known limits

- **Live production verification has not been performed:** no production/staging widget, secret or hostname exists yet. Verified with a Siteverify stub (hostname, action, replay, failures) and with Cloudflare's official test keys against the real endpoint (protocol only: the test keys do not exercise real tokens, replay or hostnames).
- Fixed windows allow up to 2 × limit around a window boundary.
- The per-e-mail login limit can be used to slow down logins to a known address (a targeted nuisance, not a lockout: the window is 15 minutes and Turnstile still applies).
- Rate limiting adds one database write per protected request; there is no in-memory pre-filter for volumetric attacks (that belongs at the edge: Cloudflare WAF / proxy).
