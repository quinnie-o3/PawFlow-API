# PawFlow — PostgreSQL Backup and Restore Runbook (P3-BE12)

**Status:** procedure rehearsed end-to-end on disposable QA databases (`npm run qa:backup-restore`, see §8). It has **not** been executed on a staging or production database: none exists yet. The development database `pet_care_db` was never touched.

Scope: logical backups with `pg_dump` / `pg_restore` (PostgreSQL 15). A managed platform's snapshots and point-in-time recovery (PITR) are complementary. They are **not configured or verified** here, so this document claims **no RPO and no RTO**.

Related: deployment and rollback → [p3-be12-deploy-rollback-runbook.md](p3-be12-deploy-rollback-runbook.md); database roles → [p3-be11-staging-runbook.md](p3-be11-staging-runbook.md) §2.

## 1. Before any backup or restore: identify the database

Run with the same connection settings you are about to use, and stop if anything is unexpected:

```sql
SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), version();
SELECT count(*) AS migrations, max(name) AS newest FROM migrations;   -- expected: 17 / AddReviewResponseConstraints1797500000000
```

- The name must be the intended environment's database (for example `pawflow_staging`), **never** `pet_care_db` unless you deliberately back up the developer database, and never a database you did not intend.
- Note the server major version (`version()`); it constrains the client tools (§2).
- Record environment, database, host, migration level, operator and time in the release log.

## 2. Tools and version compatibility

| Rule | Why |
|---|---|
| `pg_dump` major version ≥ server major version | `pg_dump` refuses to dump a newer server. Rehearsal: client 15.18, server 15.18. |
| Restore with a `pg_restore` of the same or newer major version than the `pg_dump` that wrote the archive | Older `pg_restore` cannot read newer archive formats. |
| Target server major ≥ source server major | Restoring into an older server is not supported. |
| CI uses the PostgreSQL 15 client (`PG_BIN=/usr/lib/postgresql/15/bin`) | Matches the `postgres:15` service. |

## 3. Credentials (never on a command line)

- Provide the password through the environment of the shell session (`PGPASSWORD`, exported from the secret store and unset afterwards). Or use a password file (`~/.pgpass` / `PGPASSFILE`, mode `0600`). Use `PGHOST`, `PGPORT`, `PGUSER` for the rest.
- Never pass `--password=…`, a connection URI that embeds the password or a password in a script argument. Arguments are visible in process lists and shell history.
- Back up with the migration-owner role or a dedicated read-only backup role, not the application role. Restores need a role that can create the target database.
- `qa:backup-restore` check 2.6 verifies that its tool invocations carry no password.

## 4. Backup

```bash
set -euo pipefail
umask 077                                   # files 0600, directories 0700
export PGHOST=<host> PGPORT=5432 PGUSER=<backup-or-owner-role> PGDATABASE=<db>
read -rs PGPASSWORD && export PGPASSWORD    # or PGPASSFILE; never on the command line
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/secure/backups/<env>/${PGDATABASE}_${STAMP}_<git-sha>.dump   # OUTSIDE the repository
pg_dump --format=custom --no-password --file="$OUT" "$PGDATABASE"
sha256sum "$OUT" > "$OUT.sha256"
pg_restore --list "$OUT" > "$OUT.toc"       # must succeed; lists TABLE DATA for every table
unset PGPASSWORD
```

| Topic | Decision |
|---|---|
| Format | Custom (`-Fc`): compressed, one file, readable table of contents, selective and parallel restore (`pg_restore -j`). Plain SQL is not used. |
| Scope | One database, every schema object and row, including the `migrations` table. Roles and grants are cluster-level: recreate them from the staging runbook §2, or with `pg_dumpall --globals-only` on self-managed servers. |
| Naming | `<db>_<UTC timestamp>_<git sha>.dump` plus `.sha256` and `.toc`, under `/secure/backups/<env>/`. |
| Location | **Outside the repository.** `.gitignore` ignores `*.dump`, `*.backup` and `*.dump.sha256` anywhere, and `contract:check` B10/B11 verifies that no dump is tracked. Copy to encrypted storage with restricted access. A dump contains personal data, password hashes, session and refresh-token hashes, and audit logs. |
| Permissions | `umask 077`: dump `0600`, directory `0700` (rehearsal check 2.4 on POSIX hosts). |
| Integrity | Exit code 0, non-empty file, `pg_restore --list` succeeds, SHA-256 recorded. Verify the SHA-256 again before every restore. A truncated archive is detected (rehearsal 5.1/5.2). |
| Failure | `set -euo pipefail`: any non-zero exit stops the procedure. Delete the partial file. **A release does not continue without a verified backup.** A missing database or bad credentials fail visibly (rehearsal 5.4). |
| Consistency | `pg_dump` takes one MVCC snapshot, so the archive is consistent even with concurrent writes. Writes made **after** the snapshot are not in it. For a release restore point, stop writers first (deploy runbook §3.1) so that nothing is lost between the dump and the cutover. |
| Retention | **Assumption, not an implemented policy:** keep every pre-release dump at least until the next release is accepted, and keep the last N daily dumps on encrypted storage. Retention, off-site copies and PITR belong to the hosting decision (owner). |

## 5. Restore (never over the live database)

