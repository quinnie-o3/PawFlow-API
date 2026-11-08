# PawFlow — Auth Sessions (P3-BE01)

Short-lived access tokens, rotatable refresh sessions with reuse detection, logout / logout-all and a session list.
Verified by `npm run test` (unit) and `npm run qa:auth-sessions` (real HTTP + PostgreSQL, 48 checks).
Source: `src/auth/auth.controller.ts`, `src/auth/auth.service.ts`, `src/auth/strategies/jwt.strategy.ts`, `src/auth/auth-session.util.ts`, migration `1794103044835-CreateAuthSessions`.

## 1. Model

| Concept | Rule |
|---|---|
| Session | One per login/registration (one per device). Absolute lifetime `REFRESH_SESSION_TTL_SECONDS` (default 30 days); refreshing does **not** extend it. |
| Access token | JWT, `JWT_ACCESS_TOKEN_TTL_SECONDS` (default 900 s = 15 min), claims `sub`, `email`, `role`, `sid` (session id). Every request re-checks the session: revoked/expired session or non-ACTIVE user → `401` immediately, not at token expiry. Tokens without `sid` (issued before P3-BE01) are rejected. |
| Refresh token | Opaque 43-character string, **single use**. Only its SHA-256 hash is stored. Each refresh returns a new pair; the old refresh token is consumed. |
| Reuse detection | Presenting an already used refresh token revokes the **whole session** (`REUSE_DETECTED`) and returns `401`; every token of that session, including the newest pair, stops working. An unknown token returns `401` and revokes nothing. |
| Suspension | Admin suspension revokes all of the user's sessions in the same transaction (`ACCOUNT_SUSPENDED`); a suspended user cannot log in or refresh. Reactivation does not restore old sessions. |

## 2. Endpoints

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/auth/register` | public | unchanged | `201` auth response | 400, 409 |
| POST | `/auth/login` | public | unchanged | `200` auth response (new session) | 400, 401 (`Invalid email or password`, `Account is not active`) |
| POST | `/auth/refresh` | **none** (access token may be expired) | `{ refreshToken }` | `200` auth response (same session, new pair) | 400 malformed, 401 unknown / expired / revoked / reuse / inactive account |
| POST | `/auth/logout` | bearer | — | `204` (current session revoked) | 401 |
| POST | `/auth/logout-all` | bearer | — | `204` (all sessions revoked, including the current one) | 401 |
| GET | `/auth/sessions` | bearer | — | `200` session[] | 401 |
| DELETE | `/auth/sessions/:id` | bearer | — | `204` (own session revoked; no-op if already revoked) | 400 non-UUID, 401, 404 not mine |
| GET | `/auth/me` | bearer | — | `200 { user }` (unchanged) | 401 |

Auth response (register, login, refresh) — the previous fields are unchanged, four are added:

```json
{
  "accessToken": "<jwt>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshToken": "q3Jx0Yb3m1v8bZ9mVY6l2rT0cXyQ4n2hX1f7uW5kPZs",
  "refreshTokenExpiresAt": "2026-12-08T02:15:44.120Z",
  "user": { "id": "6", "fullName": "…", "email": "…", "phone": null, "role": "CUSTOMER", "status": "ACTIVE", "createdAt": "…", "updatedAt": "…" }
}
```

Session list item (`GET /auth/sessions`, most recently used first; only active sessions):

```json
{ "id": "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", "createdAt": "…", "lastUsedAt": "…", "expiresAt": "…",
  "userAgent": "Mozilla/5.0 …", "ipAddress": "::1", "current": true }
```

## 3. Frontend integration

1. Keep the access token in memory; keep the refresh token in the most protected storage available. It is returned in the JSON body (no cookie), so an XSS bug can read it if it is put in `localStorage`.
2. Send `Authorization: Bearer <accessToken>`. On `401` from an API call, refresh **once**, retry the call with the new access token; if the refresh also fails, clear tokens and go to login.
3. **Single-flight refresh:** only one `POST /auth/refresh` may be in flight per client. Two tabs or two parallel requests refreshing with the same token look like token theft and revoke the session. Share one in-progress refresh promise inside a tab, and coordinate tabs (e.g. a `BroadcastChannel`/storage lock) or accept that the second tab must log in again.
4. Always replace the stored refresh token with the one from the latest response; never retry `/auth/refresh` with a token that already succeeded.
5. Logout: call `POST /auth/logout` (or `/auth/logout-all` for "sign out everywhere"), then drop both tokens. When switching accounts, log out first so the previous user's tokens are revoked server-side.
6. Session management screen: `GET /auth/sessions` and `DELETE /auth/sessions/:id`; `current: true` marks this device.

## 4. Configuration

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | — (required) | unchanged |
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | `900` | access-token lifetime |
| `REFRESH_SESSION_TTL_SECONDS` | `2592000` | absolute session lifetime |
| `JWT_EXPIRES_IN_SECONDS` | — | **no longer used** (was the 1-day single-token lifetime) |

## 5. Database

Migration `CreateAuthSessions1794103044835` adds `auth_sessions` (uuid PK, `user_id` → `users` ON DELETE CASCADE, `expires_at`, `revoked_at` + `revoked_reason` with CHECKs, `user_agent`, `ip_address`, `last_used_at`) and `auth_refresh_tokens` (`session_id` → `auth_sessions` ON DELETE CASCADE, unique `token_hash`, `used_at`). It is additive; `down` drops both tables (all sessions are lost, users must log in again).

Lock order: token refresh takes user `FOR SHARE` → session `FOR UPDATE` → token `FOR UPDATE`; login re-checks the user `FOR SHARE` before creating the session; suspension takes user `FOR UPDATE` → updates sessions. Same order everywhere, so these paths cannot deadlock, and a suspension that commits first is always seen.

## 6. Known limits

- Expired and revoked rows are not purged (no cleanup job yet); session count per user is not capped.
- No rate limiting on `/auth/login` and `/auth/refresh` (brute force is only slowed by bcrypt).
- No password-change / reset flow exists yet; when added it must call `revokeUserSessions(…)`.
- `ipAddress` is `request.ip` (no proxy trust configured).
