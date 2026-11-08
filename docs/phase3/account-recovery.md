# PawFlow — Password Change, Account Recovery & E-mail Verification (P3-BE02)

Authenticated password change, forgot/reset password and the e-mail verification lifecycle, built on the P3-BE01 sessions.
Verified by `npm test` (unit) and `npm run qa:account-recovery` (real HTTP + PostgreSQL, 91 checks, including a migration rehearsal and an SMTP protocol stub).
Source: `src/auth/account-recovery.service.ts`, `src/auth/email-verification.service.ts`, `src/auth/auth-user-token.util.ts`, `src/mail/*`, migration `1794690000000-AddAccountRecovery`.

## 1. Rules

| Topic | Rule |
|---|---|
| Password policy | Unchanged from registration: 8–72 characters, no composition rules; bcrypt cost 12. New password must differ from the current one (bcrypt comparison). |
| Password change | Requires the current password. On success **every** session of the user is revoked, including the current one (`PASSWORD_CHANGED`), and any outstanding reset link is invalidated. The client must log in again. |
| Forgot password | Always `202` with the same body, for any address. Only ACTIVE accounts get a link. For them the token is **committed before the 202** (an accepted request survives a crash); only the e-mail is sent after the response. Every response is padded to `AUTH_RECOVERY_MIN_RESPONSE_MS` (default 250 ms), so the extra transaction is not visible as latency. A database error is a `500` for any address. |
| Reset token | 32 random bytes (base64url, 43 chars), only SHA-256 stored. Lifetime `PASSWORD_RESET_TOKEN_TTL_SECONDS` (default **30 min**). Single use. A new request supersedes (revokes) the previous link. |
| Reset | Consumes the token, sets the password, revokes every session (`PASSWORD_RESET`) and every other outstanding reset/verification link, and marks the e-mail verified, in **one transaction**. Does **not** log the user in. |
| Verification token | Same format; lifetime `EMAIL_VERIFICATION_TOKEN_TTL_SECONDS` (default **24 h**). Single use; a resend supersedes the previous link. |
| Verification state | `users.email_verified_at` (NULL = not verified). **Not enforced**: login, refresh, bookings and every other endpoint behave the same for verified and unverified accounts. |
| Cooldown | At most one e-mail of each kind per account per `AUTH_EMAIL_COOLDOWN_SECONDS` (default 60), counted from the last still-usable link. Forgot-password absorbs repeats silently; resend returns `429`. |
| Delivery failure | If the transport does not accept the e-mail (SMTP error, or `MAIL_TRANSPORT=disabled`), the link nobody received is **revoked**, so the user can retry immediately (no cooldown). The failure is logged with category, masked recipient, transport and server reply, never the content. |
| Suspension | Suspension revokes every session **and every outstanding reset/verification link** in one transaction (user → sessions → tokens). Revocation is final: reactivation does not revive old links; the user requests new ones. Suspended accounts get no new links, and use of any link is refused (`400`). Change password is refused (`401`). |

## 2. Endpoints

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/auth/change-password` | bearer | `{ currentPassword, newPassword }` | `204` — all sessions revoked | 400 validation / `Current password is incorrect` / `New password must be different from the current password`; 401 token invalid or account inactive; 409 password changed concurrently |
| POST | `/auth/forgot-password` | public | `{ email }` | `202 { message }` (identical for every address) | 400 not an e-mail |
| POST | `/auth/reset-password` | public | `{ token, newPassword }` | `204` — all sessions revoked, not logged in | 400 validation / `Invalid or expired password reset token` (unknown, expired, used, superseded, or account inactive — indistinguishable) |
| POST | `/auth/verify-email` | public | `{ token }` | `200 { emailVerified: true, emailVerifiedAt }` | 400 malformed / `Invalid or expired verification token` (same causes) |
| POST | `/auth/verify-email/resend` | bearer | — | `202 { message, expiresAt }` (e-mail queued, not yet delivered) | 401; 409 already verified; 429 `{ retryAfterSeconds }` |

Additive response fields (existing fields unchanged):

- `POST /auth/register|login|refresh` → `user.emailVerified` (boolean) and `user.emailVerifiedAt` (ISO date or null).
- `GET /auth/me` → `user.emailVerified`, `user.emailVerifiedAt`.

No response contains a token, a token hash, a password hash or session internals.

## 3. Frontend integration

E-mailed links put the token in the **URL fragment**, which browsers never send to servers or in `Referer`:

- `${FRONTEND_URL}/reset-password#token=<43 chars>`
- `${FRONTEND_URL}/verify-email#token=<43 chars>`

