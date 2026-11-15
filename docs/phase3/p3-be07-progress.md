# P3-BE07 — Progress / Session Handoff

| Subtask | Scope | Status |
|---|---|---|
| **BE07-01** | Preference policy and API contract (audit + design only) | **DONE (2026-11-09)**. The repository prerequisite was later resolved by the approved fast-forward to `e06c6c8` (see "Git baseline"). |
| **BE07-02** | Preferences table, entity, migration, `GET` / `PATCH /notification-preferences`, internal consent service | **PASS (2026-11-09)**. Not committed; migration not applied to `pet_care_db`. |
| **BE07-03** | Dispatcher gate + `SUPPRESSED` outcome + QA | **PASS (2026-11-09)**. Not committed. See `p3-be07-dispatch-integration.md`. |
| **BE07-04A** | Full regression, migration rehearsal, compatibility matrix, runbook, FE handoff | **PASS (2026-11-09)**. `pet_care_db` untouched. See `p3-be07-validation.md`. |
| BE07-04B | Development deployment (migration 16/16 + smoke) | NOT STARTED. Requires explicit approval; runbook `pawflow-db-backups/p3be07/RUNBOOK.md`. |

## BE07-01

Deliverable: [p3-be07-preferences-contract.md](p3-be07-preferences-contract.md).

No code, migration, Firebase, frontend or database change. Nothing committed.

### Repository finding (blocking for BE07-02)

| Ref | Commit | Has P3-BE04 to BE06? |
|---|---|---|
| Working branch `feature/notification-preferences` (local) | `a66a59f` (fast-forwarded to `origin/dev`) | **No** |
| `origin/feature/notification-preferences` | `38c97ad` | No |
| `origin/dev` (confirmed with `git ls-remote`) | `a66a59f` | **No** |
| `origin/feature/notification-inbox` | `e06c6c8` | **Yes** |

- BE06 is pushed but **not merged into `dev`**.
- The audit was done read-only against `e06c6c8`, the code deployed to `pet_care_db` (15 migrations).
- A backend built from this branch must not be run against `pet_care_db`: its code is behind the database schema.

### Decisions (approved by the user 2026-11-09; contract §10)

1. **One global per-user `pushEnabled`;** no per-type settings yet.
2. **Explicit opt-in:** default `false` for new and existing users. No backfill: a missing row means the default.
3. **Authority:** the stored preference is the consent; a device registration never is. Delivery requires system mode + preference (including `created_at >= push_enabled_at`) + P3-BE05 device eligibility.
4. **Opt-out** does not revoke devices or touch the inbox. **Opt-in** is not retroactive.
5. **Table:** `notification_preferences (user_id PK FK→users CASCADE, push_enabled bool default false, push_enabled_at timestamptz null, created_at, updated_at, CHECK push_enabled = (push_enabled_at IS NOT NULL))`, written by a single-statement upsert.
6. **API:** `GET` / `PATCH /api/notification-preferences` (caller only; body `{ pushEnabled: boolean }`; response `{ pushEnabled, pushEnabledAt, pushAvailable, updatedAt }`; 200 / 400 / 401; idempotent).
7. **Dispatcher:** gate at attempt start and before each device send. New outcome `SUPPRESSED` → DONE `PUSH_OPTED_OUT`. Enqueue, leases and retries unchanged. Pushes already handed to Firebase cannot be recalled and may still arrive after an opt-out; no bound is claimed. No new send starts after the opt-out is visible.

### Prerequisites for BE07-02

1. **Git baseline (audited 2026-11-09 after `git fetch origin --prune`):**
   - `origin/dev = a66a59f`; BE04–BE06 exist **only** on `origin/feature/notification-inbox = e06c6c8`, as 4 linear commits on top of `a66a59f`. They are not merged anywhere and there are no duplicates.
   - **Recovery** (approval needed; not executed):

     ```bash
     git merge --ff-only origin/feature/notification-inbox
     ```

     Run on `feature/notification-preferences`. It fast-forwards to `e06c6c8`, creates no commit, and leaves the untracked BE07 docs untouched (no path collision).
   - **Later, the user via GitHub:** a PR `feature/notification-inbox → dev` merged with "Create a merge commit". Not squash or rebase, which would duplicate the four commits under new SHAs.
   - Verify afterwards: `src/notifications`, `src/push-devices`, `src/push-delivery` and 15 migration files are present.
   - Docs snapshot: `D:/ARGGGG/THESIS/pawflow-db-backups/p3be07/docs-snapshot-20261109-215455/` (SHA-256 verified).
2. ~~Confirm the open questions~~ Done: the product decisions are approved (contract §10).
3. BE07-02 migration timestamp after `1796500000000`; QA on disposable databases only; `pet_care_db` untouched until a separately approved deployment.

### Next subtask (after BE07-01)

**BE07-02.** Done; see below.

## Git baseline (resolved 2026-11-09)

