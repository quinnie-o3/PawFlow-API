import { Body, Controller, Get, type INestApplication, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsString } from 'class-validator';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { activeSessionRepository, sessionIdFor } from '../../../test/helpers/auth-session-fixture';
import { AuthSession } from '../../auth/entities/auth-session.entity';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ApiRateLimitGuard, ApiUserRateLimitInterceptor } from '../../auth/rate-limit/api-rate-limit';
import { AuthRateLimitService, RateLimitedException } from '../../auth/rate-limit/auth-rate-limit.service';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { HealthController } from '../../health/health.controller';
import { SchemaStatusService } from '../../health/schema-status.service';
import { applyHttpObservability } from '../observability/http-observability';
import { REQUEST_ID_HEADER } from '../observability/request-id';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../pipes/validation-pipe.options';
import { API_CSP, corsOptions, DOCS_CSP, PERMISSIONS_POLICY, securityHeadersMiddleware } from './http-security';

const SECRET = 'p3-be11-http-security-spec';
const STAGING_ORIGIN = 'https://staging.pawflow.example';
const LOCAL_ORIGIN = 'http://localhost:3000';
const USERS = { '20': { id: '20', role: 'CUSTOMER', status: 'ACTIVE' } };

class NameDto {
  @IsString()
  name!: string;
}

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('limited')
  limited(): never {
    throw new RateLimitedException(7);
  }

  @Get('boom')
  boom(): never {
    throw new Error('internal detail with secret value');
  }

  @Post('body')
  body(@Body() dto: NameDto) {
    return dto;
  }

  @Get('secure')
  @UseGuards(JwtAuthGuard)
  secure() {
    return { secure: true };
  }

  @Post('secure')
  @UseGuards(JwtAuthGuard)
  secureWrite() {
    return { written: true };
  }
}

interface Harness {
  app: INestApplication;
  consumeApi: jest.Mock;
  query: jest.Mock;
  schema: { status: string };
  token: string;
}

async function harness(trustProxy: false | string[], hstsMaxAgeSeconds = 31_536_000): Promise<Harness> {
  const consumeApi = jest.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0, hits: {} });
  const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
  const schema = { status: 'current' };
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({ secret: SECRET })],
    controllers: [ProbeController, HealthController],
    providers: [
      JwtStrategy,
      { provide: ConfigService, useValue: { getOrThrow: () => SECRET, get: (k: string) => (k === 'HEALTH_DB_TIMEOUT_MS' ? '150' : undefined) } },
      { provide: getRepositoryToken(AuthSession), useValue: activeSessionRepository(USERS) },
      { provide: AuthRateLimitService, useValue: { consumeApi } },
      { provide: DataSource, useValue: { query } },
      { provide: SchemaStatusService, useValue: schema },
      { provide: APP_GUARD, useClass: ApiRateLimitGuard },
      { provide: APP_INTERCEPTOR, useClass: ApiUserRateLimitInterceptor },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.disable('x-powered-by');
  applyHttpObservability(app);
  app.use(securityHeadersMiddleware({ hstsMaxAgeSeconds }));
  app.set('trust proxy', trustProxy);
  app.setGlobalPrefix('api');
  app.enableCors(corsOptions([LOCAL_ORIGIN, STAGING_ORIGIN], [REQUEST_ID_HEADER, 'Retry-After']));
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS));
  await app.init();
  const token = moduleRef.get(JwtService).sign({ sub: '20', role: 'CUSTOMER', sid: sessionIdFor('20') });
  return { app, consumeApi, query, schema, token };
}

const expectSecurityHeaders = (headers: Record<string, string>, csp = API_CSP) => {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY);
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['content-security-policy']).toBe(csp);
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
};

