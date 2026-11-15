# P3-BE07-04A — Full Regression, Migration Rehearsal & Deployment Readiness

**Date:** 2026-11-09.

**Scope:** validation of the complete BE07 working tree (BE07-01..03). **Nothing was applied to `pet_care_db`**; it was only read (queries, `pg_dump`). Its data (25 tables) and schema were verified unchanged at the end.

**Evidence root:** `D:\ARGGGG\THESIS\pawflow-db-backups\p3be07\` (`validation/`, `preflight/`, `rehearsal/`, `RUNBOOK.md`, `exec/be07-smoke.cjs`).

## 1. Source baseline

| Item | Value |
|---|---|
| Branch | `feature/notification-preferences` (upstream `origin/feature/notification-preferences` = `38c97ad`, an ancestor; fast-forward possible) |
| HEAD | `e06c6c84fa0b9746b478ad79da1892b3944fe9c2` |
| Working tree | 11 modified + 8 untracked paths (BE07-02/03 code, migration, specs, QA, docs). Nothing committed. |
| Source fingerprint | `validation/source-fingerprint.txt`: SHA-256 (CRLF-normalised) of each of 294 files (`src/`, `test/`, `package*.json`, `tsconfig*.json`, `nest-cli.json`; tracked + untracked). **Aggregate `a2ec319b0b24e6df58b75e039737bee8c6da291825d3cd5ceca4b2fced0d5115`.** |
| Migrations | 16 files. Old 15 unchanged versus `e06c6c8` (`git diff --stat` empty). New: `1797000000000-CreateNotificationPreferences.ts`. |

### Git integration (no Git operation performed except `git fetch`)

**`origin/dev` = `a66a59f`** does **not** contain the BE04–BE06 commits. `origin/dev..HEAD`:

- `425daf5` (BE04 inbox)
- `a135ed7` (BE05 devices)
- `90b0012` (BE06)
- `e06c6c8` (BE06)

`origin/feature/notification-inbox` = `e06c6c8`; its PR to `dev` is still pending (`gh` is not installed here, so the PR state was not queried).

**Dependencies:** the BE07 branch contains everything it needs; BE07 sits on top of `e06c6c8`.

**Risk:**

- **Merge the inbox PR with a *merge commit* (not squash/rebase) before BE07.** Then a BE07 PR to `dev` contains only BE07.
- If the inbox PR is squash- or rebase-merged, the BE07 branch would carry the original 4 commits again (duplicate content under different SHAs, likely conflicts) and would need a rebase onto `dev`. That requires approval.
- If BE07 were merged into `dev` first, it would bring BE04–BE06 with it (no missing dependency, but the inbox PR becomes redundant).

**This is an unresolved integration item for the user, not a blocker for the development deployment.**

## 2. Static verification (current source)

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` (no `typecheck` script exists) | 0 | clean |
| `npm run lint` (oxlint `src/ test/`) | 0 | 0 errors, 1 pre-existing warning (`test/qa/bot-protection.cjs:189`, `prefer-string-starts-ends-with`) |
| `npm run build` | 0 | OK |
| `npm test -- --ci` (full Jest) | 0 | **55/55 suites, 1586/1586 tests**, 0 snapshots, 20.8 s |

Logs: `validation/static.log`, `validation/jest-full.log`.

## 3. PostgreSQL QA matrix

- Every suite used its own disposable `pawflow_qa_*` database, ran sequentially (never concurrently), with the mock provider only and no Firebase.
- **Reuse rule:**
  - Suites 1–9 ran in BE07-03 on 2026-11-09 between 22:42 and 22:47.
  - The newest source file is from 22:42:02, before the first of those runs started (22:42:04). The current fingerprint covers that same source.
  - Their logs are archived in `validation/qa-be0703/`.
  - Suites 10–14 were run fresh in 04A (`validation/qa-be0704/`).

| # | Script | Checks | Exit | Run |
|---|---|---|---|---|
| 1 | `qa:push-consent` | 30/30 | 0 | BE07-03 (reused) |
| 2 | `qa:notification-preferences` | 30/30 | 0 | BE07-03 (reused) |
| 3 | `qa:push-dispatch` | 38/38 | 0 | BE07-03 (reused) |
| 4 | `qa:push-pipeline` | 18/18 | 0 | BE07-03 (reused) |
| 5 | `qa:push-worker` | 33/33 | 0 | BE07-03 (reused) |
| 6 | `qa:push-outbox` | 28/28 | 0 | BE07-03 (reused) |
| 7 | `qa:booking-events` | 32/32 | 0 | BE07-03 (reused) |
| 8 | `qa:notifications` | 43/43 | 0 | BE07-03 (reused) |
| 9 | `qa:push-devices` | 49/49 | 0 | BE07-03 (reused) |
| 10 | `qa:auth-sessions` | 55/55 | 0 | 04A |
| 11 | `qa:account-recovery` | 91/91 | 0 | 04A |
| 12 | `qa:bot-protection` | 40/40 | 0 | 04A |
| 13 | `qa:fe-smoke` | 31/31 | 0 | 04A |
| 14 | `qa:mvp-e2e` | 110/110 | 0 | 04A |
| | **Total** | **628/628** | | 0 failed, 0 skipped |

