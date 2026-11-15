/*
 * P3-BE12 reproducible OpenAPI export (secret-free, no database).
 *
 *   npm run build
 *   npm run openapi:export            # writes docs/api/openapi.json
 *   npm run openapi:check             # exit 1 when docs/api/openapi.json differs from the build
 *   node scripts/openapi-export.cjs --out <file>
 *
 * How: a child process loads the compiled AppModule in Nest *preview mode*
 * (modules and controllers are scanned, no provider is instantiated), so no
 * database connection is opened, no worker or delivery service starts and no
 * external service is contacted. The document is built by the same
 * `createOpenApiDocument` that serves /api/docs at runtime.
 *
 * Isolation: the child runs in an empty temporary directory (the repository
 * .env cannot be loaded) with a minimal synthetic environment: an unreachable
 * database address (127.0.0.1:1, a non-existent pawflow_qa_* name) and a
 * random throw-away JWT secret. Any accidental connection attempt would fail
 * the export instead of reaching a real database. Nothing secret can end up
 * in the document because no secret is present in the process.
 *
 * Determinism: the document depends only on the compiled code; comparisons
 * use the parsed JSON, so CRLF/LF checkouts compare equal.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomBytes } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'api', 'openapi.json');

function childMain(outFile) {
  require(path.join(ROOT, 'node_modules', 'reflect-metadata'));
  const { NestFactory } = require(path.join(ROOT, 'node_modules', '@nestjs', 'core'));
  const { AppModule } = require(path.join(ROOT, 'dist', 'app.module.js'));
  const { createOpenApiDocument } = require(path.join(ROOT, 'dist', 'common', 'openapi', 'openapi-document.js'));
  return (async () => {
    const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    const document = createOpenApiDocument(app);
    await app.close();
    fs.writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`);
  })();
}

/** Builds the document in an isolated child process and returns it (parsed). */
function generateOpenApi() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'common', 'openapi', 'openapi-document.js'))) {
    throw new Error('dist/ is missing or outdated: run `npm run build` first');
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawflow-openapi-'));
  const outFile = path.join(workDir, 'openapi.json');
  const env = {
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_PORT: '1',
    DB_USERNAME: 'openapi_export',
    DB_PASSWORD: 'not-used',
    DB_DATABASE: 'pawflow_qa_openapi_export_unused',
    JWT_SECRET: randomBytes(32).toString('hex'),
  };
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  try {
    const result = spawnSync(process.execPath, [__filename, '--child', outFile], { cwd: workDir, env, encoding: 'utf8', timeout: 120_000 });
    if (result.status !== 0) throw new Error(`OpenAPI generation failed (exit ${result.status}): ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const canonical = (document) => JSON.stringify(document);

function main(argv) {
  if (argv[0] === '--child') return childMain(argv[1]);
  const document = generateOpenApi();
  const operations = Object.values(document.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  if (argv.includes('--check')) {
    const committed = fs.existsSync(DEFAULT_OUT) ? JSON.parse(fs.readFileSync(DEFAULT_OUT, 'utf8')) : null;
    if (!committed || canonical(committed) !== canonical(document)) {
      console.error('FAIL docs/api/openapi.json differs from the compiled API contract: run `npm run build && npm run openapi:export` and review the diff');
      process.exitCode = 1;
      return undefined;
    }
    console.log(`PASS docs/api/openapi.json matches the compiled API (${operations} operations)`);
    return undefined;
  }
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : DEFAULT_OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`OpenAPI ${document.openapi}: ${Object.keys(document.paths).length} paths, ${operations} operations -> ${path.relative(ROOT, out)}`);
  return undefined;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

module.exports = { generateOpenApi, canonical, DEFAULT_OUT };
