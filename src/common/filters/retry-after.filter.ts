import { type ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';

import { annotateHostFailure } from '../observability/http-observability';

/**
 * Adds a `Retry-After` header (seconds) to HTTP errors whose body carries
 * `retryAfterSeconds` (429 rate limit / cooldown, 503 bot-verification or
 * rate-limit store unavailable). The body is rendered unchanged by Nest's
 * default handler.
 *
 * As a controller-scoped filter it takes precedence over the global
 * ObservabilityExceptionFilter for HttpExceptions, so it records the error
 * code for the completion log itself (P3-BE09).
 */
@Catch(HttpException)
export class RetryAfterFilter extends BaseExceptionFilter {
  override catch(exception: HttpException, host: ArgumentsHost): void {
    annotateHostFailure(host, exception);
    const body = exception.getResponse();
    const seconds =
      typeof body === 'object' && body !== null && 'retryAfterSeconds' in body
        ? Number((body as { retryAfterSeconds: unknown }).retryAfterSeconds)
        : NaN;

    if (host.getType() === 'http' && Number.isInteger(seconds) && seconds > 0) {
      const response = host.switchToHttp().getResponse<Response>();
      if (!response.headersSent) response.setHeader('Retry-After', String(seconds));
    }

    super.catch(exception, host);
  }
}