**Not run (by design):**

- `qa:demo-seed`: a data seeder, not a test. It leaves `pawflow_qa_demo` behind.
- `npm run test:e2e`: its Jest e2e config targets the `.env` database (`pet_care_db`), which is forbidden here.

**Mandatory invariants and where they are proven:**

| Invariant | Proven by |
|---|---|
| Inbox independent of push | notifications 43/43; push-consent (inbox keeps suppressed notifications); notification-preferences; rehearsal smoke #6 |
| Push OFF by default | push-consent #1 (missing row); smoke #3; compat case 3 (`defaultForNewUser`) |
| Opt-in/out API secure | notification-preferences 30/30 (validation, roles, 401 on revoked/suspended, no id route); smoke #4 |
| Current consent epoch enforced (µs boundary) | push-consent #5, #11, #13 |
| No push on consent-query failure | push-consent #15–#20 (DB down, missing table, timeout, mid-attempt failure) |
| Retry and lease fencing intact | push-worker 33/33; push-dispatch 38/38; push-consent #27 (stale lease + opt-out) |
| BE06 delivery semantics preserved | push-dispatch / pipeline / outbox / worker unchanged assertions (fixtures opt in only) |
| Account switching: no leakage | push-consent #22–#23, #29; push-devices 49/49 |
| Old-period jobs never reactivated | push-consent #10 (`claimed = 0` after re-enable), #5, #12 |
| Partial per-device results durable | push-consent #9, #10 (critical scenario `A:ACCEPTED@1` kept) |

## 4. Migration safety audit (`1797000000000-CreateNotificationPreferences`)

