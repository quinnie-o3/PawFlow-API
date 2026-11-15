/*
 * P3-BE10 Jest E2E global setup: creates and migrates a run-owned
 * disposable database pawflow_qa_e2e_<id> through qa-env.cjs (which
 * refuses any non-QA name or the .env DB_DATABASE and verifies
 * current_database()), then exports its connection settings to the test
 * process through process.env.
 *
 * The preparation runs in a child Node process, exactly like the QA
 * scripts: TypeORM's glob import of the compiled entities does not work
 * inside Jest's module loader on Windows paths.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async () => {
  const name = `pawflow_qa_e2e_${Date.now().toString(36)}`;
  const script = `
    const qa = require(${JSON.stringify(path.join(__dirname, 'qa', 'qa-env.cjs'))});
    qa.prepareDatabase(process.argv[1]).then(async ({ db, migrations }) => {
      await db.end();
      process.stdout.write(JSON.stringify({ migrations: migrations.length, DB: qa.DB }));
    }).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });`;
  const child = spawnSync(process.execPath, ['-e', script, name], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  if (child.status !== 0) {
    // The database may exist half-prepared: drop it (it is this run's own) before failing.
    spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'qa', 'qa-env.cjs'))}).dropDatabase(process.argv[1])`, name], { cwd: path.join(__dirname, '..') });
    throw new Error(`E2E database preparation failed: ${(child.stderr || '').trim().slice(0, 500)}`);
  }
  const out = JSON.parse(child.stdout);
  Object.assign(process.env, {
    E2E_DB_NAME: name,
    E2E_MIGRATIONS: String(out.migrations),
    DB_HOST: out.DB.host,
    DB_PORT: String(out.DB.port),
    DB_USERNAME: out.DB.user,
    DB_PASSWORD: out.DB.password,
    DB_DATABASE: name,
  });
};
