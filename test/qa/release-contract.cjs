/*
 * P3-BE12 release contract freeze checks (deterministic, no database, no
 * network, no secret printed). Detects drift between the code and the
 * frozen release contract:
 *
 *   npm run build
 *   npm run contract:check          (also part of qa:all and of CI "verify")
 *
 * A. OpenAPI: docs/api/openapi.json equals the compiled API (reproducible
 *    export, no database); runtime routes (Nest metadata, route-inventory.cjs)
 *    == documented operations; per operation: summary, bearer security +
 *    401 for JwtAuthGuard, no security on public routes, 403 for role-guarded
 *    routes, request body schema for every @Body handler, every path
 *    parameter, 429 for auth rate-limited routes, 429/503 + Retry-After for
 *    the API-wide limiter, X-Request-ID on every response, a 2xx response;
 *    success responses without a schema may only shrink (manifest baseline);
 *    every machine-readable error code is documented.
 * B. Environment: every variable the code reads is documented in
 *    .env.example and nothing obsolete is documented; .env.staging.example
 *    only names real variables, is refused as-is by every loader (its
 *    placeholders cannot start a server), and passes every loader once the
 *    placeholders are replaced with synthetic values; examples hold no real
 *    secret; .gitignore covers real environment files and backups; no real
 *    environment file is tracked.
 * C. Migrations: source files == the frozen ordered list (17), unique and
 *    increasing timestamps, compiled classes named <Name><timestamp> with
 *    up/down, dist in sync, schema synchronization never enabled.
 * D. FE-BE traceability: every route and every error code appears in
 *    docs/phase3/p3-be12-fe-be-traceability.md.
 * E. Secrets: generated/release documents contain no key material, no
 *    token-like value and none of the local .env secret values (compared,
 *    never printed).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { routeInventory } = require('./route-inventory.cjs');
const { generateOpenApi, canonical, DEFAULT_OUT } = require(path.join(ROOT, 'scripts', 'openapi-export.cjs'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const list = (items, max = 8) => (items.length > max ? `${items.slice(0, max).join('; ')}; ... (+${items.length - max})` : items.join('; '));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('docs/api/release-manifest.json'));

// ---------------------------------------------------------------- A. OpenAPI
const routeArgsKey = '__routeArguments__';
const BODY = 3; // @nestjs/common RouteParamtypes.BODY

function bodyHandlers() {
  const set = new Set();
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.controller.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'dist'));
  for (const file of files) {
    for (const exported of Object.values(require(file))) {
      if (typeof exported !== 'function' || Reflect.getMetadata('path', exported) === undefined) continue;
      for (const name of Object.getOwnPropertyNames(exported.prototype)) {
        const args = Reflect.getMetadata(routeArgsKey, exported, name) ?? {};
        if (Object.keys(args).some((key) => Number(key.split(':')[0]) === BODY)) set.add(`${exported.name}.${name}`);
      }
    }
  }
  return set;
}

const toOpenApiPath = (p) => `/api${p.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`.replace(/\/$/, '') || '/api';

function checkOpenApi() {
  const generated = generateOpenApi();
  const again = generateOpenApi();
  check('A1 OpenAPI export is reproducible (two isolated exports are identical)', canonical(generated) === canonical(again));
  const committed = fs.existsSync(DEFAULT_OUT) ? JSON.parse(fs.readFileSync(DEFAULT_OUT, 'utf8')) : null;
  check('A2 docs/api/openapi.json equals the compiled API contract', committed && canonical(committed) === canonical(generated),
    committed ? '' : 'missing: run npm run openapi:export');

  const doc = generated;
  const routes = routeInventory();
  const withBody = bodyHandlers();
  const opKey = (method, p) => `${method.toUpperCase()} ${p}`;
  const documented = new Map();
  for (const [p, item] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(item)) documented.set(opKey(m, p), op);
  const runtime = new Set(routes.map((r) => opKey(r.method, toOpenApiPath(r.path))));
  const missing = [...runtime].filter((k) => !documented.has(k));
  const extra = [...documented.keys()].filter((k) => !runtime.has(k));
  check(`A3 every runtime route is documented (${runtime.size} routes, ${documented.size} operations)`, missing.length === 0, list(missing));
  check('A4 no obsolete or undocumented-in-code Swagger operation', extra.length === 0, list(extra));

  const problems = { summary: [], security: [], publicSecurity: [], r401: [], r403: [], body: [], params: [], r429auth: [], limiter: [], requestId: [], success: [] };
  const gaps = [];
  for (const route of routes) {
    const key = opKey(route.method, toOpenApiPath(route.path));
    const op = documented.get(key);
    if (!op) continue;
    const codes = Object.keys(op.responses ?? {});
    const authenticated = route.guards.includes('JwtAuthGuard');
    if (!op.summary) problems.summary.push(key);
    if (authenticated && !(op.security ?? []).some((s) => 'access-token' in s)) problems.security.push(key);
    if (!authenticated && (op.security ?? []).length > 0) problems.publicSecurity.push(key);
    if (authenticated && !codes.includes('401')) problems.r401.push(key);
    if (route.roles && !codes.includes('403')) problems.r403.push(key);
    if (withBody.has(`${route.controller}.${route.handler}`)) {
      const schema = op.requestBody?.content?.['application/json']?.schema;
      if (!schema) problems.body.push(key);
    }
    for (const param of route.path.match(/:([A-Za-z0-9_]+)/g) ?? []) {
      if (!(op.parameters ?? []).some((p) => p.in === 'path' && p.name === param.slice(1))) problems.params.push(`${key} ${param}`);
    }
    if (route.guards.includes('AuthRateLimitGuard') && !codes.includes('429')) problems.r429auth.push(key);
    const exempt = route.path.startsWith('/health/');
    if (!exempt && !(codes.includes('429') && codes.includes('503') && op.responses['429'].headers?.['Retry-After'])) problems.limiter.push(key);
    if (Object.values(op.responses ?? {}).some((r) => !r.headers?.['X-Request-ID'])) problems.requestId.push(key);
    const ok = Object.entries(op.responses ?? {}).filter(([c]) => c.startsWith('2'));
    if (ok.length === 0) problems.success.push(key);
    if (ok.some(([c, r]) => c !== '204' && !r.content)) gaps.push(opKey(route.method, route.path));
  }
  check('A5 every operation has a summary', problems.summary.length === 0, list(problems.summary));
  check('A6 every JwtAuthGuard route declares bearer security', problems.security.length === 0, list(problems.security));
  check('A7 public routes declare no security requirement', problems.publicSecurity.length === 0, list(problems.publicSecurity));
  check('A8 every authenticated route documents 401', problems.r401.length === 0, list(problems.r401));
  check('A9 every role-guarded route documents 403', problems.r403.length === 0, list(problems.r403));
  check(`A10 every @Body handler documents its request schema (${withBody.size} handlers)`, problems.body.length === 0, list(problems.body));
  check('A11 every path parameter is documented', problems.params.length === 0, list(problems.params));
  check('A12 every auth rate-limited route documents 429', problems.r429auth.length === 0, list(problems.r429auth));
  check('A13 every API-wide limited route documents 429 + 503 with Retry-After (health exempt)', problems.limiter.length === 0, list(problems.limiter));
  check('A14 every response documents the X-Request-ID header', problems.requestId.length === 0, list(problems.requestId));
  check('A15 every operation documents a 2xx response', problems.success.length === 0, list(problems.success));

  const baseline = new Set(manifest.responseSchemaGaps.operations);
  const newGaps = gaps.filter((g) => !baseline.has(g));
  const fixed = [...baseline].filter((g) => !gaps.includes(g));
  check(`A16 no new operation without a success-response schema (${gaps.length} frozen gaps of ${runtime.size})`, newGaps.length === 0, list(newGaps));
  check('A17 the response-schema gap baseline is current (fixed operations removed from the manifest)', fixed.length === 0, list(fixed));

  const scheme = doc.components?.securitySchemes?.['access-token'];
  check('A18 bearer JWT security scheme "access-token" and the ErrorResponse schema exist', scheme?.type === 'http' && scheme.scheme === 'bearer' && doc.components?.schemas?.ErrorResponse);
  const text = JSON.stringify(doc);
  const undocumented = manifest.httpErrorCodes.filter((c) => !text.includes(c));
  check(`A19 every machine-readable error code is documented in OpenAPI (${manifest.httpErrorCodes.length})`, undocumented.length === 0, list(undocumented));
  const notInSource = manifest.httpErrorCodes.filter((c) => !sourceText().includes(`'${c}'`));
  check('A20 every catalogued error code still exists in the source', notInSource.length === 0, list(notInSource));
  return { routes, doc };
}

// ------------------------------------------------------------ B. Environment
let sourceCache;
function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'database', 'data-source.ts'));
  return files;
}
function sourceText() {
  sourceCache ??= sourceFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  return sourceCache;
}

/** Every environment variable read by the application code. */
function envInventory() {
  const patterns = [
    /\.(?:get|getOrThrow)(?:<[^>]*>)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g, // config.get('X')
    // helper(config, 'X', ...); userTokenTtlSeconds(config, purpose) takes a token purpose, not a variable
    /(?<!userTokenTtlSeconds)\(\s*[A-Za-z_.]*(?:config|env|Config|Env)[A-Za-z_.]*\s*,\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  ];
  const names = new Set();
  for (const re of patterns) for (const m of sourceText().matchAll(re)) names.add(m[1]);
  // RATE_LIMIT_<POLICY> overrides are built from the policy names at runtime.
  const rl = require(path.join(ROOT, 'dist', 'auth', 'rate-limit', 'auth-rate-limit.config.js'));
  for (const value of Object.values(rl)) {
    for (const policy of Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value).flat() : []) {
      if (policy && typeof policy.name === 'string') names.add(`RATE_LIMIT_${policy.name.toUpperCase()}`);
    }
  }
  return names;
}

