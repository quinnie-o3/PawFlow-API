/*
 * P3-BE12 migration freeze rehearsal with the OFFICIAL release command
 * (`npm run typeorm -- migration:<show|run|revert> -d database/data-source.ts`,
 * i.e. node_modules/typeorm/cli-ts-node-commonjs.js on the TypeScript
 * migrations) against a disposable QA database:
 *
 *   npm run build
 *   npm run qa:migration-cli
 *
 * 1. Empty database: migration:show reports all 17 frozen migrations pending.
 * 2. migration:run applies exactly the frozen chain, in order; show reports
 *    none pending; a second run is a no-op; the entities need no further DDL.
 * 3. migration:revert rolls back exactly the newest migration; show reports
 *    it pending; the application refuses to start (MIGRATIONS_CHECK=enforce);
 *    migration:run restores the chain and the application starts, readiness
 *    reports the schema current.
 * 4. The OpenAPI document served by the running application equals the
 *    database-free export (docs/api/openapi.json).
 * 5. DB_SSL=require is honoured by the CLI (refused by a non-TLS server,
 *    nothing changes).
 *
 * Isolation: the CLI runs from an EMPTY temporary directory (dotenv cannot
 * load the repository .env) with every DB_* variable set explicitly to the
 * run-owned pawflow_qa_* database; the name is checked before every command.
 *
 * Environment: QA_DB_NAME (default pawflow_qa_migration_cli), QA_PORTS
 * (default 8391), QA_OUT_DIR, QA_KEEP_DB=1, QA_DB_*.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { randomBytes } = require('crypto');
const { ROOT, DB, Client, sleep, dropDatabase, assertQaDatabaseName } = require('./qa-env.cjs');
const { DataSource } = require(path.join(ROOT, 'node_modules', 'typeorm'));
const { canonical } = require(path.join(ROOT, 'scripts', 'openapi-export.cjs'));

const NAME = process.env.QA_DB_NAME ?? 'pawflow_qa_migration_cli';
const PORT = Number((process.env.QA_PORTS ?? '8391').split(',')[0]);
const OUT = process.env.QA_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-migration-cli-'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'api', 'release-manifest.json'), 'utf8'));
const CLI = path.join(ROOT, 'node_modules', 'typeorm', 'cli-ts-node-commonjs.js');
const DATA_SOURCE = path.join(ROOT, 'database', 'data-source.ts');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function baseEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USERNAME: DB.user, DB_PASSWORD: DB.password, DB_DATABASE: NAME, DB_SSL: 'disable', ...extra };
}

/** The official migration command, from an empty directory, against the QA database only. */
function typeorm(command, extraEnv = {}) {
  const env = baseEnv({ TS_NODE_PROJECT: path.join(ROOT, 'tsconfig.json'), ...extraEnv });
  assertQaDatabaseName(env.DB_DATABASE);
  // Empty directory on the repository's drive: the TypeORM CLI resolves the
  // data source's absolute globs against the cwd drive on Windows
  // ("C:\D:\..."), so the system temp dir cannot be used there. .tmp is git-ignored.
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  const cwd = fs.mkdtempSync(path.join(ROOT, '.tmp', 'typeorm-cwd-'));
  const result = spawnSync(process.execPath, [CLI, command, '-d', DATA_SOURCE], { cwd, env, encoding: 'utf8', timeout: 300_000 });
  fs.rmSync(cwd, { recursive: true, force: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  fs.appendFileSync(path.join(OUT, 'typeorm-cli.log'), `\n$ typeorm ${command}${extraEnv.DB_SSL ? ` (DB_SSL=${extraEnv.DB_SSL})` : ''}\n${output}`);
  return { status: result.status, output };
}

const pendingCount = (output) => (output.match(/^\s*\[ \]/gm) ?? []).length;
const appliedCount = (output) => (output.match(/^\s*\[X\]/gm) ?? []).length;

async function appliedNames(db) {
  return (await db.query('SELECT name FROM migrations ORDER BY id')).rows.map((r) => r.name);
}

/** Starts dist/main.js once; resolves with its exit code (or 'running' once /api/health/live answers). */
function boot(env) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-mcli-run-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'main.js')], {
    cwd: runDir,
    env: baseEnv({ NODE_ENV: 'test', PORT: String(PORT), JWT_SECRET: randomBytes(32).toString('hex'), TZ: 'Asia/Ho_Chi_Minh',
      TURNSTILE_MODE: 'disabled', AUTH_RATE_LIMIT: 'disabled', LOG_FORMAT: 'json', ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = (async () => {
    for (let i = 0; i < 200 && child.exitCode === null; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/api/health/live`)).ok) return 'running'; } catch { /* starting */ }
      await sleep(150);
    }
    return child.exitCode === null ? 'timeout' : child.exitCode;
  })();
  return {
    state: Promise.race([ready, exited]),
    output: () => output,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      fs.appendFileSync(path.join(OUT, 'app.log'), output);
    },
  };
}

async function main() {
  assertQaDatabaseName(NAME);
  fs.mkdirSync(OUT, { recursive: true });
  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  await admin.end();
  const db = new Client({ ...DB, database: NAME });
  await db.connect();
  check('isolation: connected to the run-owned QA database', (await db.query('select current_database() d')).rows[0].d === NAME, NAME);

  try {
    const frozen = MANIFEST.migrations;
    const total = frozen.length;

    // 1. Empty database.
    let show = typeorm('migration:show');
    check(`1.1 migration:show on an empty database lists ${total} pending migrations`, pendingCount(show.output) === total && appliedCount(show.output) === 0,
      `pending ${pendingCount(show.output)}, exit ${show.status}`);
    // TypeORM 1.x exits 0 even when migrations are pending: a release preflight
    // must count the "[ ]" lines (runbook), not rely on the exit code.
    check('1.2 migration:show exits 0 with pending migrations (preflight must count "[ ]" lines, documented in the runbook)', show.status === 0, `exit ${show.status}`);

    // 2. Apply the chain.
    let run = typeorm('migration:run');
    const applied = await appliedNames(db);
    check(`2.1 migration:run applies the frozen chain in order (${total})`, run.status === 0 && JSON.stringify(applied) === JSON.stringify(frozen), `exit ${run.status}, applied ${applied.length}`);
    show = typeorm('migration:show');
    check('2.2 migration:show after the release: nothing pending, exit 0', show.status === 0 && appliedCount(show.output) === total && pendingCount(show.output) === 0,
      `applied ${appliedCount(show.output)}, exit ${show.status}`);
    run = typeorm('migration:run');
    check('2.3 a second migration:run is a no-op', run.status === 0 && /No migrations are pending/i.test(run.output) && (await appliedNames(db)).length === total);

    const ds = new DataSource({ type: 'postgres', host: DB.host, port: DB.port, username: DB.user, password: DB.password, database: NAME, synchronize: false,
      entities: [path.join(ROOT, 'dist', '**', '*.entity.js')] });
    await ds.initialize();
    const pendingDdl = (await ds.driver.createSchemaBuilder().log()).upQueries.length;
    await ds.destroy();
    check('2.4 entities and migrations agree (no pending DDL after the chain)', pendingDdl === 0, `${pendingDdl} statement(s)`);

    // 3. Revert the newest migration, refusal, re-apply.
    const revert = typeorm('migration:revert');
    const afterRevert = await appliedNames(db);
    check(`3.1 migration:revert rolls back exactly the newest migration (${frozen[total - 1]})`,
      revert.status === 0 && afterRevert.length === total - 1 && !afterRevert.includes(frozen[total - 1]), `exit ${revert.status}`);
    show = typeorm('migration:show');
    check('3.2 migration:show reports the reverted migration as pending', pendingCount(show.output) === 1 && appliedCount(show.output) === total - 1,
      `pending ${pendingCount(show.output)}`);

    let app = boot({ MIGRATIONS_CHECK: 'enforce' });
    let state = await app.state;
    await app.stop();
    check('3.3 the application refuses to start on a pending migration (MIGRATIONS_CHECK=enforce)',
      state !== 'running' && /1 pending/.test(app.output()), `state ${state}`);

    run = typeorm('migration:run');
    check('3.4 migration:run re-applies the reverted migration', run.status === 0 && JSON.stringify(await appliedNames(db)) === JSON.stringify(frozen));

    app = boot({ MIGRATIONS_CHECK: 'enforce' });
    state = await app.state;
    try {
      check('3.5 the application starts on the current schema (MIGRATIONS_CHECK=enforce)', state === 'running', `state ${state}`);
      const ready = await fetch(`http://localhost:${PORT}/api/health/ready`);
      const body = await ready.json();
      check('3.6 readiness: database up, schema current', ready.status === 200 && body.checks?.schema === 'current' && body.checks?.database === 'up', JSON.stringify(body));

      // 4. Served OpenAPI == database-free export.
      const served = await (await fetch(`http://localhost:${PORT}/api/docs-json`)).json();
      const exported = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'api', 'openapi.json'), 'utf8'));
      check('4.1 the OpenAPI document served by the running application equals docs/api/openapi.json', canonical(served) === canonical(exported));
    } finally {
      await app.stop();
    }

    // 5. TLS option honoured by the CLI.
    const ssl = (await db.query('SHOW ssl')).rows[0].ssl;
    if (ssl === 'off') {
      const tls = typeorm('migration:show', { DB_SSL: 'require' });
      check('5.1 DB_SSL=require is honoured by the migration CLI (a non-TLS server refuses, nothing changes)',
        tls.status !== 0 && /SSL/i.test(tls.output) && (await appliedNames(db)).length === total, `exit ${tls.status}`);
    } else {
      console.log('SKIP 5.1 local server has TLS enabled; the refusal case cannot be shown here');
    }
  } finally {
    await db.end();
    if (process.env.QA_KEEP_DB !== '1') await dropDatabase(NAME);
  }
  console.log(`\nmigration-cli: ${passed} PASS, ${failed} FAIL (log: ${path.join(OUT, 'typeorm-cli.log')})`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FAIL migration-cli crashed: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