1. **Forgot password page**: `POST /auth/forgot-password { email }`, then always show "If an account exists for this address, we sent a link." Do not branch on anything in the response.
2. **Reset page** (`/reset-password`): read `token` from `location.hash`, remove it from the address bar (`history.replaceState`), ask for the new password (8–72 chars), `POST /auth/reset-password`. On `204`, drop any stored tokens and send the user to login. On `400` with `Invalid or expired password reset token`, offer "request a new link".
3. **Change password** (settings): `POST /auth/change-password`. On `204`, clear the access and refresh tokens (they are already revoked) and redirect to login. `400` = wrong current password or policy violation, so show the message. Do **not** treat this `400` as an auth failure, and do not refresh on it.
4. **Verify page** (`/verify-email`): read `token` from the fragment, `POST /auth/verify-email` (works without login). `200` → "E-mail verified". `400` → "This link is invalid, expired or already used". If the user is logged in, offer resend.
5. **Verification banner**: show when `user.emailVerified === false` (from login/refresh/`/auth/me`). "Resend" → `POST /auth/verify-email/resend`; handle `429` using `retryAfterSeconds` and `409` (already verified, so refresh `/auth/me`).
6. Accounts created before P3-BE02 are `emailVerified: false`. Treat the banner as an optional prompt: nothing is blocked for them.

## 4. Configuration

