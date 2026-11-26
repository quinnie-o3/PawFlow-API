import {
  Body,
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  Injectable,
  Logger,
  Param,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsEmail, IsString, MinLength } from 'class-validator';
import request from 'supertest';

import {
  activeSessionRepository,
  sessionIdFor,
} from '../../../test/helpers/auth-session-fixture';
import { AdminActivityLogService } from '../../admin/admin-activity-log.service';
import { AdminActivityLogsController } from '../../admin/admin-activity-logs.controller';
import { Public } from '../../auth/decorators/public.decorator';
import { AuthSession } from '../../auth/entities/auth-session.entity';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../pipes/validation-pipe.options';
import { applyHttpObservability } from './http-observability';
import { currentRequestId } from './observability-context';
import { StructuredLogger } from './structured-logger';

const SECRET = 'p3-be09-http-spec-secret';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USERS: Record<string, { id: string; role: string; status: string }> = {
  '20': { id: '20', role: 'CUSTOMER', status: 'ACTIVE' },
  '40': { id: '40', role: 'ADMIN', status: 'ACTIVE' },
};

// Synthetic secrets and PII: none of these may ever appear in a log line.
const SYNTHETIC = {
  password: 'Sup3r-Secret-Passw0rd!',
  refreshToken: 'rt_9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc',
  fcmToken: 'fcmTok_dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeco8ohsN5PjL1iC2dNtk2BAokeMCg2ZXKqpc8FXKmhX94kIxQ',
  captchaToken: 'XXXX.DUMMY.TURNSTILE.TOKEN.XXXX',
  cookie: 'pf_session=cookie-secret-4f1d2a',
  email: 'jane.doe.private@example.com',
  phone: '0912345678',
  queryToken: 'qtok-71c2e9b45a',
  apiKey: 'apikey-5e6f7a8b9c',
  dbDetail: 'Key (email)=(leaked.person@example.com) already exists.',
  errorMessage: 'duplicate key value violates unique constraint "uq_users_email"',
};

class ProbeDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class FakeQueryFailedError extends Error {
  override readonly name = 'QueryFailedError';
  readonly code = '23505';
  readonly detail = SYNTHETIC.dbDetail;
  readonly driverError = { code: '23505', detail: SYNTHETIC.dbDetail };
}

@Injectable()
class ProbeService {
  private readonly logger = new Logger('ProbeService');

  async echo(id: string, delayMs: number): Promise<{ id: string; requestId: string | undefined }> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.logger.log(`probe ${id} for ${SYNTHETIC.email} with Bearer ${SYNTHETIC.refreshToken}`);
    return { id, requestId: currentRequestId() };
  }
}

@Public()
@Controller('probe')
class ProbeController {
  constructor(private readonly service: ProbeService) {}

  @Get('boom')
  boom(): never {
    throw new FakeQueryFailedError(SYNTHETIC.errorMessage);
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException({ statusCode: 409, error: 'Conflict', message: 'Already taken', code: 'PROBE_CONFLICT' });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.echo(id, Number(id) % 7);
  }

  @Post('body')
  async post(@Body() dto: ProbeDto) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { ok: dto.email.length > 0, requestId: currentRequestId() };
  }
}

/** Stand-in for the API root (AppController) that readiness probes hit. */
@Public()
@Controller()
class RootController {
  @Get()
  root() {
    return 'ok';
  }
}

type LogRecord = Record<string, unknown>;