describe('P3-BE11 HTTP security (direct exposure: TRUST_PROXY unset)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness(false);
  });
  afterAll(() => h.app.close());
  beforeEach(() => h.consumeApi.mockClear());

  describe('security headers on every kind of response', () => {
    it.each([
      ['200 success', 'get', '/api/probe/ok', 200],
      ['401 authentication failure', 'get', '/api/probe/secure', 401],
      ['404 unknown route', 'get', '/api/nope', 404],
      ['500 internal error', 'get', '/api/probe/boom', 500],
      ['200 liveness', 'get', '/api/health/live', 200],
    ] as const)('%s', async (_name, method, url, status) => {
      const res = await request(h.app.getHttpServer())[method](url).expect(status);
      expectSecurityHeaders(res.headers);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('400 validation failure', async () => {
      const res = await request(h.app.getHttpServer()).post('/api/probe/body').send({ name: 1 }).expect(400);
      expectSecurityHeaders(res.headers);
    });

    it('429: unchanged error contract, Retry-After, correlation ID, security headers', async () => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/limited').set(REQUEST_ID_HEADER, 'rate-limit-probe-01').expect(429);
      expect(res.body).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too many requests; please try again later', code: 'RATE_LIMITED', retryAfterSeconds: 7 });
      expect(res.headers['retry-after']).toBe('7');
      expect(res.headers['x-request-id']).toBe('rate-limit-probe-01');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('internal errors expose no detail', async () => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/boom').expect(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });

    it('Swagger paths get the documentation CSP (scripts only from self) and remain cacheable', async () => {
      for (const path of ['/api/docs', '/api/docs/swagger-ui-init.js', '/api/docs-json']) {
        const res = await request(h.app.getHttpServer()).get(path);
        expect(res.headers['content-security-policy']).toBe(DOCS_CSP);
        expect(res.headers['cache-control']).toBeUndefined();
      }
      expect(DOCS_CSP).toContain("script-src 'self'");
      expect(DOCS_CSP).not.toMatch(/script-src[^;]*unsafe/);
    });
  });

  describe('HTTPS awareness', () => {
    it('plain HTTP: no HSTS', async () => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/ok');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('a spoofed X-Forwarded-Proto: https from an untrusted peer does not make the request HTTPS', async () => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/ok').set('X-Forwarded-Proto', 'https');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });
  });

  describe('client identity for rate limiting', () => {
    it('ignores X-Forwarded-For, CF-Connecting-IP and X-Real-IP from an untrusted peer', async () => {
      await request(h.app.getHttpServer()).get('/api/probe/ok').set({ 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '198.51.100.7', 'X-Real-IP': '192.0.2.1' });
      const ip = h.consumeApi.mock.calls[0][1].ip as string;
      expect(ip).toMatch(/127\.0\.0\.1|::1/);
      expect(ip).not.toMatch(/203\.0\.113|198\.51\.100|192\.0\.2/);
    });

    it('public routes count against api + public (per IP); guarded routes against api only, before authentication', async () => {
      await request(h.app.getHttpServer()).get('/api/probe/ok');
      await request(h.app.getHttpServer()).get('/api/probe/secure').expect(401);
      expect(h.consumeApi.mock.calls.map((c) => c[0])).toEqual([['api', 'public'], ['api']]);
    });

    it('authenticated requests also count per verified user: reads and writes separately', async () => {
      await request(h.app.getHttpServer()).get('/api/probe/secure').set('Authorization', `Bearer ${h.token}`).expect(200);
      await request(h.app.getHttpServer()).post('/api/probe/secure').set('Authorization', `Bearer ${h.token}`).expect(201);
      expect(h.consumeApi.mock.calls.filter((c) => c[1].userId).map((c) => [c[0], c[1].userId])).toEqual([[['user-read'], '20'], [['user-write'], '20']]);
    });

    it('a spoofed identity header never becomes the user key', async () => {
      await request(h.app.getHttpServer()).get('/api/probe/ok').set({ 'X-User-Id': '1', 'X-User-ID': '1' });
      expect(h.consumeApi.mock.calls.some((c) => c[1].userId)).toBe(false);
    });

    it('health probes are exempt from the API limits', async () => {
      await request(h.app.getHttpServer()).get('/api/health/live').expect(200);
      await request(h.app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(h.consumeApi).not.toHaveBeenCalled();
    });

    it('a 429 from the limiter is returned as 429 (not 401/403/500), with Retry-After', async () => {
      h.consumeApi.mockRejectedValueOnce(new RateLimitedException(30));
      const res = await request(h.app.getHttpServer()).get('/api/probe/secure').set('Authorization', 'Bearer forged').expect(429);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.body.code).toBe('RATE_LIMITED');
    });
  });

  describe('CORS allowlist', () => {
    it.each([LOCAL_ORIGIN, STAGING_ORIGIN])('allowed origin %s: exact echo, credentials, exposed X-Request-ID, Vary: Origin', async (origin) => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/ok').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toContain('X-Request-ID');
      expect(res.headers.vary).toMatch(/Origin/);
    });

    it.each([
      ['unknown origin', 'https://evil.example'],
      ['suffix attack', `${STAGING_ORIGIN}.evil.example`],
      ['prefix attack', 'https://evilstaging.pawflow.example'],
      ['scheme downgrade', 'http://staging.pawflow.example'],
      ['other port', 'http://localhost:3999'],
      ['null origin', 'null'],
      ['malformed', 'not a url'],
    ])('%s gets no CORS permission', async (_name, origin) => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/ok').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('no Origin header (server-to-server): no CORS headers, request served', async () => {
      const res = await request(h.app.getHttpServer()).get('/api/probe/ok').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('preflight for an allowed origin: 204, explicit methods and headers only', async () => {
      const res = await request(h.app.getHttpServer())
        .options('/api/probe/body')
        .set({ Origin: STAGING_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-evil' })
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(STAGING_ORIGIN);
      expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,POST,PUT,PATCH,DELETE');
      expect(res.headers['access-control-allow-headers']).toBe('Authorization,Content-Type,Idempotency-Key,X-Request-ID');
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('preflight for a disallowed origin gets no CORS permission', async () => {
      const res = await request(h.app.getHttpServer()).options('/api/probe/body').set({ Origin: 'https://evil.example', 'Access-Control-Request-Method': 'DELETE' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('CORS is not authorization: an allowed origin without a token still gets 401', async () => {
      await request(h.app.getHttpServer()).get('/api/probe/secure').set('Origin', STAGING_ORIGIN).expect(401);
    });
  });

  describe('health endpoints', () => {
    it('liveness: minimal body, no dependency', async () => {
      h.query.mockClear();
      const res = await request(h.app.getHttpServer()).get('/api/health/live').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(h.query).not.toHaveBeenCalled();
    });

    it('readiness: database up and schema current -> 200', async () => {
      const res = await request(h.app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', schema: 'current' } });
      expect(h.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('database unavailable -> 503 without any error detail', async () => {
      h.query.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=secret'), { code: 'ECONNREFUSED' }));
      const res = await request(h.app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'down', schema: 'current' } });
      expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|password|ECONNREFUSED/);
    });

    it('database hanging -> 503 "timeout" within HEALTH_DB_TIMEOUT_MS', async () => {
      h.query.mockReturnValueOnce(new Promise(() => undefined));
      const started = Date.now();
      const res = await request(h.app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(res.body.checks.database).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('schema not at this build\'s level -> 503', async () => {
      h.schema.status = 'pending';
      const res = await request(h.app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'up', schema: 'pending' } });
      h.schema.status = 'current';
    });
  });
});

describe('P3-BE11 HTTP security behind a trusted proxy (TRUST_PROXY=loopback)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness(['loopback']);
  });
  afterAll(() => h.app.close());

  it('X-Forwarded-Proto: https from the trusted proxy -> HSTS', async () => {
    const res = await request(h.app.getHttpServer()).get('/api/probe/ok').set('X-Forwarded-Proto', 'https');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('HTTP through the trusted proxy -> no HSTS', async () => {
    const res = await request(h.app.getHttpServer()).get('/api/probe/ok').set('X-Forwarded-Proto', 'http');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('the client address comes from X-Forwarded-For set by the trusted proxy (CF-Connecting-IP is never read)', async () => {
    h.consumeApi.mockClear();
    await request(h.app.getHttpServer()).get('/api/probe/ok').set({ 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '198.51.100.7' });
    expect(h.consumeApi.mock.calls[0][1].ip).toBe('203.0.113.9');
  });

  it('HSTS can be disabled entirely', async () => {
    const off = await harness(['loopback'], 0);
    const res = await request(off.app.getHttpServer()).get('/api/probe/ok').set('X-Forwarded-Proto', 'https');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    await off.app.close();
  });
});