Restore into a **new** database, verify it, then switch the application to it. Do not run `pg_restore --clean` against the database in use: a failure half-way leaves it damaged. This supersedes the `--clean --if-exists` hint in the BE11 runbook.

```bash
set -euo pipefail
sha256sum -c "$DUMP.sha256"                                    # integrity first
export PGHOST=… PGPORT=… PGUSER=<owner-role>; read -rs PGPASSWORD && export PGPASSWORD
TARGET=<db>_restore_$(date -u +%Y%m%dT%H%M%SZ)
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET\""
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$TARGET" "$DUMP"
```

- `--single-transaction --exit-on-error`: all or nothing. A failed restore leaves the target empty (rehearsal 5.2), and a restore into a non-empty database fails and changes nothing (5.3).
- `--no-owner --no-privileges`: objects belong to the restoring owner role. Re-apply the application role's grants (staging runbook §2) before the application connects.

### Verification before switching

| Check | Command / expectation |
|---|---|
| Schema level | `SELECT count(*) FROM migrations` = the dump's level; it must match the build you will run (17 for this release). |
| Rows | Per-table `count(*)` compared with the source's `.toc` / a pre-backup count. The rehearsal compares counts and content hashes of all 26 tables. |
| Constraints | `SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated` = 0. Foreign keys are re-created and validated by the restore. |
| Sequences | `SELECT sequencename, last_value FROM pg_sequences` equals the source, so new rows do not collide (rehearsal 3.7, 4.4). |
| Application | Start the release build against `$TARGET` with `MIGRATIONS_CHECK=enforce` and **`PUSH_WORKER_ENABLED=false`**. `GET /api/health/ready` must return `schema: current`. A known account logs in (rehearsal 4.1–4.3). |

Note: PostgreSQL may print restored `CHECK (col IN (...))` definitions with different cast notation. They are equivalent: the rehearsal compares them normalised and proves that a restored CHECK still rejects invalid data (3.4, 3.4b).

## 6. A restore is not a full rollback: side effects and state

| Concern | Handling |
|---|---|
| Application version | Run the build whose migration chain equals the restored `migrations` table. The startup check (`MIGRATIONS_CHECK=enforce`) refuses any other. |
| Writes after the backup | Lost. Bookings, cancellations, reviews, admin actions and audit log entries made after the snapshot must be reconciled manually from the structured logs (`http.request.completed` lines with `X-Request-ID`) and from the admin audit trail of the live database before the switch. This is the main reason to stop writers before a release dump. |
| Sessions and tokens | The restore brings back sessions and refresh tokens that were revoked after the backup point. **Revoke every restored session before opening traffic:** `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'SESSION_REVOKED' WHERE revoked_at IS NULL;` Users must log in again. The database trigger also revokes their push devices. Rehearsed (4.6): every restored token is rejected with 401. |
| Password reset / verification links | Links issued after the backup no longer exist (users request new ones). Links consumed after the backup become valid again until they expire (TTL 30 min / 24 h); the session revocation above limits the impact. |
| Push outbox (`notification_deliveries`) | Restored `PENDING` jobs would be **re-sent** by the worker. Keep `PUSH_WORKER_ENABLED=false` (rehearsal 4.5: 22 pending jobs untouched). Review the jobs by status, then enable the worker. Jobs past `PUSH_DELIVERY_TTL_SECONDS` expire instead of sending late. Notifications already sent after the backup point cannot be recalled. |
| E-mail | Sent asynchronously at request time, with no outbox. Nothing is replayed by a restore. |
| Rate-limit counters | Restored counters are harmless; expired windows are purged automatically. |
| Worker during cutover | Exactly one environment may run the push worker. Never run old and new instances against different databases at the same time. |

## 7. What cannot be automated safely

- Choosing between losing post-backup writes (restore) and repairing forward (fix data in place). Owner decision per incident.
- Reconciling post-backup business events (bookings, payments, complaints, moderation) from logs.
- Deciding which restored outbox jobs may still be delivered.
- Production retention, encryption at rest and off-site copies: platform decisions, not configured.

## 8. Rehearsal evidence

`npm run qa:backup-restore` (part of `qa:all` and CI), disposable databases `pawflow_qa_*` only, PostgreSQL 15.18 server and client:

| # | Verified |
|---|---|
| 1.1–1.3 | Source migrated (17, no pending DDL). Demo dataset created through the API. Pending push deliveries present. |
| 2.1–2.6 | Client ≥ server version. `pg_dump -Fc` exit 0. SHA-256 recorded and re-verified. Mode 0600 (POSIX only; SKIP on Windows). TOC lists the data of all 26 tables. No password in any tool invocation. |
| 3.1–3.8 | Restore into a separate database succeeds. Same tables, rows (count and content hash per table), constraints (all validated), CHECK still enforced, foreign keys, indexes, sequence positions and migration history. |
| 4.1–4.6 | Build starts on the restored database with `MIGRATIONS_CHECK=enforce` and is ready. A restored user logs in and sees their bookings. New IDs do not collide. The outbox is not replayed while the worker is off. Revoking sessions invalidates every restored token. |
| 5.1–5.4 | Truncated archive: SHA-256 mismatch, and the restore fails leaving an empty target. Restore over a non-empty database fails without changes. Dump of a missing database fails. |

Results of the final regression: [p3-be12-release-contract-freeze.md](p3-be12-release-contract-freeze.md) §9.