| # | Requirement | Finding |
|---|---|---|
| 1 | Follows the 15 migrations | Timestamp `1797000000000` > `1796500000000`; `migration:show` lists it as the only pending one. |
| 2 | Additive | `createTable` only. Schema diff on the copy: 34 added lines, **0 removed** (apart from the dump's random `\restrict` token). |
| 3 | No previous migration modified | `git diff --stat e06c6c8 -- src/database/migrations`: empty; the file is untracked/new. |
| 4 | No destructive change | No ALTER/DROP on existing objects; data baseline differs only in `migrations` (15 → 16) and the new empty table. |
| 5 | No backfill | `notification_preferences` has 0 rows after `up`. |
| 6 | Missing row = OFF | Service `COALESCE(..., false)`; smoke #3 / compat case 3 default `pushEnabled: false`. |
| 7 | PK / FK / CHECK / timestamps | `pk_notification_preferences(user_id)`; `fk_…_user → users(id) ON DELETE CASCADE`; CHECK `push_enabled = (push_enabled_at IS NOT NULL)`; `created_at` / `updated_at timestamptz NOT NULL DEFAULT now()`. Probed on a copy: 23514 for `push_enabled = true` without a timestamp, 23503 for an unknown user. |
| 8 | `down` removes only the new table | `DROP TABLE IF EXISTS "notification_preferences"`. Rehearsed: data identical (25 tables), schema identical (0 diff lines). |
| 9 | No ORM synchronize | `synchronize: false` in `app.module.ts` and `database/data-source.ts`; `schema:log` on the migrated copy reports "schema is up to date". |
| 10 | Existing data preserved | Baseline md5 of every table identical before and after `up`, and after `down`. |

**QA scripts that assume the newest migration:** none remain.

- `push-outbox` and `push-dispatch` were made version-agnostic in BE07-02.
- `notifications`, `push-devices`, `bot-protection` and `notification-preferences` use the `undoCount` pattern.
- `account-recovery` undoes `up.length` (everything it applied).
- No historical migration was edited.

## 5. Development database preflight (read-only)

`preflight/dev_identity.txt`, `preflight/migration_show_before.txt`, `preflight/baseline_dev.txt`, `preflight/schema_dev.sql`.

| Check | Result |
|---|---|
| Identity | `pet_care_db` @ `::1:5432` (`.env`: `DB_HOST=localhost`, `DB_USERNAME=postgres`), PostgreSQL **15.18**, session read-only |
| Applied migrations | **15** (official `migration:show`: 15 `[X]`) |
| Pending | exactly `[ ] CreateNotificationPreferences1797000000000` |
| Public tables | 25 |
| `notification_preferences` | absent; 0 conflicting relations; 0 conflicting constraints |
| Activity | 0 other connections; nothing listening on :8000 (backend stopped) |
| Rows (key tables) | users 23, notifications 20, push_devices 12, notification_deliveries 0, notification_push_sends 0, auth_sessions 32 |
| Configuration | `.env` has **no** `PUSH_*` / `FIREBASE_*` / `GOOGLE_APPLICATION_*` keys → push disabled, worker off by default |

**At the end of 04A:** `pet_care_db` data baseline identical to the preflight (all 25 tables), schema identical, 15 migrations.

## 6. Migration rehearsal

| Step | Result |
|---|---|
| Rehearsal dump | `rehearsal/pet_care_db_rehearsal-p3be07_20261109-230950.dump`, SHA-256 `41fc9965e7ec179e809916aa1144effd8a7dbe7cb7405af746649c361dc05349` (`sha256sum -c` OK). `pg_restore --list` readable (284 entries). **Rehearsal only; not the deployment backup.** |
| Restore | Into `pawflow_qa_devcopy_p3be07` and `…_rb` (`--exit-on-error`, exit 0). Both data baselines **identical to dev** (25 tables). |
| Override check | `DB_DATABASE=<copy>` + `dotenv/config` resolves to the copy (dotenv does not override existing variables). `migration:show` on the copy: 15 + 1 pending. |
| **Up** (official `npm run typeorm -- migration:run -d database/data-source.ts`) | Exit 0, 6.3 s (CLI start-up dominates), one transaction. Then 16 `[X]` / 0 `[ ]`. |
| Data after up | Only `migrations` 15 → 16 and `notification_preferences` 0 rows; the other 23 tables byte-identical (md5). |
| Schema after up | Additions only (table, PK, FK, CHECK). Entities match (`schema:log` up to date). |
| **Down** (copy `_rb`, after seeding 3 preference rows) | `migration:revert` exit 0 → `DROP TABLE IF EXISTS "notification_preferences"`. Data **identical** to pre-migration (25 tables), schema **identical** (0 lines). |
| **Re-apply** | Exit 0 → 16/0. Schema identical to copy A after up (0 lines). The 3 preference rows are gone: revert discards preferences, so everyone is back to OFF. |
| Deployment smoke rehearsal (copy `_smoke`, migrated, BE07 build, dev-like env with push vars unset) | `exec/be07-smoke.cjs` → **13/13**, 49 requests, 0 5xx, 0 deadlocks, no secrets in the log. The first run reported 12/13 because of a **smoke-script bug**: it hashed all bookings, including the one it creates. The script was fixed (only pre-existing bookings, rerunnable) and rerun: 13/13. Both runs are kept. |
| Cleanup | All 4 disposable copies (`pawflow_qa_devcopy_p3be07`, `_rb`, `_b6`, `_smoke`) dropped after name verification. Only the old `pawflow_qa_push_delivery` remains. |

## 7. Compatibility matrix (disposable copies of dev, no Firebase)

**Builds:**

- **BE06** = `e06c6c8`, built from `git archive` in a scratch directory (no branch switch).
- **BE07** = current working tree.

Probe: existing account (login, me, inbox, unread, bookings, refresh, device register) plus a disposable booking create + confirm, preference GET/PATCH, negative checks and logout. Results are in `rehearsal/c*.json` and `probe-*.log`.

| Case | Build / schema | Push | Result |
|---|---|---|---|
| 1 | BE06 / BE06 | disabled | All flows OK; preference routes 404; 0 jobs; 0 5xx |
| 2 | BE06 / BE07 | disabled | All flows OK; preference routes 404; 0 jobs; 0 5xx |
| 2b | BE06 / BE07 | mock + worker | Flows OK, **but consent is ignored**: the owner (never opted in) received `ACCEPTED@1`. |
| 3 | BE07 / BE07 | disabled | All OK. Preferences default OFF, `pushAvailable: false`; opt-in / opt-out 200; negatives 401/401/400/400; device kept after opt-out; 0 jobs; 0 5xx |
| 3b | BE07 / BE07 | mock + worker | Owner job `DONE/PUSH_OPTED_OUT`; opted-in customer `DONE` + `ACCEPTED@1`; `pushAvailable` false (mock is not real push) |
| 4 | BE07 / BE06 | disabled | Auth, inbox, bookings, devices, booking notifications **work**. **Preference GET/PATCH → HTTP 500** (`42P01 relation "notification_preferences" does not exist`). Validation and auth still reject first (401/400). |
| 4b | BE07 / BE06 | mock + worker | As case 4. Jobs `PENDING/TRANSIENT/pawflow/consent-unavailable`; **nothing sent** (fail closed); they would retry until the migration or `expires_at`. |

**Required deployment order:**

1. Migrate first.
2. Then start the BE07 build, with push still disabled.
3. A BE06 build is an acceptable fallback **only while push is disabled**.

## 8. Deployment configuration

- **Development stays push-disabled.** `.env` has no push variables, so `PUSH_DELIVERY_MODE` defaults to `disabled` and `PUSH_WORKER_ENABLED` to false. `.env` was not modified.
- **Logs** (cases 3 and 4, smoke rehearsal):
  - `Push provider: disabled`
  - `PUSH_DELIVERY_MODE=(not set) -> disabled: inbox only…`
  - `Push delivery worker disabled…`
- **No Firebase credentials** are required in disabled mode.
- **`pushAvailable` is false** in development, and also in mock mode, by design.
- **Preferences** GET/PATCH work after the migration with push disabled (case 3, smoke #3). The inbox is unchanged.
- **Per-instance `pushAvailable` limitation:** each process computes `pushAvailable` from its own environment (`firebase` mode **and** a worker enabled *in that process*). In a future multi-instance deployment where the API instances run with `PUSH_WORKER_ENABLED=false` and a separate worker instance delivers, the API would report `false` although push works. Before such a split, introduce a deployment-level flag (for example `PUSH_AVAILABLE` or a shared config value) and document it (contract §11.4).

## 9. Retention review (no cleanup implemented; no records deleted)

**Schema support:**

- `notification_deliveries.completed_at` with the partial index `idx_notification_deliveries_finished (completed_at) WHERE status IN ('DONE','FAILED','EXPIRED')`.
- `notification_push_sends.delivery_id → notification_deliveries ON DELETE CASCADE`, so per-device rows go with their job.
- The immutability trigger on `notification_push_sends` is `BEFORE UPDATE` only, so DELETE is allowed. The `notification_deliveries` guard covers INSERT and UPDATE only.
- `notification_deliveries.notification_id → notifications ON DELETE CASCADE`. Deleting jobs never touches the inbox.

**Privacy:** neither table stores message content, registration values or tokens.

- `notification_deliveries` holds ids, status, error category and code, and timestamps.
- `notification_push_sends` holds the device id, outcome, provider code, attempt and timestamps.

The privacy exposure is low; the main concern is growth. Every notification yields one job, including those of opted-out users (`PUSH_OPTED_OUT`), so job volume roughly equals notification volume.

**Referential caveat:** deleting a `push_devices` row (no purge exists today) cascades its send rows. Any future device purge must respect the same retention window if send history matters.

**Recommendation** (the proposed policy is supported as is):

| Status | Retention | Reason |
|---|---|---|
| `DONE` (delivered, `NO_DESTINATIONS`, `PUSH_OPTED_OUT`) | 30 days after `completed_at` | Enough for "why didn't I get a push?" support questions. |
| `FAILED` / `EXPIRED` | 90 days | Incident investigation (configuration, quota, outages). |
| `PENDING` / `PROCESSING` | never deleted | Active work. |

**Future cleanup task (separate ticket; not BE07):** a scheduled batch job on one instance with an advisory lock:

- `DELETE … WHERE id IN (SELECT id … WHERE status = … AND completed_at < now() - interval … ORDER BY completed_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
- loop until fewer than the batch size;
- log counts only;
- add a QA suite (boundary ages, cascade of send rows, active jobs untouched, inbox untouched).

## 10. Frontend handoff

`docs/phase3/p3-be07-frontend-handoff.md` covers:

- GET/PATCH contract, auth and errors;
- permission → PATCH → device ordering;
- opt-in and opt-out flows;
- unsupported browsers;
- `pushAvailable: false`;
- account switching;
- inbox independence.

## 11. Remaining risks and limitations

1. **In-flight sends cannot be recalled** (contract §4.4). No upper bound is claimed.
2. **BE06 build with push enabled bypasses consent** on the migrated schema. Never enable push on a BE06 build after the migration (runbook rule 3).
3. **Revert loses preferences** (everyone OFF). This is the safe default, but users must opt in again.
4. **Per-instance `pushAvailable`** (§8).
5. **Opted-out users still create jobs.** This is a volume concern only; retention ticket in §9.
6. **Git integration:** BE04–BE06 are not on `dev`; the merge method of the inbox PR matters (§1). BE07 is uncommitted.
7. **After deployment every existing account is OFF.** Users who previously expected push (none in development: push was never enabled) must opt in.

## 12. Verdict

**PASS. Ready to request approval for BE07-04B** (development deployment per `pawflow-db-backups/p3be07/RUNBOOK.md`).

- Full Jest 1586/1586.
- QA 628/628 across the 14 required suites.
- tsc, lint and build clean.
- Up / down / re-apply rehearsed with data and schema identical where expected.
- Compatibility matrix done and deployment order documented.
- Smoke rehearsed 13/13.
- `pet_care_db` untouched.

Open items for the user, not blockers:

- Git integration of BE04–BE06 into `dev` (§1);
- committing BE07 before or after deployment.