- With user approval, `feature/notification-preferences` was fast-forwarded (`--ff-only`) from `a66a59f` to `e06c6c8`. No commit was created; the BE07-01 docs were preserved.
- Still pending, by the user: a PR `feature/notification-inbox → dev`, merged with "Create a merge commit".

## BE07-02 (PASS)

Details: contract §11 (implementation record). The §5 `pushAvailable` definition and the §6.3 update SQL were updated to match the implementation.

### Files

- **New:**
  - `src/notification-preferences/`: entity, DTO, service, controller, module, spec;
  - `src/database/migrations/1797000000000-CreateNotificationPreferences.ts`;
  - `test/qa/notification-preferences.cjs`.
- **Modified:**
  - `src/app.module.ts`: registers `NotificationPreferencesModule`;
  - `package.json`: script `qa:notification-preferences`;
  - `test/qa/push-outbox.cjs`, `test/qa/push-dispatch.cjs`: migration rehearsals made version-agnostic (see below);
  - the two BE07 docs.
- **Unchanged:** dispatcher, worker, executor, booking events, outbox, inbox, device lifecycle.

### Decisions as built

1. **Table** `notification_preferences` (PK `user_id`, FK → users ON DELETE CASCADE, CHECK `push_enabled = (push_enabled_at IS NOT NULL)`). No backfill; a missing row is OFF.
2. **Writes:** two conditional atomic statements (enable: `ON CONFLICT … WHERE NOT push_enabled`; disable: `UPDATE … WHERE push_enabled`), each followed by a fresh read.
   - Repeated requests write nothing; `updatedAt` reflects only real changes.
   - Concurrent requests: last write applied by PostgreSQL wins.
3. **Timestamps** are PostgreSQL `now()`, the same clock as `notifications.created_at`. **BE07-03 rule:** `created_at >= push_enabled_at` (inclusive). A notification whose transaction started before the opt-in is treated as pre-consent.
4. **`pushAvailable` = firebase mode AND worker enabled.** Mock / disabled / worker off give false. The value is per instance (caveat in contract §11.4).
5. **Internal API for BE07-03:** `NotificationPreferencesService.getPushConsentForDelivery(userId) → { optedIn, optedInSince }` (fresh read).

### Verification

| Check | Result |
|---|---|
| tsc | clean |
| lint | 0 errors (1 pre-existing warning) |
| build | OK |
| Focused Jest (preferences, notifications, push-devices, push-delivery) | 7 suites, 217/217 (preferences spec 24/24) |
| `qa:notification-preferences` | **30/30**, final run after the fixes below |
| `qa:push-outbox` | 28/28 |
| `qa:push-dispatch` | 38/38 |
| `qa:notifications` | 43/43 |
| `qa:push-devices` | 49/49 |
| `qa:push-pipeline` | 18/18 |

- **Run conditions:** sequential; no QA database left behind (only the old `pawflow_qa_push_delivery` remains); `pet_care_db` untouched (15 migrations, no preferences table).
- **QA corrections during development** (test code only, no product change):
  - a `?? 'missing'` on a nullable `revoked_at` reported an **active** device as missing. Fixed by distinguishing "no row" from "not revoked".
  - `push-outbox` and `push-dispatch` assumed `CreateNotificationDeliveries` is the newest migration (`at(-1)` and a single `undoLastMigration`). With a newer migration they would have reverted the wrong one. They now revert down to and including their own migration and re-apply, the pattern the other suites already used. Their assertions are unchanged in strength. The new preferences suite uses the same pattern.

### Remaining dependencies

- **BE07-03 (dispatcher gate):**
  - call `getPushConsentForDelivery` at attempt start (with the notification's `created_at` read in the executor's existing SELECT) and before each device send;
  - add the outcome `SUPPRESSED` → DONE `PUSH_OPTED_OUT` (contract §4);
  - **existing BE06 QA suites must opt their test recipients in during setup** (expected setup change, not an assertion change).
- **Deployment:** `1797000000000` is not applied to `pet_care_db`. It needs a separately approved backup + migration, like BE06-08.
- **Git:** BE06 still has to reach `dev` (PR above). Nothing from BE07 is committed.

### Next subtask (after BE07-02)

BE07-03 (done; see below).

## BE07-03 (PASS)

**Full record:** `p3-be07-dispatch-integration.md`.

### What was built

- **Consent read:** `NotificationPreferencesService.getPushConsentForNotification(userId, notificationId)`.
  - One SQL statement; the epoch comparison is done in PostgreSQL at µs precision.
  - Missing row = OFF.
  - Returns `null` when the notification is gone.
  - Throws on DB error.
- **`PushDispatchExecutor` gates:**
  - **A**: at attempt start, after the notification is loaded;
  - **B**: before every device send, ahead of the P3-BE05 eligibility, lease, deadline and abort checks;
  - every read is bounded at 5 s.