| Variable | Default | Notes |
|---|---|---|
| `PASSWORD_RESET_TOKEN_TTL_SECONDS` | `1800` | reset link lifetime |
| `EMAIL_VERIFICATION_TOKEN_TTL_SECONDS` | `86400` | verification link lifetime |
| `AUTH_EMAIL_COOLDOWN_SECONDS` | `60` | per account and e-mail kind; `0` disables |
| `AUTH_RECOVERY_MIN_RESPONSE_MS` | `250` | minimum duration of `POST /auth/forgot-password` (enumeration safety); `0` disables |
| `MAIL_TRANSPORT` | `disabled` | `disabled` (nothing sent; startup warning; issued links are revoked at once, so recovery by e-mail is effectively off), `smtp`, `file` (dev/QA outbox containing live links; refused when `NODE_ENV=production`) |
| `MAIL_FROM` | `PawFlow <no-reply@pawflow.local>` | sender identity |
| `MAIL_LINK_BASE_URL` | `FRONTEND_URL` | base of e-mailed links |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD` | — | environment only, never committed. Validated at startup: missing `SMTP_HOST`, a port outside 1–65535, or `SMTP_USER` without `SMTP_PASSWORD` stop the app with an error naming the variable (not its value). |
| `MAIL_OUTBOX_DIR` | — | required for `file` |

## 5. Database

Migration `AddAccountRecovery1794690000000` (additive, forward-only):

- `users.email_verified_at timestamptz NULL`. **Existing accounts are not backfilled** and stay unverified; since nothing enforces verification, their login, sessions and bookings are unaffected, and no session is revoked by the migration.
- `auth_user_tokens` (`user_id` → `users` ON DELETE CASCADE, `purpose` ∈ {`PASSWORD_RESET`, `EMAIL_VERIFICATION`}, unique hex `token_hash`, `created_at`, `expires_at` > `created_at`, `consumed_at`, `revoked_at`, never both). Partial unique index `uq_auth_user_tokens_active (user_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL` = at most one usable link per account and purpose.
- `auth_sessions.revoked_reason` additionally accepts `PASSWORD_CHANGED`, `PASSWORD_RESET`.
- `down`: drops the table and column (outstanding links and verification state are lost) and rewrites `PASSWORD_*` revoke reasons to `LOGOUT_ALL` before restoring the P3-BE01 CHECK.

Cleanup: when a new link is issued, the account's consumed/revoked/expired links of that purpose older than 7 days are deleted. Dormant rows can be purged with
`DELETE FROM auth_user_tokens WHERE (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '7 days';`.

**Locking.** Every P3-BE02 write takes the user row `FOR UPDATE` first, then sessions, then one-time tokens (user → sessions → tokens). Refresh and login lock the user `FOR SHARE` first, and suspension `FOR UPDATE`, so all paths serialize on the user row and cannot deadlock. bcrypt runs before the transaction; the state it was computed against is re-checked under the lock:

- change password: account ACTIVE, request session still live, password hash unchanged (else `409`);
- reset / verify: token still usable, account ACTIVE;
- **login (P3-BE01 change)**: the hash verified by bcrypt must still be the stored hash when the session is created, so a login with the old password that races a password change or reset cannot open a session.

## 6. E-mail delivery semantics

- **Acceptance is durable, delivery is best-effort.** The 202 is sent after the token commit. The e-mail is handed to the transport afterwards, in-process; "accepted" in the logs means the SMTP server (or outbox) took the message, not that it reached the inbox.
- **Transport rejection / disabled:** link revoked, failure logged, immediate retry possible.
- **Crash window (accepted trade-off):** if the process dies after the commit and before the transport accepts the message, the e-mail is lost while the link stays usable but undelivered. A retry within the cooldown (60 s) sends nothing. After the cooldown, a new request supersedes the link and works. Nobody holds the lost link, so it is not a security exposure; it expires after 30 min / 24 h. Closing this window would need a persistent outbox with retry (not implemented).
- Registration: the first verification e-mail is issued after the registration commits, in the background. If that is lost, no usable link exists and `resend` works immediately.
- Graceful shutdown (`SIGTERM`, `enableShutdownHooks`) drains queued e-mails in `beforeApplicationShutdown`, while the database is still open.

## 7. Development deployment order

The new build selects `users.email_verified_at`: **run the migration before starting the new build**. Against the unmigrated schema it fails login/register with `500 column user.email_verified_at does not exist` (verified on a copy of `pet_care_db`). The P3-BE01 build keeps working on the migrated schema (verified), so migrating first is safe. Set `MAIL_TRANSPORT=file` with a git-ignored `MAIL_OUTBOX_DIR` in development to see links; with the default `disabled` no recovery e-mail is ever usable.

## 8. Tests

`npm test` runs every unit spec (repository config: `jest.config.ts` + `tsconfig.spec.json` + `test/jest/esm-node-modules.transform.cjs`, which down-levels ESM-only packages such as NestJS 12 for Jest on Node 22). `npm run test:e2e` (Nest scaffold spec) is unchanged and still fails with TS5011; it boots `AppModule` with the repository `.env`, i.e. against `pet_care_db`, and was deliberately left out of scope.

## 9. Known limits and deferred decisions

- **No live e-mail delivery has been verified.** The SMTP transport was exercised end to end only against a local SMTP protocol stub in QA (accept / reject / hang). No message has been sent to a real mail server or inbox.
- No persistent outbox/retry (see the crash window above).
- Anti-abuse is per account (cooldown + one usable link). There is no per-IP rate limiting or CAPTCHA on `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email` or `/auth/login`; this is deferred to P3-BE03 / security hardening. Unknown addresses cost one indexed query.
- Wrong current passwords on `/auth/change-password` are not rate-limited (bcrypt slows guessing; an access token is required).
- **Policy decision pending:** whether verification becomes mandatory (before login, booking, or provider onboarding), and how to handle the existing unverified accounts if so. Until decided, nothing is enforced.
- No "your password was changed" notification e-mail.
- Changing the e-mail address is not supported. If added, it must revoke outstanding verification links and reset `email_verified_at`.
- The response-time floor masks the extra transaction only while it is faster than the floor (250 ms). Under heavy database latency, the difference can become observable.
