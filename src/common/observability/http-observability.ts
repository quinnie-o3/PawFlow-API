import {
  type ArgumentsHost,
  Catch,
  type HttpServer,
  HttpException,
  HttpStatus,
  type INestApplication,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';

import {
  DB_CODE_PATTERN,
  ERROR_CODE_PATTERN,
  ERROR_NAME_PATTERN,
} from './log-fields';
import {
  type EventLevel,
  logEvent,
  type RequestContext,
  runWithRequestContext,
} from './observability-context';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

const REQUEST_CONTEXT = Symbol('pawflow.requestContext');

type RequestWithContext = Request & { [REQUEST_CONTEXT]?: RequestContext };

const httpLogger = new Logger('HttpRequest');

/** The request context attached by requestContextMiddleware, if any. */
export function requestContextOf(request: unknown): RequestContext | undefined {
  return typeof request === 'object' && request !== null
    ? (request as RequestWithContext)[REQUEST_CONTEXT]
    : undefined;
}

/**
 * First middleware of the application (registered before body parsing,
 * routing and guards):
 * - resolves the authoritative request ID and sets the `X-Request-ID`
 *   response header, so every response carries it, including body-parser
 *   errors, 401/403 from guards, validation errors and unhandled errors;
 * - stores the context on the request and runs the rest of the chain inside
 *   its AsyncLocalStorage context;
 * - emits exactly one completion event per request when the response
 *   finishes (or `http.request.aborted` when the client disconnects first).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const context: RequestContext = {
    requestId: resolveRequestId(req.headers['x-request-id']),
    startedAt: process.hrtime.bigint(),
  };
  (req as RequestWithContext)[REQUEST_CONTEXT] = context;
  res.setHeader(REQUEST_ID_HEADER, context.requestId);

  let finished = false;
  res.once('finish', () => {
    finished = true;
    logCompletion(req, res, context, false);
  });
  res.once('close', () => {
    if (!finished) logCompletion(req, res, context, true);
  });

  runWithRequestContext(context, next);
}

/**
 * Normalized route template (`/api/providers/:id`), never the raw URL: path
 * parameters and query strings may carry identifiers, e-mails or tokens.
 * Requests that matched no route are reported as `/(unmatched)`; this
 * includes Nest's 404 catch-all, a wildcard route (`/api*path`). The
 * application declares no wildcard routes of its own.
 */
export function routeTemplate(req: Request): string {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' && !path.includes('*') ? `${req.baseUrl ?? ''}${path}` : '/(unmatched)';
}

/** The API root answers readiness probes (QA, load balancers): successful hits are logged at debug. */
const HEALTH_ROUTES = new Set(['/api', '/api/']);

function completionLevel(req: Request, statusCode: number, route: string, aborted: boolean): EventLevel {
  if (statusCode >= 500) return 'error';
  if (aborted || statusCode >= 400) return 'warn';
  return req.method === 'GET' && HEALTH_ROUTES.has(route) ? 'debug' : 'info';
}

function logCompletion(req: Request, res: Response, context: RequestContext, aborted: boolean): void {
  try {
    const durationMs = Number(process.hrtime.bigint() - context.startedAt) / 1e6;
    const route = routeTemplate(req);
    const statusCode = res.statusCode;
    const method = req.method;
    logEvent(
      httpLogger,
      completionLevel(req, statusCode, route, aborted),
      aborted ? 'http.request.aborted' : 'http.request.completed',
      {
        method,
        route,
        statusCode,
        durationMs,
        errorCode: context.errorCode,
        errorName: context.errorName,
        dbCode: context.dbCode,
      },
      // Built only from validated parts; the event fields are the machine-readable copy.
      `${/^[A-Z]{3,7}$/.test(method) ? method : 'OTHER'} ${route} ${statusCode}${aborted ? ' (client aborted)' : ''} ${durationMs.toFixed(1)}ms`,
      context,
    );
  } catch {
    // Best effort.
  }
}

/** Records safe diagnostics of a failure on the request context (no messages, no stacks). */
export function annotateRequestFailure(request: unknown, exception: unknown): void {
  const context = requestContextOf(request);
  if (!context) return;

  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    const code =
      typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && ERROR_CODE_PATTERN.test(code)) context.errorCode = code;
    return;
  }

  if (typeof exception === 'object' && exception !== null) {
    const name = (exception as { name?: unknown }).name;
    context.errorName = typeof name === 'string' && ERROR_NAME_PATTERN.test(name) ? name : 'Error';
    // PostgreSQL SQLSTATE (TypeORM copies it onto QueryFailedError); the message and
    // `detail` are never read: they can contain row values such as e-mail addresses.
    const e = exception as { code?: unknown; driverError?: { code?: unknown } };
    const dbCode = typeof e.code === 'string' ? e.code : e.driverError?.code;
    if (typeof dbCode === 'string' && DB_CODE_PATTERN.test(dbCode)) context.dbCode = dbCode;
  } else {
    context.errorName = 'NonErrorThrown';
  }
}

/**
 * Sets `Retry-After` (seconds) for HTTP errors whose body carries
 * `retryAfterSeconds` (429 rate limit / cooldown, 503 dependency or
 * rate-limit store unavailable). Used by the global filter (P3-BE11: 429s
 * from the API-wide limits occur on every controller) and RetryAfterFilter.
 */
export function applyRetryAfterHeader(host: ArgumentsHost, exception: unknown): void {
  try {
    if (host.getType() !== 'http' || !(exception instanceof HttpException)) return;
    const body = exception.getResponse();
    const seconds =
      typeof body === 'object' && body !== null && 'retryAfterSeconds' in body
        ? Number((body as { retryAfterSeconds: unknown }).retryAfterSeconds)
        : NaN;
    if (!Number.isInteger(seconds) || seconds <= 0) return;
    const response = host.switchToHttp().getResponse<Response>();
    if (!response.headersSent) response.setHeader('Retry-After', String(seconds));
  } catch {
    // Never let a header helper break error rendering.
  }
}

/** annotateRequestFailure for an exception-filter host; best effort, never throws. */
export function annotateHostFailure(host: ArgumentsHost, exception: unknown): void {
  try {
    if (host.getType() === 'http') annotateRequestFailure(host.switchToHttp().getRequest(), exception);
  } catch {
    // Observability must never break error rendering.
  }
}

/**
 * Global exception filter. HTTP responses are byte-for-byte those of Nest's
 * BaseExceptionFilter (same status codes, bodies and error codes); the only
 * differences are observability:
 * - failures are annotated on the request context and reported once, by
 *   the completion event;
 * - unexpected errors are NOT passed to `ExceptionsHandler` logging, which
 *   would print the error message and stack (database errors include row
 *   values) — only the error class and SQLSTATE are logged.
 */
@Catch()
export class ObservabilityExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    annotateHostFailure(host, exception);
    applyRetryAfterHeader(host, exception);
    super.catch(exception, host);
  }

  override handleUnknownError(exception: unknown, host: ArgumentsHost, applicationRef: HttpServer): void {
    const body = this.isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message }
      : { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
    const response: unknown = host.getArgByIndex(1);
    if (!applicationRef.isHeadersSent(response)) applicationRef.reply(response, body, body.statusCode);
    else applicationRef.end(response);
  }
}

/**
 * Installs P3-BE09 HTTP observability on an application. Must be called
 * before `init()`/`listen()` so the middleware precedes body parsing and
 * routing.
 */
export function applyHttpObservability(app: INestApplication): void {
  app.use(requestContextMiddleware);
  app.useGlobalFilters(new ObservabilityExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
}
