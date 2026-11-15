/*
 * P3-BE10 PostgreSQL QA runner: runs the QA suites sequentially, each on
 * its own run-owned disposable database, and reports machine-counted
 * results (no hand arithmetic).
 *
 *   npm run build
 *   npm run qa:all                         # every suite
 *   npm run qa:all -- booking-races api-security-matrix   # a subset
 *   npm run qa:be10                        # the BE10 suites only
 *   npm run qa:release-security            # P3-BE11 (also part of qa:all)
 *   npm run qa:all -- --be12               # P3-BE12 release-contract, migration-cli, backup-restore, contract-smoke
 *
 * - Database per suite: pawflow_qa_<suite>_<runId> (QA_DB_NAME). qa-env.cjs
 *   refuses any name that is not pawflow_qa_* or equals the development
 *   DB_DATABASE, and each suite verifies current_database() before writing.
 *   Suites drop their own database at the end (QA_KEEP_DB=1 keeps it);
 *   databases this run does not own are never touched.
 * - Output: <QA_OUT_DIR or a temp dir>/<suite>/ (app logs, evidence),
 *   <suite>.log (console), summary.json.
 * - Counting: one check = one console line starting with PASS / FAIL /
 *   SKIP. A suite passes when it exits 0, has >= 1 PASS and 0 FAIL.
 * - No external network calls unless QA_ALLOW_EXTERNAL=1; no Firebase
 *   credentials are used (push suites use the mock provider and local stubs).
 *
 * Environment: QA_DB_HOST / QA_DB_PORT / QA_DB_USERNAME / QA_DB_PASSWORD
 * (default: the DB_* values of .env, database name never used), QA_OUT_DIR,
 * QA_SUITE_TIMEOUT_MS (default 900000), QA_KEEP_DB=1.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SUITES = [
  'mvp-e2e', 'fe-smoke', 'auth-sessions', 'account-recovery', 'bot-protection', 'notifications', 'push-devices',
  'push-outbox', 'booking-events', 'push-worker', 'push-dispatch', 'push-pipeline', 'notification-preferences',
  'push-consent', 'provider-feedback', 'review-moderation', 'observability-audit',
  // P3-BE10
  'api-security-matrix', 'admin-audit-atomicity', 'booking-races',
  // P3-BE11
  'release-security',
  // P3-BE12 (release-contract needs no database; backup-restore needs pg_dump/pg_restore, see PG_BIN)
  'release-contract', 'migration-cli', 'backup-restore', 'contract-smoke',
];
const BE10 = ['api-security-matrix', 'admin-audit-atomicity', 'booking-races'];
const BE12 = ['release-contract', 'migration-cli', 'backup-restore', 'contract-smoke'];

const args = process.argv.slice(2);
const selected = args.includes('--be10') ? BE10 : args.includes('--be12') ? BE12 : args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : SUITES;
const unknown = selected.filter((s) => !SUITES.includes(s));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}. Known: ${SUITES.join(', ')}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
  console.error('dist/main.js not found: run `npm run build` first');
  process.exit(2);
}

const RUN_ID = Date.now().toString(36);

/** Masks token-like values and bounds the length of a diagnostic line (QA data is synthetic; defence in depth). */
function sanitize(line) {
  return line
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/(token|password|secret)("?\s*[:=]\s*"?)[^"',\s}]+/gi, '$1$2<redacted>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
    .slice(0, 600);
}

const OUT = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-qa-all-'));
const TIMEOUT = Number(process.env.QA_SUITE_TIMEOUT_MS ?? 900_000);

function runSuite(suite) {
  return new Promise((resolve) => {
    const outDir = path.join(OUT, suite);
    fs.mkdirSync(outDir, { recursive: true });
    const dbName = `pawflow_qa_${suite.replace(/-/g, '_')}_${RUN_ID}`;
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, `${suite}.cjs`)], {
      cwd: ROOT,
      env: { ...process.env, QA_DB_NAME: dbName, QA_OUT_DIR: outDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { output += `\nRUNNER: timeout after ${TIMEOUT} ms, killed\n`; child.kill('SIGKILL'); }, TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(OUT, `${suite}.log`), output);
      const count = (re) => output.split(/\r?\n/).filter((l) => re.test(l)).length;
      const pass = count(/^PASS\b/);
      const fail = count(/^FAIL\b/);
      const skip = count(/^SKIP\b/);
      const ok = code === 0 && pass > 0 && fail === 0;
      // Failure diagnostics for the CI job log and summary.json: the FAIL lines (or, after a
      // crash / timeout without FAIL lines, the end of the output), sanitized and bounded.
      const lines = output.split(/\r?\n/);
      const failures = ok ? [] : (fail > 0 ? lines.filter((l) => /^FAIL\b/.test(l)) : lines.filter(Boolean).slice(-15)).slice(0, 20).map(sanitize);
      resolve({ suite, database: dbName, exitCode: code, pass, fail, skip, ok, seconds: Math.round((Date.now() - started) / 1000), failures });
    });
  });
}

(async () => {
  console.log(`PawFlow QA run ${RUN_ID}: ${selected.length} suite(s), output ${OUT}`);
  const results = [];
  for (const suite of selected) {
    const r = await runSuite(suite);
    results.push(r);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${suite.padEnd(26)} pass ${String(r.pass).padStart(4)}  fail ${r.fail}  skip ${r.skip}  exit ${r.exitCode}  ${r.seconds}s`);
    for (const line of r.failures) console.log(`        | ${line}`);
  }
  const total = results.reduce((t, r) => ({ pass: t.pass + r.pass, fail: t.fail + r.fail, skip: t.skip + r.skip }), { pass: 0, fail: 0, skip: 0 });
  const okSuites = results.filter((r) => r.ok).length;
  const summary = { runId: RUN_ID, suites: results.length, okSuites, ...total, results };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nSUITES ${okSuites}/${results.length} OK   CHECKS pass ${total.pass}  fail ${total.fail}  skip ${total.skip}`);
  console.log(`Summary: ${path.join(OUT, 'summary.json')}`);
  process.exitCode = okSuites === results.length ? 0 : 1;
})();