/** Names documented as `NAME=` or `# NAME=` lines. */
function documentedNames(rel) {
  return new Set([...read(rel).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
}
function parseEnvFile(rel) {
  return Object.fromEntries([...read(rel).matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
}

/** Variables read by the platform/SDKs rather than by PawFlow code. */
const RUNTIME_VARIABLES = new Set(['TZ']);
const SENSITIVE = ['JWT_SECRET', 'RATE_LIMIT_HASH_SECRET', 'DB_PASSWORD', 'TURNSTILE_SECRET_KEY', 'PUSH_REGISTRATION_KEYS', 'PUSH_REGISTRATION_HASH_KEY', 'SMTP_PASSWORD'];

function runLoaders(env) {
  const dist = (rel) => require(path.join(ROOT, 'dist', rel));
  const config = { get: (k) => env[k], getOrThrow: (k) => { if (env[k] === undefined) throw new Error(`${k} is required`); return env[k]; } };
  const errors = [];
  const attempt = (name, fn) => { try { fn(); } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : 'error'}`); } };
  attempt('release', () => dist('config/deployment-environment.js').loadReleaseConfig(env));
  attempt('turnstile', () => dist('auth/bot-protection/turnstile.config.js').loadTurnstileConfig(config));
  attempt('auth-rate-limit', () => dist('auth/rate-limit/auth-rate-limit.config.js').loadAuthRateLimitConfig(config));
  attempt('api-rate-limit', () => dist('auth/rate-limit/auth-rate-limit.config.js').loadApiRateLimitConfig(config));
  attempt('logging', () => dist('common/observability/structured-logger.js').loadLoggingConfig(env));
  attempt('mail', () => dist('mail/mail-transport.js').createMailTransport(config));
  attempt('push-registration', () => dist('push-devices/push-registration.crypto.js').loadPushRegistrationKeys(config));
  attempt('push-delivery+worker', () => {
    const delivery = dist('push-delivery/push-delivery.config.js').loadPushDeliveryConfig(config);
    dist('push-delivery/worker/push-worker.config.js').loadPushWorkerConfig(config, delivery);
  });
  return errors;
}

function syntheticStaging(template) {
  const b64 = (n, fill) => Buffer.alloc(n, fill).toString('base64');
  const values = {
    DB_HOST: 'db.staging.invalid', DB_USERNAME: 'pawflow_staging_app', DB_PASSWORD: 'synthetic-password-0123', DB_DATABASE: 'pawflow_staging',
    JWT_SECRET: 'synthetic-jwt-secret-'.padEnd(48, 'j'), RATE_LIMIT_HASH_SECRET: 'synthetic-rate-limit-secret-'.padEnd(48, 'r'),
    CORS_ORIGINS: 'https://staging.pawflow.invalid', TRUST_PROXY: '10.0.0.0/8',
    TURNSTILE_SECRET_KEY: 'synthetic-turnstile-secret-'.padEnd(40, 't'), TURNSTILE_EXPECTED_HOSTNAMES: 'staging.pawflow.invalid',
    PUSH_REGISTRATION_KEYS: `k1:${b64(32, 7)}`, PUSH_REGISTRATION_HASH_KEY: b64(32, 9),
  };
  const env = { ...template };
  for (const [k, v] of Object.entries(env)) if (/<[^>]*>/.test(v)) env[k] = values[k] ?? '';
  return { env, unresolved: Object.keys(template).filter((k) => /<[^>]*>/.test(template[k]) && !(k in values)) };
}

function checkEnvironment() {
  const used = envInventory();
  const documented = documentedNames('.env.example');
  const undocumented = [...used].filter((n) => !documented.has(n)).sort();
  const obsolete = [...documented].filter((n) => !used.has(n) && !RUNTIME_VARIABLES.has(n)).sort();
  check(`B1 every variable read by the code is documented in .env.example (${used.size} variables)`, undocumented.length === 0, list(undocumented));
  check('B2 .env.example documents no obsolete variable', obsolete.length === 0, list(obsolete));

  const staging = parseEnvFile('.env.staging.example');
  const unknown = Object.keys(staging).filter((n) => !used.has(n) && !RUNTIME_VARIABLES.has(n));
  check('B3 .env.staging.example names only variables the code reads', unknown.length === 0, list(unknown));
  check('B4 .env.staging.example is a staging template', staging.NODE_ENV === 'staging');
  const asIs = runLoaders(staging);
  check('B5 the staging template is refused as-is (placeholders cannot start a server)', asIs.length > 0, `${asIs.length} loader refusal(s)`);
  const { env, unresolved } = syntheticStaging(staging);
  check('B6 every placeholder of the staging template has a synthetic test value', unresolved.length === 0, list(unresolved));
  const filled = runLoaders(env);
  check('B7 the staging template with synthetic values passes every configuration loader', filled.length === 0, list(filled, 4));
  const withoutProxy = runLoaders({ ...env, TRUST_PROXY: undefined, CORS_ORIGINS: 'http://localhost:3000' });
  check('B8 deleting TRUST_PROXY / using a localhost origin is refused in staging', withoutProxy.some((e) => e.includes('TRUST_PROXY')) && withoutProxy.some((e) => e.includes('CORS_ORIGINS')));

  const placeholders = [];
  for (const file of ['.env.example', '.env.staging.example']) {
    const values = parseEnvFile(file);
    for (const key of SENSITIVE) {
      const v = values[key];
      if (v !== undefined && v !== '' && !/^(k1:)?<.+>$/.test(v) && !/^your_[a-z_]+$/.test(v)) placeholders.push(`${file}:${key}`);
    }
  }
  check('B9 example files hold placeholders only for sensitive variables', placeholders.length === 0, list(placeholders));

  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const mustIgnore = ['.env', '.env.staging', '.env.production', '.env.local', '.env.production.local', '.env.staging.secret', 'backup-2026.backup', 'pawflow.dump', 'service-account.json', 'x-firebase-adminsdk-y.json'];
  const notIgnored = mustIgnore.filter((f) => git(['check-ignore', '-q', '--no-index', f]).status !== 0);
  check('B10 .gitignore covers real environment files, database dumps and credentials', notIgnored.length === 0, list(notIgnored));
  const tracked = git(['ls-files']).stdout.split('\n').filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.example'));
  const dumps = git(['ls-files']).stdout.split('\n').filter((f) => /\.(backup|dump|sql\.gz)$/.test(f));
  check('B11 no real environment file or database dump is tracked by Git', tracked.length === 0 && dumps.length === 0, list([...tracked, ...dumps]));
}

// ------------------------------------------------------------- C. Migrations
function checkMigrations() {
  const dir = path.join(ROOT, 'src', 'database', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
  const parsed = files.map((f) => /^(\d+)-([A-Za-z0-9]+)\.ts$/.exec(f));
  check('C1 every migration file is named <timestamp>-<Name>.ts', parsed.every(Boolean), list(files.filter((_, i) => !parsed[i])));
  const names = parsed.filter(Boolean).map((m) => `${m[2]}${m[1]}`);
  check(`C2 migration chain equals the frozen list (${manifest.migrations.length})`, JSON.stringify(names) === JSON.stringify(manifest.migrations),
    `source ${names.length}: ${list(names.filter((n) => !manifest.migrations.includes(n)).concat(manifest.migrations.filter((n) => !names.includes(n))))}`);
  const stamps = parsed.filter(Boolean).map((m) => Number(m[1]));
  check('C3 migration timestamps are unique and strictly increasing', stamps.every((t, i) => i === 0 || t > stamps[i - 1]) && new Set(names).size === names.length);

  const distDir = path.join(ROOT, 'dist', 'database', 'migrations');
  const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort();
  check('C4 compiled migrations match the source (dist is not stale)', JSON.stringify(distFiles.map((f) => f.replace(/\.js$/, ''))) === JSON.stringify(files.map((f) => f.replace(/\.ts$/, ''))));
  const bad = [];
  for (const [i, f] of distFiles.entries()) {
    const classes = Object.values(require(path.join(distDir, f))).filter((v) => typeof v === 'function');
    const cls = classes.find((c) => c.name === names[i]);
    if (!cls || typeof cls.prototype.up !== 'function' || typeof cls.prototype.down !== 'function') bad.push(f);
  }
  check('C5 every compiled migration exports class <Name><timestamp> with up() and down()', bad.length === 0, list(bad));

  const { expectedMigrationNames } = require(path.join(ROOT, 'dist', 'health', 'schema-status.service.js'));
  check('C6 the startup schema check expects exactly the frozen chain', JSON.stringify(expectedMigrationNames(distDir)) === JSON.stringify([...manifest.migrations].sort()));

  const syncOn = sourceFiles().filter((f) => /synchronize\s*:\s*true|migrationsRun\s*:\s*true|dropSchema\s*:\s*true/.test(fs.readFileSync(f, 'utf8')));
  const syncOff = ['src/app.module.ts', 'database/data-source.ts'].every((f) => /synchronize:\s*false/.test(read(f)));
  check('C7 schema synchronization / implicit migrations are never enabled (app and CLI data source)', syncOn.length === 0 && syncOff, list(syncOn.map((f) => path.relative(ROOT, f))));
}

// ---------------------------------------------------------- D. Traceability
function checkTraceability(routes) {
  const rel = 'docs/phase3/p3-be12-fe-be-traceability.md';
  if (!fs.existsSync(path.join(ROOT, rel))) {
    check('D1 FE-BE traceability matrix exists', false, rel);
    return;
  }
  const text = read(rel);
  const missing = routes.map((r) => `${r.method} ${r.path}`).filter((k) => !text.includes(`\`${k}\``));
  check(`D1 every route (${routes.length}) is mapped in the FE-BE traceability matrix`, missing.length === 0, list(missing));
  const codes = manifest.httpErrorCodes.filter((c) => !text.includes(c));
  check('D2 every machine-readable error code appears in the traceability matrix', codes.length === 0, list(codes));
}

// --------------------------------------------------------------- E. Secrets
function checkSecrets() {
  const files = ['docs/api/openapi.json', 'docs/api/release-manifest.json', '.env.example', '.env.staging.example',
    ...fs.readdirSync(path.join(ROOT, 'docs', 'phase3')).filter((f) => f.startsWith('p3-be12-') || f.startsWith('p3-be11-')).map((f) => `docs/phase3/${f}`),
    ...(fs.existsSync(path.join(ROOT, 'docs', 'api', 'README.md')) ? ['docs/api/README.md'] : [])];
  const patterns = [
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
    ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
    ['connection string with password', /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s<]+@/],
    ['service-account JSON', /"private_key_id"\s*:/],
  ];
  const hits = [];
  for (const f of files) {
    const t = read(f);
    for (const [label, re] of patterns) if (re.test(t)) hits.push(`${f}: ${label}`);
  }
  check(`E1 release documents contain no key material or token (${files.length} files)`, hits.length === 0, list(hits));

  // Local secrets: compared, never printed.
  const envFile = path.join(ROOT, '.env');
  let leaked = 0;
  if (fs.existsSync(envFile)) {
    const local = Object.fromEntries([...fs.readFileSync(envFile, 'utf8').matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
    const secrets = SENSITIVE.map((k) => local[k]).filter((v) => v && v.length >= 6);
    for (const f of files) if (secrets.some((s) => read(f).includes(s))) leaked++;
  }
  check('E2 no value of the local .env secrets appears in a release document', leaked === 0, leaked ? `${leaked} file(s)` : '');
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) throw new Error('dist/main.js not found: run `npm run build` first');
  require(path.join(ROOT, 'node_modules', 'reflect-metadata'));
  const { routes } = checkOpenApi();
  checkEnvironment();
  checkMigrations();
  checkTraceability(routes);
  checkSecrets();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nrelease-contract: ${results.length - failed} PASS, ${failed} FAIL`);
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`FAIL release-contract crashed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
