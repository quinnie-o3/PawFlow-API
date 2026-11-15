/**
 * P3-BE10 full-application E2E (Jest): boots the REAL AppModule (every
 * module, DI graph, TypeORM, guards, global pipes and BE09 observability)
 * against a run-owned disposable PostgreSQL database, never the
 * development database.
 *
 *   npm run build      # migrations are run from dist/
 *   npm run test:e2e
 *
 * Safety: test/e2e-global-setup.cjs creates and migrates the run-owned
 * database pawflow_qa_e2e_<id> (qa-env.cjs refuses any other name or the
 * .env DB_DATABASE) and sets DB_* in process.env BEFORE AppModule is loaded
 * (ConfigModule never overrides existing variables). The suite aborts
 * unless the name is a QA name and the application's own connection
 * reports that database. Global teardown drops it.
 *
 * Replaces the generated Nest scaffold, which imported AppModule with the
 * repository .env (i.e. connected to pet_care_db) and asserted a
 * "Hello World!" route that does not exist.
 */
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

const NAME = process.env.E2E_DB_NAME ?? '';
const PASSWORD = 'QaE2ePassword123!';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('PawFlow API (full AppModule on a disposable PostgreSQL database)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    if (!/^pawflow_qa_e2e_[a-z0-9]+$/.test(NAME) || process.env.DB_DATABASE !== NAME) {
      throw new Error('E2E database not prepared by test/e2e-global-setup.cjs; refusing to start');
    }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      JWT_SECRET: `e2e-${Date.now()}-${Math.random()}`,
      TURNSTILE_MODE: 'disabled',
      AUTH_RATE_LIMIT: 'disabled',
      PUSH_DELIVERY_MODE: 'disabled',
      PUSH_WORKER_ENABLED: 'false',
      MAIL_TRANSPORT: 'disabled',
      LOG_LEVEL: 'warn',
    });

    // Loaded only now, so the variables above win over the repository .env.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
    const { applyHttpObservability } = require('../src/common/observability/http-observability') as typeof import('../src/common/observability/http-observability');
    const { GLOBAL_VALIDATION_PIPE_OPTIONS } = require('../src/common/pipes/validation-pipe.options') as typeof import('../src/common/pipes/validation-pipe.options');
    const { loadLoggingConfig, StructuredLogger } = require('../src/common/observability/structured-logger') as typeof import('../src/common/observability/structured-logger');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: new StructuredLogger(loadLoggingConfig(process.env)) });
    applyHttpObservability(app);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS));
    await app.init();

    // Hard stop before any request if the application is not on the QA database.
    const [{ current }] = (await app.get(DataSource).query('select current_database() as current')) as Array<{ current: string }>;
    if (current !== NAME) throw new Error(`ISOLATION FAILURE: application connected to ${current}`);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it('runs on the run-owned QA database with every migration applied', async () => {
    const dataSource = app.get(DataSource);
    expect(dataSource.options.database).toBe(NAME);
    expect(process.env.E2E_MIGRATIONS).toBe('17');
    const [{ n }] = (await dataSource.query('select count(*)::int as n from migrations')) as Array<{ n: number }>;
    expect(n).toBe(17);
  });

  it('serves the API root with a correlation ID', async () => {
    const res = await request(app.getHttpServer()).get('/api').expect(200);
    expect(res.headers['x-request-id']).toMatch(UUID_V4);
  });

  it('register -> login -> me -> refresh rotation -> reuse detection -> logout, through the real stack', async () => {
    const server = app.getHttpServer();
    const email = `e2e.${Date.now()}@qa.test`;

    await request(server).post('/api/auth/register').send({ fullName: 'E2E User', email, password: PASSWORD }).expect(201);
    const login = await request(server).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    const { accessToken, refreshToken } = login.body as { accessToken: string; refreshToken: string };

    const me = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body).toMatchObject({ user: { email, role: 'CUSTOMER' } });
    expect(JSON.stringify(me.body)).not.toMatch(/password/i);

    const rotated = await request(server).post('/api/auth/refresh').send({ refreshToken }).expect(200);
    expect(rotated.body.refreshToken).not.toBe(refreshToken);

    // Reusing the rotated-out token is reuse detection: rejected, and the session family is revoked.
    await request(server).post('/api/auth/refresh').send({ refreshToken }).expect(401);
    await request(server).get('/api/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(401);

    const again = await request(server).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${again.body.accessToken}`).send({ refreshToken: again.body.refreshToken }).expect((r) => expect([200, 201, 204]).toContain(r.status));
    await request(server).get('/api/auth/me').set('Authorization', `Bearer ${again.body.accessToken}`).expect(401);
  });

  it('rejects anonymous and forged access with the standard error body', async () => {
    const server = app.getHttpServer();
    const anon = await request(server).get('/api/bookings/mine').expect(401);
    expect(anon.body).toMatchObject({ statusCode: 401 });
    expect(anon.headers['x-request-id']).toMatch(UUID_V4);
    await request(server).get('/api/admin/activity-logs').set('Authorization', 'Bearer forged.token.value').expect(401);
  });
});
