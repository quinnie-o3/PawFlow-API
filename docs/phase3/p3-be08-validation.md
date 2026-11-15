# P3-BE08-04A — Full Regression, Migration-Chain Rehearsal & Deployment Readiness

Status: **validation complete (2026-11-14).** Nothing was committed or deployed, and `pet_care_db` was not modified.

- Evidence: `D:/ARGGGG/THESIS/pawflow-db-backups/p3be08/` (`validation/`, `preflight/`, `rehearsal/`).
- Runbook: `p3be08/RUNBOOK.md`, **not executed**; it requires BE08-04B.

Related docs:

- [p3-be08-feedback-contract.md](p3-be08-feedback-contract.md)
- [p3-be08-moderation-security.md](p3-be08-moderation-security.md)
- [p3-be08-progress.md](p3-be08-progress.md)

## 1. Source baseline

| Item | Value |
|---|---|
| Branch / HEAD | `feature/provider-feedback` / `57ebede214bdfdaa8af520c1b7283bfd6580cf99` (BE07). BE08 is uncommitted. |
| Working tree | 21 entries: 6 modified, 15 untracked. No other changes. |
| Modified (tracked) | `package.json` (2 QA scripts); `src/admin/admin-reviews.controller.ts`; `src/admin/admin.service.ts`; `src/providers/provider-lifecycle.policy.ts`; `src/reviews/entities/review.entity.ts`; `src/reviews/reviews.module.ts` |
| New source | `src/reviews/{provider-reviews.controller,provider-reviews.service,provider-review-views,review-response-text}.ts`; `src/reviews/dto/{create-review-response,provider-review-list-query}.dto.ts`; `src/admin/dto/admin-review.schema.ts`; `src/database/migrations/1797500000000-AddReviewResponseConstraints.ts` |
| New tests | `src/reviews/provider-reviews.spec.ts`, `src/reviews/review-moderation-security.spec.ts`, `test/qa/provider-feedback.cjs`, `test/qa/review-moderation.cjs` |
| New docs | `docs/phase3/p3-be08-{feedback-contract,moderation-security,progress,validation}.md` |
| Not touched | historical migrations (`git diff 57ebede -- src/database/migrations` is empty); `src/push-*`, `src/notifications`, `src/notification-preferences`, `src/bookings`; `.env`; no generated artifacts, `dist/` or credentials in the tree |
| **Source fingerprint** | `validation/source-fingerprint.txt`: SHA-256 (CRLF-normalised) of 308 files (`src/`, `test/`, `package*.json`, `tsconfig*.json`, `nest-cli.json`, `jest.config.ts`; tracked + untracked; script `validation/fingerprint.cjs`). **Aggregate `2413b1c833bbb8e637b2fa902d5ca52ded2a28674140ddcbf9195043af0ec726`.** Identical before and after the regression run. |
| **Migration 17 hash** | `1797500000000-AddReviewResponseConstraints.ts`: `08f3b54f9c4cb17a4b37ee5135d02310192f9d7a3718b3b3e71935895a1115a0` (LF, raw = normalised). BE07 migration 16: `900ad4cc…7990` (unchanged). |

## 2. Full regression (one run, sequential, same fingerprint)

Script: `validation/run-matrix.sh`. Logs: `validation/qa/*.log`. Summary: `validation/matrix-summary.txt`.

