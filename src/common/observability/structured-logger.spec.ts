import { Logger } from '@nestjs/common';

import { ALLOWED_EVENT_FIELDS, sanitizeEventFields, sanitizeLogText } from './log-fields';
import {
  currentJobContext,
  currentRequestId,
  logEvent,
  type RequestContext,
  runWithJobContext,
  runWithRequestContext,
} from './observability-context';
import { acceptRequestId, resolveRequestId } from './request-id';
import { loadLoggingConfig, StructuredLogger } from './structured-logger';

const request = (requestId: string): RequestContext => ({ requestId, startedAt: process.hrtime.bigint() });

function capture(minLevel: 'debug' | 'info' | 'warn' = 'debug', format: 'json' | 'text' = 'json') {
  const lines: string[] = [];
  const logger = new StructuredLogger({ format, minLevel }, (line) => lines.push(line));
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, records };
}

describe('request ID input contract', () => {
  it.each(['6f1c2b9e-3d4a-4f5b-8c7d-9e0f1a2b3c4d', 'abcd1234', 'Trace.ID:42-x_y', `A${'z'.repeat(127)}`])('accepts %s', (id) => {
    expect(acceptRequestId(id)).toBe(id);
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([
    undefined, null, 42, ['abcd1234'], '', 'abc', 'abcd123', `A${'z'.repeat(128)}`, 'has space1', 'line\nbreak1', 'tab\tchar12',
    '_leading_', '.leading1', 'quote"char1', 'semi;colon1', 'slash/path1', 'unicodeé1234', 'a,b,c,d,e,f',
  ])('rejects %p and generates a fresh UUID v4', (value) => {
    expect(acceptRequestId(value)).toBeNull();
    const generated = resolveRequestId(value);
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(resolveRequestId(value)).not.toBe(generated);
  });
});

describe('safe text and field allowlist', () => {
  it.each([
    ['Bearer credentials', 'auth Bearer abc.def.ghi failed', 'auth Bearer [redacted] failed'],
    ['Basic credentials', 'Basic dXNlcjpwYXNz rejected', 'Basic [redacted] rejected'],
    ['JWTs', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl here', 'token [jwt] here'],
    ['key=value secrets', 'password=hunter22 refresh_token: rt-123 api-key="k 1" ok', 'password=[redacted] refresh_token: [redacted] api-key=[redacted] ok'],
    ['e-mail addresses', 'mail to Jane.Doe+x@mail.example.co.uk failed', 'mail to [email] failed'],
    ['phone numbers', 'call 0912345678 or +84912345678', 'call [phone] or [phone]'],
    ['long opaque tokens', `device ${'dQw4w9WgXcQ:APA91b'.repeat(4)} gone`, 'device [opaque] gone'],
    ['line breaks and control characters (log injection)', 'line1\nFAKE level=error\r\u0000\u001b[31m\u2028end', 'line1 FAKE level=error [31m end'],
  ])('scrubs %s', (_name, input, expected) => {
    expect(sanitizeLogText(input)).toBe(expected);
  });

  it('keeps masked recipients, internal ids and UUIDs readable', () => {
    const text = 'Mail PASSWORD_RESET to d***@qa.test via smtp accepted; user 12 job 6f1c2b9e-3d4a-4f5b-8c7d-9e0f1a2b3c4d';
    expect(sanitizeLogText(text)).toBe(text);
  });

  it('bounds the message length', () => {
    const text = sanitizeLogText('word '.repeat(500));
    expect(text).toHaveLength(512);
    expect(text.endsWith('…')).toBe(true);
  });

  it('keeps only allowlisted, valid fields in a fixed order', () => {
    expect(
      sanitizeEventFields({
        password: 'x', body: { a: 1 }, headers: { authorization: 'Bearer x' }, url: '/api/x?token=1', email: 'a@b.cd',
        durationMs: 12.3456, statusCode: 201, route: '/api/providers/:id', method: 'POST',
      }),
    ).toEqual({ method: 'POST', route: '/api/providers/:id', statusCode: 201, durationMs: 12.35 });
    expect(Object.keys(sanitizeEventFields({ durationMs: 1, method: 'GET', statusCode: 200 }))).toEqual(['method', 'statusCode', 'durationMs']);
  });

  it.each([
    ['method', 'TRACE'], ['route', '/api/x y'], ['route', 'api/no-leading-slash'], ['statusCode', 700], ['statusCode', '200'],
    ['durationMs', -1], ['durationMs', Number.NaN], ['errorCode', 'lower_case'], ['errorName', 'Bad Name!'], ['dbCode', '2350'],
    ['notificationId', 'a b'], ['attempt', 1.5], ['outcome', 'done'], ['code', 'x'.repeat(61)], ['retryDelayMs', -5],
  ])('drops an invalid %s value (%p)', (key, value) => {
    expect(sanitizeEventFields({ [key]: value })).toEqual({});
  });

  it('allows no identity, credential or content field', () => {
    for (const forbidden of ['userId', 'email', 'password', 'token', 'authorization', 'cookie', 'body', 'query', 'url', 'headers', 'ip', 'message', 'stack']) {
      expect(ALLOWED_EVENT_FIELDS).not.toContain(forbidden);
    }
  });
});

describe('StructuredLogger', () => {
  it('writes one JSON object per line with a stable key order and maps Nest levels', () => {
    const { logger, records } = capture();
    logger.log('started', 'Bootstrap');
    logger.warn('careful', 'Svc');
    logger.error('broken', undefined, 'Svc');
    logger.debug('details', 'Svc');
    logger.verbose('more details', 'Svc');
    logger.fatal('down', 'Svc');
    expect(records().map((r) => r.level)).toEqual(['info', 'warn', 'error', 'debug', 'debug', 'fatal']);
    expect(Object.keys(records()[0])).toEqual(['timestamp', 'level', 'event', 'context', 'message']);
    expect(records()[0]).toMatchObject({ event: 'app.log', context: 'Bootstrap', message: 'started' });
  });

  it('filters by minimum level', () => {
    const { logger, records } = capture('warn');
    logger.debug('d');
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    expect(records().map((r) => r.message)).toEqual(['w', 'e']);
  });

  it('never serializes Error objects, stack traces or arbitrary objects (Error: class + scrubbed message only)', () => {
    const { logger, lines, records } = capture();
    const error = Object.assign(new Error('duplicate key (email)=(x@y.zz)\ntoken=abc123'), { name: 'QueryFailedError', detail: 'secret detail' });
    logger.error(error, error.stack, 'ExceptionHandler');
    logger.error('request failed', 'Error: boom\n    at Foo (/app/src/foo.ts:1:2)', 'Svc');
    logger.log({ password: 'p4ss', token: 't0k' }, 'Svc');
    expect(records()[0]).toEqual({
      timestamp: expect.any(String), level: 'error', event: 'app.log', context: 'ExceptionHandler',
      message: 'duplicate key (email)=([email]) token=[redacted]', errorName: 'QueryFailedError',
    });
    expect(records()[1]).toMatchObject({ message: 'request failed' });
    expect(records()[2]).toMatchObject({ message: '[non-text message omitted]' });
    const text = lines.join('\n');
    for (const leaked of ['x@y.zz', 'abc123', 'secret detail', 'foo.ts', ' at ', 'p4ss', 't0k']) expect(text).not.toContain(leaked);
  });

  it('keeps startup configuration errors explainable', () => {
    const { logger, records } = capture();
    logger.error(new Error('PUSH_WORKER_ENABLED=true requires PUSH_DELIVERY_MODE=mock or firebase'), undefined, 'ExceptionHandler');
    expect(records()[0]).toMatchObject({ level: 'error', errorName: 'Error', message: 'PUSH_WORKER_ENABLED=true requires PUSH_DELIVERY_MODE=mock or firebase' });
  });

  it('adds requestId / jobId from the async context, isolated between concurrent flows', async () => {
    const { logger, records } = capture();
    const flow = (id: string, delay: number) =>
      runWithRequestContext(request(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        logger.log(`in ${id}`);
      });
    const job = (id: string, delay: number) =>
      runWithJobContext({ jobId: id, attempt: 2 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        logger.log(`in job ${id}`);
      });
    await Promise.all([flow('request-aaaa-1', 15), flow('request-bbbb-2', 5), job('77', 10), job('78', 1)]);
    logger.log('outside');
    const byMessage = Object.fromEntries(records().map((r) => [r.message, r]));
    expect(byMessage['in request-aaaa-1']).toMatchObject({ requestId: 'request-aaaa-1' });
    expect(byMessage['in request-bbbb-2']).toMatchObject({ requestId: 'request-bbbb-2' });
    expect(byMessage['in job 77']).toMatchObject({ jobId: '77', attempt: 2 });
    expect(byMessage['in job 77']).not.toHaveProperty('requestId');
    expect(byMessage['in job 78']).toMatchObject({ jobId: '78' });
    expect(byMessage.outside).not.toHaveProperty('requestId');
    expect(byMessage.outside).not.toHaveProperty('jobId');
    expect(currentRequestId()).toBeUndefined();
    expect(currentJobContext()).toBeUndefined();
  });

  it('renders logEvent fields through the allowlist and keeps the plain message for other loggers', () => {
    const { logger, records } = capture();
    Logger.overrideLogger(logger);
    const nest = new Logger('Orders');
    runWithRequestContext(request('event-request-1'), () =>
      logEvent(nest, 'warn', 'orders.sync.completed', { statusCode: 202, durationMs: 3.14159, password: 'nope', email: 'a@b.cd' }, 'sync done'),
    );
    expect(records()[0]).toEqual({
      timestamp: expect.any(String), level: 'warn', event: 'orders.sync.completed', context: 'Orders',
      requestId: 'event-request-1', statusCode: 202, durationMs: 3.14, message: 'sync done',
    });

    const plain: string[] = [];
    Logger.overrideLogger({ log: (m: unknown) => plain.push(String(m)), warn: (m: unknown) => plain.push(String(m)), error: () => undefined });
    logEvent(nest, 'warn', 'orders.sync.completed', { statusCode: 202 }, 'sync done');
    expect(plain).toEqual(['sync done']);
    Logger.overrideLogger(logger);
  });

  it('falls back to app.log for an invalid event name and never throws on writer failure', () => {
    const { logger, records } = capture();
    Logger.overrideLogger(logger);
    logEvent(new Logger('X'), 'info', 'Not A Valid Name', {}, 'hello');
    expect(records()[0]).toMatchObject({ event: 'app.log', message: 'hello' });

    const failing = new StructuredLogger({ format: 'json', minLevel: 'debug' }, () => {
      throw new Error('disk full');
    });
    expect(() => failing.error('anything')).not.toThrow();
    Logger.overrideLogger(failing);
    expect(() => logEvent(new Logger('X'), 'error', 'x.y', {}, 'boom')).not.toThrow();
  });

  it('renders a single human-readable line in text format', () => {
    const { logger, lines } = capture('debug', 'text');
    runWithRequestContext(request('text-request-1'), () => logger.warn('slow\nquery', 'Db'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z WARN  \[Db\] slow query requestId=text-request-1$/);
  });
});

describe('loadLoggingConfig', () => {
  it('defaults: json; info in production, debug otherwise', () => {
    expect(loadLoggingConfig({})).toEqual({ format: 'json', minLevel: 'debug' });
    expect(loadLoggingConfig({ NODE_ENV: 'production' })).toEqual({ format: 'json', minLevel: 'info' });
    expect(loadLoggingConfig({ LOG_FORMAT: ' TEXT ', LOG_LEVEL: 'Warn' })).toEqual({ format: 'text', minLevel: 'warn' });
  });

  it.each([
    [{ LOG_FORMAT: 'xml' }, 'LOG_FORMAT'],
    [{ LOG_FORMAT: 'text', NODE_ENV: 'production' }, 'not allowed'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    [{ LOG_LEVEL: '' }, 'LOG_LEVEL'],
  ])('refuses %j', (env, message) => {
    expect(() => loadLoggingConfig(env)).toThrow(message);
  });
});
