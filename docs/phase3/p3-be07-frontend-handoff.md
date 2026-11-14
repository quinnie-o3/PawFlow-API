# P3-BE07 — Frontend Handoff: Push Notification Preference

**Audience:** frontend (settings UI, FE-048).

**Backend status:** implemented and validated (BE07-04A). The endpoint exists in an environment only after migration `1797000000000` has been applied there (see the deployment runbook). Policy background: `p3-be07-preferences-contract.md`.

## 1. Endpoints

Both endpoints:

- require `Authorization: Bearer <accessToken>` with a live session (any role);
- act on the caller only. There is no user id in the path or body, and unknown fields are rejected.

### `GET /api/notification-preferences`

Read-only; it never creates anything. Response `200`:

```json
{ "pushEnabled": false, "pushEnabledAt": null, "pushAvailable": false, "updatedAt": null }
```

| Field | Meaning |
|---|---|
| `pushEnabled` | Stored consent. **Defaults to `false`** for every account, including existing ones, until the user opts in. |
| `pushEnabledAt` | ISO time the current opt-in period started; `null` while off. Only notifications created after it are pushed. |
| `pushAvailable` | Whether *this* backend instance delivers real push (Firebase mode and worker enabled). Informational; independent of `pushEnabled`. |
| `updatedAt` | Last real change; `null` if never changed. |

### `PATCH /api/notification-preferences`

Request body: `{ "pushEnabled": true }` or `{ "pushEnabled": false }`. It must be a JSON boolean; `"true"` (a string), `1` and `null` are rejected.

- Response `200`: the same shape as GET, showing the state after the request.
- Idempotent:
  - repeating `true` keeps the original `pushEnabledAt`;
  - repeating `false` changes nothing.
- Concurrent requests: the last one applied wins. Re-read with GET if you need certainty.

### Errors

| Status | When | UI |
|---|---|---|
| 400 | `pushEnabled` missing or not a boolean, or extra properties | Bug in the client; keep the toggle unchanged |
| 401 | Token missing, expired or revoked (logout, logout-all, password change, suspended account) | Usual refresh-then-login flow |
| 5xx / network | Server problem | Revert the toggle to the last confirmed state and show "could not save". Do not assume the change was applied. |

## 2. Opt-in flow (toggle ON)

1. Feature detection: `'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window`, and Firebase messaging `isSupported()`.
   - Not supported → show the toggle disabled ("not supported in this browser").
   - Do **not** PATCH.
2. `Notification.requestPermission()`.
   - `granted` → continue.
   - `denied` / `default` → do **not** PATCH `true`. Show "blocked in browser settings".
3. `PATCH { pushEnabled: true }` and render the response.
4. Register the device (BE05 handoff, `fcm-device-lifecycle.md`): `POST /api/push-devices`.
   - Order of steps 3 and 4 does not matter to the backend: consent and devices are independent.
   - Opting in with no device is valid. Nothing is delivered until a device is registered.

**What the user receives:** only notifications created **after** `pushEnabledAt`. Older notifications are never pushed after opting in; they are in the inbox.

## 3. Opt-out flow (toggle OFF)

1. `PATCH { pushEnabled: false }`.
2. Optionally unregister the local FCM token. The backend does not require revoking the device; the registration is kept, but nothing is sent to it while the preference is OFF.
3. Tell the user that a push already on its way may still arrive shortly. The backend stops starting new sends immediately but cannot recall messages already handed to Firebase.

## 4. Other situations

| Situation | Frontend behaviour |
|---|---|
| `pushAvailable: false` (development, push disabled) | The preference can still be read and changed. Show the toggle with a note "push notifications are not active in this environment", or hide it. Do not treat it as an error. |
| Browser permission revoked later | On start-up, if `Notification.permission !== 'granted'`: `DELETE /api/push-devices/:id` for the current device (`GET /api/push-devices`, `current: true`). Do **not** change the preference automatically; show the mismatch. |
| Account switching on the same browser | Log out (this revokes the device server-side). After the next login, GET **that** account's preference. Never reuse the previous account's toggle state; a new account is OFF even if the browser permission is already granted. |
| Inbox and badge | Unchanged and independent of push. Keep using `GET /api/notifications` and `/unread-count` (polling) whether push is on or off. |
| Multiple tabs | Each tab should re-GET on focus; there is no server push of preference changes. |

## 5. Do not

- Send a user id.
- Treat `pushAvailable` as the user's choice.
- PATCH `true` without browser permission.
- Hide inbox notifications when push is off.