| Step | Command | Result | Exit |
|---|---|---|---|
| Jest (full) | `npm test -- --ci` | **57/57 suites, 1658/1658 tests**, 0 skipped, 0 snapshots | 0 |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.spec.json` | clean | 0 / 0 |
| Lint | `npm run lint` (oxlint `src/ test/`) | no errors. Pre-existing warnings only (e.g. `test/qa/bot-protection.cjs`); none in BE08 files. | 0 |
| Build | `npm run build` | `dist/` with 17 migrations | 0 |
| `qa:provider-feedback` | BE08-02 | **50/50** | 0 |
| `qa:review-moderation` | BE08-03 | **41/41** | 0 |
| `qa:mvp-e2e` | P2 MVP incl. P2-14 / P2-16 | **110/110** | 0 |
| `qa:fe-smoke` | FE contract | **31/31** | 0 |
| `qa:auth-sessions` | P3-BE01 | **55/55** | 0 |
| `qa:account-recovery` | P3-BE02 | **91/91** | 0 |
| `qa:bot-protection` | P3-BE03 | **40/40** | 0 |
| `qa:booking-events` | P3-BE06 | **32/32** | 0 |
| `qa:notifications` | P3-BE04 | **43/43** | 0 |
| `qa:push-devices` | P3-BE05 | **49/49** | 0 |
| `qa:push-outbox` | P3-BE06 | **28/28** | 0 |
| `qa:push-worker` | P3-BE06 | **33/33** | 0 |
| `qa:push-dispatch` | P3-BE06 | **38/38** | 0 |
| `qa:push-pipeline` | P3-BE06 | **18/18** | 0 |
| `qa:notification-preferences` | P3-BE07 | **30/30** | 0 |
| `qa:push-consent` | P3-BE07 | **30/30** | 0 |

**QA total: 16 suites, 719/719 checks, 0 FAIL lines in any log.**

**Re-runs vs reuse.** No earlier evidence was reused. BE08-03's runs were on equivalent source, but every suite was re-run once so the whole matrix shares one fingerprint.

The line `preflight failed` in the `provider-feedback` log is that suite's intentional check M2.

**Isolation:**

- Every suite used its own `pawflow_qa_*` database, guarded by `assertQaDatabaseName`, which refuses the `.env` database name.
- All databases were dropped afterwards. Only the pre-existing `pawflow_qa_push_delivery` remains, untouched.
- No live Firebase: suites use `mock` / stub providers.

**Excluded (unsafe or not a test):**

| Script | Why not run |
|---|---|
| `npm run test:e2e` | `test/app.e2e-spec.ts` boots `AppModule` with `.env`, which is `pet_care_db` |
| `npm run qa:demo-seed` | A persistent seeder (`pawflow_qa_demo`, never dropped). It produces demo data, it is not a test. `qa:fe-smoke` builds its own seeded database and covers the same flows. |

No failures occurred, so no fixes were needed and no evidence was invalidated.

## 3. BE08 security invariants: where each is proven

| Invariant | Evidence (this run) |
|---|---|
| Owner sees only its provider; active staff read-only; inactive staff, customer and admin denied; no existence leak across providers (identical 404) | provider-feedback 1–6, 15–17; review-moderation 9, 14–16 |
| Suspended provider, revoked account or revoked session cannot respond (also while waiting on locks) | provider-feedback 23 + locked races; review-moderation 23–25b |
| One response per review; responder = caller; DB timestamp; forged audit fields 400; duplicate 409; concurrency yields exactly one 201; no edit/delete route (404) | provider-feedback 11–14, 19–20; review-moderation 9, 22 |
| Hidden reviews out of public lists and ratings; author and provider still see them; no new response (409); response survives hide/restore; only admin moderates; audit rows written | review-moderation 6–18; provider-feedback 7, 24c, 27–30; mvp-e2e E3 |
| Admin list/detail `respondedBy { id, fullName }`; deleted responder → `null` with text and time kept | review-moderation 1–5 |
| Races: hide wins, response wins, restore vs response, ownership/suspension/session; 0 deadlocks | review-moderation 19–25 (deterministic barriers); both suites report 0 deadlocks |
| CHECKs; JS/PG code-point agreement; 1000/1001 boundaries; Unicode trim; `SET NULL` | provider-feedback M1–M5, 22; review-moderation 26–29; rehearsal §5 |

## 4. Development database preflight (read-only, 2026-11-14 20:03)

`preflight/dev_identity.txt`, `preflight/migration_show_before.txt`, `preflight/baseline_dev.txt`, `preflight/schema_dev.sql`:

| Item | Value |
|---|---|
| Identity | `pet_care_db` @ `::1:5432`, PostgreSQL **15.18** |
| Migrations | **15 applied** (last `CreateNotificationDeliveries1796500000000`). `migration:show` pending: `[ ] CreateNotificationPreferences1797000000000`, `[ ] AddReviewResponseConstraints1797500000000`, in that order. |
| Tables | 25. `notification_preferences` absent. |
| Reviews | **0 rows** (0 hidden, 0 with a response). Constraints: PK, `UQ(booking_id)`, `chk_reviews_rating`, `fk_reviews_booking`, `fk_reviews_responder`. **No `chk_reviews_response_*`, so there is no conflict.** |
| Other data | 23 users (2 owners, 1 staff), 1 COMPLETED booking, 12 `push_devices` (BE06 smoke data, to keep), 0 `notification_deliveries` |
| Connections / processes | 0 other connections to `pet_care_db`; nothing listening on port 8000 |
| Push config | `.env` keys: `PORT FRONTEND_URL DB_* JWT_SECRET JWT_EXPIRES_IN`. **No `PUSH_*` / `FIREBASE_*`**, so the code defaults apply: `PUSH_DELIVERY_MODE` disabled (`push-delivery.config.ts`), `PUSH_WORKER_ENABLED=false` (`push-worker.config.ts`). |

The state matches the plan: 15 → 16 → 17. After all rehearsals, `pet_care_db` was re-read: 15 migrations, no preferences table, 0 reviews. Its full data baseline is byte-identical before and after (`rehearsal/baseline_dev.txt` = `baseline_dev_after.txt`).

## 5. Migration-chain rehearsal (disposable copies)

**Rehearsal dump** (not the deployment backup):

- `rehearsal/pet_care_db_rehearsal-p3be08_20261114-200531.dump`, custom format, 129 877 bytes, 299 TOC entries;
- SHA-256 `587ae0e416976c0a196c2efef9be266751a40fa68143f6e071965513e206e4ec` (verified);
- `pg_restore --list` exit 0.

Script: `rehearsal/rehearse.sh`. Full log: `rehearsal/rehearsal.log`.

**Method:** the official CLI, `npm run typeorm -- migration:run|revert|show -d database/data-source.ts`, pointed at each copy with an exported `DB_DATABASE`. `dotenv/config` never overrides an existing variable, and every name is guarded to `pawflow_qa_*`.

### A/B. Copy `pawflow_qa_devcopy_p3be08`: 15 → 16 → 17

| Check | Result |
|---|---|
| Restore | exit 0; `current_database()` verified |
| Restored data = development | **YES**: all 25 tables, row counts and full-content md5 (`baseline-all.sql`) |
| Restored schema = development | Equivalent. 26 `x = ANY (ARRAY[…])` CHECK / partial-index expressions are deparsed differently after a restore, with the same names and identical literal lists (`schema_dev_vs_copy_analysis.txt`: 26/26). Nothing else differs. |
| `migration:show` before | 15 `[X]`, 2 `[ ]` |
| `migration:run` | exit 0. Executed `CreateNotificationPreferences1797000000000`, **then** `AddReviewResponseConstraints1797500000000`. Rows 23 and 24 in `migrations`. |
| `migration:show` after | **17 `[X]`, 0 pending** |
| Duration (fresh copy) | 8.3 s, almost all CLI start-up (`copy_migration_timing.txt`) |
| Data after | `baseline_c1_diff.txt`: only `migrations` (15 → 17) and the new `notification_preferences` with **0 rows**. All 25 existing tables are byte-identical: users, sessions, reviews, bookings, notifications, push_devices. |
| **No auto opt-in** | `notification_preferences` has 0 rows, so every existing account is OFF |
| Schema after | `schema_copy_diff.txt` (49 lines): only the new table (PK, FK `CASCADE`, CHECK) and the 2 review CHECKs. Nothing removed. |
| New constraints | `chk_reviews_response_consistency`, `chk_reviews_response_text` (`btrim` set includes `chr(160)` … `chr(65279)`), `pk_/fk_/chk_notification_preferences_*` (`c1_new_constraints.txt`) |

### C. Integrity on the migrated copy

`integrity_c1.json`: **24/24 cases plus the duplicate-review case, all as expected.** Each case runs in a rolled-back transaction, and the copy's baseline is unchanged afterwards.

| Case | Result |
|---|---|
| No response; valid; text and time with `responded_by NULL` (deleted account) | accepted |
| Text without time; time without text; responder without text | 23514 |
| Empty; ASCII spaces; tab/CR/LF only; leading space; trailing LF | 23514 |
| NBSP only; leading U+3000; trailing U+2028; leading BOM | 23514 |
| Inner NBSP and LF; U+180E (not JS whitespace) | accepted |
| 1000 ASCII / 1001 ASCII | accepted / 23514 |
| 1000 emoji (2000 UTF-16 units) / 1001 emoji | accepted / 23514 |
| 1000 code points of `e + U+0301` (500 graphemes) / 1001 | accepted / 23514 |
| 1000 Vietnamese `ữ` | accepted |
| Second review for the same booking | 23505 (P2-14 `UNIQUE(booking_id)` intact) |

**Historical data.** Development has 0 reviews, so compatibility with existing data was **not** inferred from an empty table. The rollback copy was loaded with representative fixtures:

- no response;
- ASCII response;
- Unicode response (hidden);
- 1000-code-point combining;
- 1000 emoji;
- a responded review whose responder account was then deleted (`SET NULL` kept the text and time).

These rows were carried through revert and re-apply unchanged. **Invalid pre-existing data** (a NBSP-only response without time) makes the migration's preflight abort, as shown in D.

### D. Rollback rehearsal: copy `pawflow_qa_devcopy_p3be08_rb`

| Step | Result |
|---|---|
| 15 → 17, load fixtures, opt in one user (copy only) | exit 0. 6 reviews, 1 consent row. |
| **Revert BE08 only (17 → 16)** | exit 0, "reverted successfully". `migrations` 16, CHECKs 0, **consent rows 1 (intact)**, reviews 6. Every table other than `migrations` is unchanged. Schema diff = only the 2 CHECK lines. |
| Pre-existing invalid row, then `migration:run` | **exit 1**: `preflight failed: 1 review(s) with inconsistent response columns, 1 with invalid response text`. It stays at 16 with 0 CHECKs; no partial apply. |
| Remove the row, **re-apply 16 → 17** | exit 0. Data identical to pre-revert (except `migrations`). Schema identical to the pre-revert 17 schema. Integrity matrix again all pass. |
| **BE07 rollback (destructive, copy only): 17 → 16 → 15** | `notification_preferences` dropped: **the 1 stored consent row is lost**. All other tables unchanged. Re-apply 15 → 17 gives 0 consent rows (not restored). |

Conclusions:

- Reverting migration 17 is safe and lossless.
- Reverting migration 16 destroys consent. It needs its own approval, or a dump restore. Never do it automatically.

## 6. Build × schema compatibility (rehearsed)

**Setup:**

- Builds:
  - **BE07** = `57ebede`, from `git archive` into a scratch directory, with no branch switch (`rehearsal/build-be07`);
  - **BE08** = the working tree's `dist/`, built from the validated fingerprint.
- Probe: `rehearsal/be08-probe.cjs`, writing `compat-*.json` and `probe-compat-*.log`.
- Each combination ran on its own copy of the development dump at the given migration level, with disposable writes on the copy only.
- Push disabled unless noted. No Firebase in any run: 0 Firebase mentions in the logs.

| Build \ schema | 15 (current development) | 16 (BE07) | 17 (BE07 + BE08) |
|---|---|---|---|
| **BE07** | Not re-probed. BE07-04A case 4: preferences API **500**, everything else works. | Works fully. Preferences 200 (OFF). Provider review routes **404** (not in build). Admin view has no `respondedBy`. Hide/restore and audit OK. | **Works.** Same as on 16. The CHECKs are inert for BE07 (it never writes responses). Hide/restore OK, aggregates = visible. |
| **BE08** | Starts. Everything works **except** `/notification-preferences` → **500** (`42P01`, 3 log lines). Reviews, responses (201/400/409), admin `respondedBy` and moderation all OK. | **Works fully**, but without the DB backstop: the CHECKs are absent; the app rules (DTO + guarded UPDATE) still hold. | **Works fully (target).** Preferences 200 (OFF, `pushAvailable:false`), 0 rows for existing users. Review create 201, provider list 200, response 201 (stored trimmed, NBSP removed), forged 400, duplicate 409, admin `respondedBy`, hide → public excluded / owner sees hidden, restore, audit `REVIEW_HIDDEN+REVIEW_RESTORED`, `rating_count` = visible. No 5xx. |
| **BE08, mock + worker** | — | — | Starts. `Push provider: mock`; worker started (log line `Push delivery worker … started`). Same results. 0 deliveries (reviews create no notifications, D10). Consent enforcement on this build is proven by `qa:push-consent` 30/30 and `qa:push-pipeline` 18/18. |

**Rules:**

1. **Order: migrate, then start the BE08 build.**
   - BE08 on 15 breaks only the BE07 preference API (500).
   - BE08 on 16 is functional, but production of review responses should wait for 17, so the DB backstop exists before writes.
2. **Rollback of the build** BE08 → BE07 on schema 17 is supported. Provider feedback disappears (404); stored responses remain.
3. **Never run a BE06 build (`e06c6c8` or older) with push enabled on schema ≥ 16.** It does not enforce consent (BE07 rule, unchanged). BE07 and BE08 builds both enforce consent; push code is byte-identical between them (no `src/push-*` / `src/notification*` changes in BE08).
4. A rollback of **migration 16** loses all stored consent (§5 D).
5. No build bypasses BE08 security: BE07 simply lacks the BE08 routes, so nothing is exposed.

## 7. Deployment configuration

Development defaults (no `PUSH_*` / `FIREBASE_*` in `.env`) were reproduced in the probes:

- `Push provider: disabled`;
- `PUSH_DELIVERY_MODE=(not set) -> disabled: inbox only, no push delivery jobs are recorded`;
- `Push delivery worker disabled (PUSH_WORKER_ENABLED is not true)`.

Effects:

- No Firebase initialisation and no worker, so there is no background processing that could modify development data.
- The BE07 preferences API works in disabled mode, with `pushAvailable: false`.
- The BE08 APIs do not depend on push or Firebase.
- `.env` was not edited.

## 8. Git integration audit (2026-11-14; `git fetch origin`, remote-tracking refs only)

| Ref | Commit | Content |
|---|---|---|
| `origin/feature/notification-inbox` | `e06c6c8` | BE04–BE06 |
| `origin/feature/notification-preferences` | `57ebede` | BE04–BE07 (= BE08 base) |
| `origin/main` | `bc34fc9` | **`README.md` only** |
| `origin/dev` | `695801b` | **`README.md` only** (1 file) |
| `origin/revert-14-feature/notification-preferences` | `a4008c8` | revert branch |
| local `dev` (unchanged by me) | `a66a59f` | the full project as of PR #12 |

**Finding: blocking integration incident.** The following happened on 2026-11-14 between 17:15 and 17:16:

1. **PR #14** merged `feature/notification-preferences` (BE04–BE07) into **`main`** as `389c2e6`. Its parents are `060f6c2` (main's README-only initial upload) and `57ebede`.
2. **`a4008c8` "Revert Feature/notification preferences"** reverts that merge relative to `main`'s README-only parent. It therefore deletes **all 322 project files** (−61 011 lines).
3. **PR #15** merged the revert into `main`. **PR #16** merged the same revert branch into **`dev`** (`695801b`, parents `a66a59f` + `a4008c8`).

Result: `dev` lost the entire project, not just BE04–BE07. `git diff a66a59f origin/dev` shows 252 files and −46 283 lines.

Consequences:

- **Nothing is lost.** `a66a59f`, `57ebede`, the local branches and this working tree have everything.
- **BE04–BE07 commits are now ancestors of `dev`.** A normal PR `feature/provider-feedback → dev` would apply only the BE08 diff, on top of a README-only tree. The result would not build.
- Successful local QA ≠ successful Git integration. **BE08 cannot be integrated until `dev` is repaired.** BE06 and BE07 are effectively *not* in `dev` either.

**Repair options** (owner decision; none executed):

| Option | Steps | Notes |
|---|---|---|
| **A (recommended)** | On a branch from `origin/dev`: `git revert a4008c8` (revert the revert). Then PR it into `dev` with "Create a merge commit". | Restores the `57ebede` tree (BE04–BE07) on `dev` without rewriting history. Afterwards `feature/provider-feedback → dev` adds only BE08. |
| B | Also decide what `main` should contain. Today it is README-only, as before #14. | Merging a repaired `dev` into `main` later works (the revert-of-revert is in `dev`). |
| C | Force-reset `dev` to `a66a59f` and redo the PRs | Rewrites shared history (force push). Not recommended. |

**Recommended order:**

1. Repair `dev` (A). Verify that `dev`'s tree equals `57ebede`'s tree (`git rev-parse <sha>^{tree}`).
2. Commit BE08 on `feature/provider-feedback`. The fingerprint must stay `2413b1c8…c726`.
3. PR `feature/provider-feedback → dev` with a merge commit, not squash or rebase.
4. Development deployment per the runbook.

## 9. Deployment readiness

| Area | Status |
|---|---|
| Source and quality gates | ✅ fingerprint `2413b1c8…c726`; Jest 1658/1658; QA 719/719; tsc, lint, build exit 0 |
| Migration chain (15 → 16 → 17), rollback, re-apply, invalid-data preflight | ✅ rehearsed on copies |
| Build/schema compatibility | ✅ documented above |
| Runbook | ✅ `p3be08/RUNBOOK.md` (backup → verify → migrate → verify → smoke → rollback tree) |
| **Source freeze (commit)** | ⏳ Ready to commit, but not done (needs an explicit instruction) |
| **Git integration** | ❌ **Blocked**: `origin/dev` and `origin/main` were wiped by the PR #14 revert (§8) |
| **BE07 deployment (G-BE07)** | ❌ **Pending.** Migration 16 is not on development. BE07-04B needs its own approval, or an explicit combined G-BE07 + G-BE08 approval. |
| **BE08 deployment (G-BE08)** | ⏳ Ready technically. Waits for G-BE07 (or the combined approval) and a committed source. |

## 10. Open risks and limitations

- **The repository incident (§8) is the main risk.** It is not technical in the code, but it blocks integration and could lead to a broken `dev` if BE08 is merged naively.
- **Approval coupling.** Migration 17 cannot be applied alone from 15. `migration:run` applies 16 first, so a BE08 deployment implies BE07's consent change (all existing accounts push OFF).
- **Real historical review data has not been exercised** (development has 0 reviews). The preflight guarantees that a violating row aborts the migration cleanly, and the fixtures covered all valid states.
- Known product limitations (unchanged; moderation-security §8):
  - the admin list is unpaginated;
  - removing an abusive response is deferred (D7);
  - no NFC normalisation;
  - control characters other than NUL are accepted;
  - filtered paging can shift.
- **Probe detail:** the probe's `log.workerStarted` regex missed the worker's actual wording. The evidence used is the log line itself (`probe-compat-be08-on-17-mockworker.log`).
- Compatibility of BE07 on schema 15 was not re-probed. It relies on BE07-04A case 4; the BE07 build is unchanged.