describe('P3-BE09 HTTP correlation ID and structured logs', () => {
  let app: INestApplication;
  let tokens: Record<string, string>;
  const lines: string[] = [];
  const activityLogs = { getActivityLogs: jest.fn(), getActivityLogById: jest.fn() };

  const records = (): LogRecord[] => lines.map((line) => JSON.parse(line) as LogRecord);
  const completionFor = async (requestId: string): Promise<LogRecord[]> => {
    // The completion event fires on the response 'finish' event; wait for it briefly.
    for (let i = 0; i < 50; i++) {
      const found = records().filter((r) => r.requestId === requestId && String(r.event).startsWith('http.request.'));
      if (found.length > 0) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return [];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({ secret: SECRET })],
      controllers: [RootController, ProbeController, AdminActivityLogsController],
      providers: [
        ProbeService,
        JwtStrategy,
        // Authentication is global in AuthModule (APP_GUARD); mirror it here.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: ConfigService, useValue: { getOrThrow: () => SECRET } },
        { provide: getRepositoryToken(AuthSession), useValue: activeSessionRepository(USERS) },
        { provide: AdminActivityLogService, useValue: activityLogs },
      ],
    }).compile();

    app = moduleRef.createNestApplication({
      logger: new StructuredLogger({ format: 'json', minLevel: 'debug' }, (line) => lines.push(line)),
    });
    applyHttpObservability(app);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS));
    await app.init();
    // Listen once for the whole file. With a non-listening server, supertest binds it on the
    // first request and closes the SHARED server when that request ends, resetting the other
    // in-flight connections of a concurrent batch (CI: read ECONNRESET in the 60-request test).
    // A server that already listens is never bound or closed by supertest; afterAll closes it.
    await app.listen(0, '127.0.0.1');

    const jwt = moduleRef.get(JwtService);
    tokens = Object.fromEntries(
      Object.values(USERS).map((user) => [user.role, jwt.sign({ sub: user.id, role: user.role, sid: sessionIdFor(user.id) })]),
    );
  });

  afterAll(() => app.close());

  beforeEach(() => {
    activityLogs.getActivityLogs.mockReset().mockResolvedValue({ items: [], pagination: { limit: 20, offset: 0, total: 0 } });
  });

  describe('request ID contract', () => {
    it('generates a UUID v4 when the client sends none, and returns it in X-Request-ID', async () => {
      const res = await request(app.getHttpServer()).get('/api/probe/3').expect(200);
      const id = res.headers['x-request-id'];
      expect(id).toMatch(UUID_V4);
      expect(res.body).toEqual({ id: '3', requestId: id });
    });

    it.each([
      ['UUID', '6f1c2b9e-3d4a-4f5b-8c7d-9e0f1a2b3c4d'],
      ['ULID', '01HZY8V6Q3J5K7M9N1P3R5T7V9'],
      ['dotted trace id', 'web.checkout:7f3a-01'],
      ['8 characters (minimum)', 'abcd1234'],
      ['128 characters (maximum)', `a${'b'.repeat(127)}`],
    ])('keeps a valid client ID (%s)', async (_name, id) => {
      const res = await request(app.getHttpServer()).get('/api/probe/1').set('X-Request-ID', id).expect(200);
      expect(res.headers['x-request-id']).toBe(id);
      expect(res.body.requestId).toBe(id);
    });

    it.each([
      ['too short', 'abc1234'],
      ['too long', `a${'b'.repeat(128)}`],
      ['spaces', 'abc def ghi'],
      ['markup', '<script>alert(1)</script>'],
      ['leading separator', '-abcdefgh'],
      ['injection attempt', 'abcdefgh"},"level":"fatal'],
      ['percent-encoded', 'abc%0Ainjected'],
    ])('replaces an invalid client ID (%s) with a generated UUID', async (_name, id) => {
      const res = await request(app.getHttpServer()).get('/api/probe/2').set('X-Request-ID', id).expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID_V4);
      expect(res.headers['x-request-id']).not.toBe(id);
      expect(JSON.stringify(records())).not.toContain(id);
    });

    it('replaces a repeated header (two values) with a generated UUID', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/probe/2')
        // Two header lines (supertest sends an array as repeated headers; its typings only allow it for Cookie).
        .set('X-Request-ID', ['first-value-1', 'second-value-2'] as unknown as string)
        .expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID_V4);
    });

    it('isolates 60 concurrent requests: each sees only its own ID (response body, header, logs)', async () => {
      const ids = Array.from({ length: 60 }, (_, i) => `concurrent-${String(i).padStart(3, '0')}-${Date.now()}`);
      const responses = await Promise.all(
        ids.map((id, i) => request(app.getHttpServer()).get(`/api/probe/${i}`).set('X-Request-ID', id)),
      );
      responses.forEach((res, i) => {
        expect(res.status).toBe(200);
        expect(res.headers['x-request-id']).toBe(ids[i]);
        expect(res.body).toEqual({ id: String(i), requestId: ids[i] });
      });
      for (const [i, id] of ids.entries()) {
        const mine = records().filter((r) => r.requestId === id);
        // One service line (with its own path id) and one completion event, nothing else.
        expect(mine.map((r) => r.event).sort()).toEqual(['app.log', 'http.request.completed']);
        expect(mine.find((r) => r.event === 'app.log')?.message).toContain(`probe ${i} `);
      }
    });

    it('keeps the context through JSON body parsing and validation (POST)', async () => {
      const id = 'post-body-request-01';
      const res = await request(app.getHttpServer())
        .post('/api/probe/body')
        .set('X-Request-ID', id)
        .send({ email: SYNTHETIC.email, password: SYNTHETIC.password })
        .expect(201);
      expect(res.body).toEqual({ ok: true, requestId: id });
    });
  });

  describe('structured completion events', () => {
    it('logs exactly one JSON completion event with the normalized route, never the raw URL or query', async () => {
      const id = 'completion-shape-01';
      await request(app.getHttpServer())
        .get(`/api/probe/12345?token=${SYNTHETIC.queryToken}&email=${encodeURIComponent(SYNTHETIC.email)}`)
        .set('X-Request-ID', id)
        .expect(200);
      const [event, ...rest] = await completionFor(id);
      expect(rest).toHaveLength(0);
      expect(Object.keys(event)).toEqual(['timestamp', 'level', 'event', 'context', 'requestId', 'method', 'route', 'statusCode', 'durationMs', 'message']);
      expect(event).toMatchObject({
        level: 'info',
        event: 'http.request.completed',
        context: 'HttpRequest',
        requestId: id,
        method: 'GET',
        route: '/api/probe/:id',
        statusCode: 200,
      });
      expect(new Date(String(event.timestamp)).toISOString()).toBe(event.timestamp);
      expect(typeof event.durationMs).toBe('number');
      expect(event.durationMs as number).toBeGreaterThanOrEqual(0);
      expect(event.message).toMatch(/^GET \/api\/probe\/:id 200 \d+\.\dms$/);
      const text = lines.join('\n');
      expect(text).not.toContain('12345?');
      expect(text).not.toContain(SYNTHETIC.queryToken);
    });

    it('reports unmatched routes as /(unmatched) at warn level (404)', async () => {
      const id = 'unmatched-route-01';
      await request(app.getHttpServer()).get(`/api/no/such/${SYNTHETIC.email}`).set('X-Request-ID', id).expect(404);
      const [event] = await completionFor(id);
      expect(event).toMatchObject({ level: 'warn', route: '/(unmatched)', statusCode: 404 });
    });

    it('logs successful readiness probes of the API root at debug level', async () => {
      await request(app.getHttpServer()).get('/api').set('X-Request-ID', 'health-probe-001').expect(200);
      const [event] = await completionFor('health-probe-001');
      expect(event).toMatchObject({ level: 'debug', route: '/api', statusCode: 200 });
    });
  });

  describe('authentication, authorization, validation and error paths', () => {
    it.each([
      ['no token (401)', undefined, 401],
      ['customer token (403)', 'CUSTOMER', 403],
      ['admin token (200)', 'ADMIN', 200],
    ])('admin audit list with %s carries the request ID in header and log', async (_name, role, status) => {
      const id = `admin-audit-${status}-req`;
      const req = request(app.getHttpServer()).get('/api/admin/activity-logs').set('X-Request-ID', id);
      if (role) req.set('Authorization', `Bearer ${tokens[role]}`);
      const res = await req.expect(status);
      expect(res.headers['x-request-id']).toBe(id);
      const [event] = await completionFor(id);
      expect(event).toMatchObject({ requestId: id, route: '/api/admin/activity-logs', statusCode: status, level: status >= 400 ? 'warn' : 'info' });
      // The audit service is reached only by an authenticated administrator.
      expect(activityLogs.getActivityLogs).toHaveBeenCalledTimes(role === 'ADMIN' ? 1 : 0);
    });

    it('validation failure (400): unchanged error body, header present, no submitted values logged', async () => {
      const id = 'validation-failure-01';
      const res = await request(app.getHttpServer())
        .post('/api/probe/body')
        .set('X-Request-ID', id)
        .send({ email: SYNTHETIC.email, password: 'short', unexpected: SYNTHETIC.apiKey })
        .expect(400);
      expect(res.headers['x-request-id']).toBe(id);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      const [event] = await completionFor(id);
      expect(event).toMatchObject({ level: 'warn', statusCode: 400, route: '/api/probe/body' });
    });

    it('malformed JSON body (400 from the body parser) still gets a request ID and one event', async () => {
      const id = 'malformed-json-0001';
      const res = await request(app.getHttpServer())
        .post('/api/probe/body')
        .set('X-Request-ID', id)
        .set('Content-Type', 'application/json')
        .send(`{"password":"${SYNTHETIC.password}",`)
        .expect(400);
      expect(res.headers['x-request-id']).toBe(id);
      expect(await completionFor(id)).toHaveLength(1);
    });

    it('HttpException with an application code: body unchanged, errorCode logged', async () => {
      const id = 'http-conflict-0001';
      const res = await request(app.getHttpServer()).get('/api/probe/conflict').set('X-Request-ID', id).expect(409);
      expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', message: 'Already taken', code: 'PROBE_CONFLICT' });
      const [event] = await completionFor(id);
      expect(event).toMatchObject({ level: 'warn', statusCode: 409, errorCode: 'PROBE_CONFLICT' });
    });

    it('unhandled error (500): generic body, one error event with class and SQLSTATE only, no message/detail/stack', async () => {
      const id = 'unhandled-error-001';
      const before = lines.length;
      const res = await request(app.getHttpServer()).get('/api/probe/boom').set('X-Request-ID', id).expect(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(res.headers['x-request-id']).toBe(id);
      const [event, ...rest] = await completionFor(id);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({ level: 'error', statusCode: 500, errorName: 'QueryFailedError', dbCode: '23505', route: '/api/probe/boom' });
      const newLines = lines.slice(before).join('\n');
      // No separate ExceptionsHandler line, no message, no row values, no stack frames.
      expect(newLines).not.toContain('ExceptionsHandler');
      expect(newLines).not.toContain('uq_users_email');
      expect(newLines).not.toContain('leaked.person');
      expect(newLines).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
    });
  });

  describe('sensitive data protection', () => {
    it('application log lines carry the request ID; contact data and bearer credentials are scrubbed', async () => {
      const id = 'service-log-line-01';
      await request(app.getHttpServer()).get('/api/probe/4').set('X-Request-ID', id).expect(200);
      const line = records().find((r) => r.requestId === id && r.event === 'app.log');
      expect(line).toMatchObject({ level: 'info', context: 'ProbeService', requestId: id });
      expect(line?.message).toBe('probe 4 for [email] with Bearer [redacted]');
    });

    it('no credential, token, cookie or PII from any request path reaches the logs', async () => {
      const hostile = {
        Authorization: `Bearer ${tokens.ADMIN}`,
        Cookie: SYNTHETIC.cookie,
        'X-Api-Key': SYNTHETIC.apiKey,
        'X-Turnstile-Token': SYNTHETIC.captchaToken,
      };
      const body = { email: SYNTHETIC.email, password: SYNTHETIC.password, refreshToken: SYNTHETIC.refreshToken, fcmToken: SYNTHETIC.fcmToken, captchaToken: SYNTHETIC.captchaToken, phone: SYNTHETIC.phone };
      const query = `?token=${SYNTHETIC.queryToken}&email=${encodeURIComponent(SYNTHETIC.email)}`;
      const server = app.getHttpServer();
      await request(server).post(`/api/probe/body${query}`).set(hostile).send(body); // validation error
      await request(server).post(`/api/probe/body${query}`).set(hostile).send({ email: SYNTHETIC.email, password: SYNTHETIC.password }); // success
      await request(server).get(`/api/admin/activity-logs${query}`).set(hostile); // admin success
      await request(server).get(`/api/admin/activity-logs${query}`).set({ ...hostile, Authorization: `Bearer ${tokens.CUSTOMER}` }); // forbidden
      await request(server).get(`/api/admin/activity-logs${query}`).set({ ...hostile, Authorization: 'Bearer not-a-jwt-but-secret' }); // unauthorized
      await request(server).get(`/api/probe/boom${query}`).set(hostile); // internal error
      await request(server).get(`/api/probe/5${query}`).set(hostile); // service log line
      await new Promise((resolve) => setTimeout(resolve, 30));

      const text = lines.join('\n');
      for (const secret of [...Object.values(SYNTHETIC), tokens.ADMIN, tokens.CUSTOMER, 'not-a-jwt-but-secret', SECRET]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/eyJhbGciOi/);
      expect(text).not.toMatch(/authorization|cookie|x-api-key/i);
      // Every line is a single-line JSON object.
      for (const line of lines) {
        expect(line).not.toMatch(/[\r\n]/);
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