- **New outcome** `SUPPRESSED` → DONE `PUSH_OPTED_OUT` / `pawflow/push-opted-out`. Terminal; never retried or reopened.
- **Fail closed:** a consent error or timeout gives `RETRY TRANSIENT pawflow/consent-unavailable`.
  - No send; job stays `PENDING`.
  - Existing backoff, max attempts and `expires_at` apply.
  - Finalized device rows are kept.
- **Wiring:** `PushDeliveryModule` imports `NotificationPreferencesModule`.
- **No change to:** booking, inbox, device lifecycle, the provider, the worker, the retry engine, or the migrations (the pending `1797000000000` is unchanged).
- **BE06 QA fixtures** now opt recipients in during setup (via the API, before their notifications exist). Assertions are unchanged; there is no bypass.
- `getPushConsentForDelivery` (BE07-02) stays but is not used by the dispatcher (millisecond-precision caveat).

### Verification

| Check | Result |
|---|---|
| Focused Jest (push-delivery, preferences, notifications, push-devices) | 8 suites, 230/230 |
| `qa:push-consent` (new) | **30/30** |
| `qa:notification-preferences` | 30/30 |
| `qa:push-dispatch` | 38/38 |
| `qa:push-pipeline` | 18/18 |
| `qa:push-worker` | 33/33 |
| `qa:push-outbox` | 28/28 |
| `qa:booking-events` | 32/32 |
| `qa:notifications` | 43/43 |
| `qa:push-devices` | 49/49 |
| tsc / build | clean / OK |
| lint | exit 0, 1 pre-existing warning |

- **Run conditions:** sequential, disposable DBs, mock provider only.
- **After the runs:** only `pawflow_qa_push_delivery` remains; `pet_care_db` untouched (15 migrations, no preferences table).

### Remaining for BE07-04

- Full regression across all QA suites (including auth, account recovery, bot protection, demo seed, FE smoke).
- Failure injection on the combined pipeline. Review retention / volume of `SUPPRESSED` jobs, since opted-out users still get a job (contract §4.5).
- Frontend handoff check (contract §7): the settings UI and `pushAvailable`.
- **Deployment:** applying `1797000000000` to `pet_care_db` needs a separately approved backup + migration. **Required:** after deployment, every existing user is OFF until they opt in, so existing push recipients stop receiving pushes until they opt in.
- **Git:** nothing from BE07 is committed. BE06 → `dev` PR still pending.

### Next subtask (after BE07-03)

BE07-04A (done; see below).

## BE07-04A (PASS)

**Full record:** `p3-be07-validation.md`.

### Source and Git

- **Source:** HEAD `e06c6c8` + uncommitted BE07 tree; fingerprint aggregate `a2ec319b…d5115` (294 files).
- **Git:** `origin/dev` (`a66a59f`) still lacks BE04–BE06 (4 commits). Merge the inbox PR with a merge commit before opening a BE07 PR. Unresolved; the user decides.

### Results

| Check | Result |
|---|---|
| Static | tsc 0, lint 0 (1 pre-existing warning), build 0 |
| Full Jest | **55 suites / 1586 tests**, exit 0 |
| PostgreSQL QA, 14 required suites | **628/628**. 9 reused from BE07-03 (same source, proven by mtimes); 5 run fresh: auth-sessions 55, account-recovery 91, bot-protection 40, fe-smoke 31, mvp-e2e 110 |
| Not run | `qa:demo-seed` (seeder); `test:e2e` (boots `AppModule` against `.env` = `pet_care_db`) |
| Dev preflight (read-only) | `pet_care_db`, PG 15.18, 15 applied + exactly 1 pending, 25 tables, no preferences objects, 0 connections, push unset |
| Rehearsal on dump copies (SHA-256 `41fc9965…5349`) | up 16/0 (data identical except the migrations row + empty new table; schema additions only; entities in sync); down → data and schema identical; re-apply 16/0 |
| Compatibility | BE06 build works on both schemas (push disabled); **BE06 build with push enabled ignores consent**; BE07 build on the old schema → preference API 500, push fail-closed; BE07 / BE07 all OK |
| Deployment smoke rehearsal | 13/13 |
| Cleanup | all disposable copies dropped; only `pawflow_qa_push_delivery` remains; `pet_care_db` data and schema unchanged |

### Deliverables

- `docs/phase3/p3-be07-validation.md`
- `docs/phase3/p3-be07-frontend-handoff.md`
- `pawflow-db-backups/p3be07/RUNBOOK.md`
- `pawflow-db-backups/p3be07/exec/be07-smoke.cjs`
- rehearsal evidence in `pawflow-db-backups/p3be07/{preflight,rehearsal,validation}/`
- contract §8 failure-mode bullet corrected to match the BE07-03 implementation

### Deployment order

1. Migrate.
2. Start the BE07 build with push disabled.
3. Never run a BE06 build with push enabled after the migration.

### Retention

The proposed policy (DONE 30 d, FAILED / EXPIRED 90 d) is supported by the schema. It is recommended as a separate future cleanup task (validation §9). Not implemented.

### Next subtask

**BE07-04B (development deployment).** Only after explicit approval.
