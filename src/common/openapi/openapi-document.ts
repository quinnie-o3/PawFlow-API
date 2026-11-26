import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN } from '../observability/request-id';

/**
 * P3-BE12 release contract: the ONE place that builds the PawFlow OpenAPI
 * document. `main.ts` serves it at /api/docs(-json) when Swagger is enabled,
 * and `scripts/openapi-export.cjs` exports the same document to
 * docs/api/openapi.json without a database (Nest preview mode), so the
 * committed contract and the served one cannot diverge.
 */
export const OPENAPI_TITLE = 'PawFlow API';
export const OPENAPI_VERSION = '1.0';
export const BEARER_SCHEME = 'access-token';

/** Paths whose operations skip the API-wide rate limits (`@SkipApiRateLimit`). */
export const RATE_LIMIT_EXEMPT_PREFIXES = ['/api/health/'];

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export function buildOpenApiConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle(OPENAPI_TITLE)
    .setDescription(
      'REST API documentation for the PawFlow pet care service booking and provider management platform.\n\n' +
        'Cross-cutting contract (P3-BE11/BE12): every response carries `X-Request-ID`; every operation except ' +
        '`/api/health/*` is subject to the API-wide rate limits (`429 RATE_LIMITED` with `Retry-After`, ' +
        '`503 RATE_LIMIT_UNAVAILABLE` when the limiter store is unavailable). Errors use the `ErrorResponse` shape. ' +
        'IDs are strings (PostgreSQL BIGINT); NUMERIC values are strings with 2 decimals.',
    )
    .setVersion(OPENAPI_VERSION)
    .addGlobalParameters({
      in: 'header',
      name: REQUEST_ID_HEADER,
      required: false,
      description:
        'Optional client correlation ID: 8-128 characters from [A-Za-z0-9._:-], starting with a letter or digit. ' +
        'Kept when valid, otherwise replaced by a server-generated UUID. Every response (including errors) ' +
        'returns the authoritative value in the X-Request-ID response header; quote it when reporting a problem.',
      schema: { type: 'string', pattern: REQUEST_ID_PATTERN.source, maxLength: 128 },
    })
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, BEARER_SCHEME)
    .build();
}

/**
 * Adds the cross-cutting behaviour that is implemented globally (and so is
 * invisible to per-route decorators) to every operation:
 * - `X-Request-ID` response header on every response (P3-BE09);
 * - `429` / `503` of the API-wide rate limiter (P3-BE11) on every operation
 *   it guards, with `Retry-After`; existing route-specific descriptions are kept;
 * - the shared `ErrorResponse` schema on every 4xx/5xx response without
 *   content (except the health endpoints, which document their own bodies).
 * Pure function of its input (deterministic export).
 */
export function applyCrossCuttingContract(document: OpenAPIObject): OpenAPIObject {
  const components = (document.components ??= {});
  components.headers = {
    ...components.headers,
    XRequestId: {
      description: 'Correlation ID of this request (client value when valid, otherwise server-generated).',
      schema: { type: 'string' },
    },
    RetryAfter: {
      description: 'Seconds to wait before retrying (sent with RATE_LIMITED and RATE_LIMIT_UNAVAILABLE).',
      schema: { type: 'integer', minimum: 1 },
    },
  };
  components.schemas = {
    ...components.schemas,
    ErrorResponse: {
      type: 'object',
      required: ['statusCode', 'message'],
      properties: {
        statusCode: { type: 'integer', example: 404 },
        message: {
          description: 'English, for developers and logs. DTO validation returns an array of messages.',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        error: { type: 'string', example: 'Not Found' },
        code: {
          type: 'string',
          description:
            'Machine-readable reason where defined, e.g. RATE_LIMITED, RATE_LIMIT_UNAVAILABLE, TURNSTILE_REQUIRED, ' +
            'TURNSTILE_INVALID, TURNSTILE_EXPIRED, TURNSTILE_UNAVAILABLE.',
        },
        retryAfterSeconds: { type: 'integer', description: 'Present on 429 RATE_LIMITED and 503 RATE_LIMIT_UNAVAILABLE.' },
      },
    },
  };

  const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };

  for (const [path, item] of Object.entries(document.paths)) {
    const limited = !RATE_LIMIT_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const responses = (operation.responses ??= {});

      if (limited) {
        const tooMany = (responses['429'] ??= { description: 'Too many requests (API-wide rate limit).' }) as { description: string };
        if (!tooMany.description.includes('RATE_LIMITED')) tooMany.description += ' `code: RATE_LIMITED`, `retryAfterSeconds`; `Retry-After` header.';
        const unavailable = (responses['503'] ??= { description: 'Service unavailable.' }) as { description: string };
        if (!unavailable.description.includes('RATE_LIMIT_UNAVAILABLE')) unavailable.description += ' Also `code: RATE_LIMIT_UNAVAILABLE` when the rate-limit store is unavailable (fail-closed).';
      }

      for (const [status, response] of Object.entries(responses)) {
        if (!response || '$ref' in response) continue;
        response.headers = {
          ...response.headers,
          'X-Request-ID': { $ref: '#/components/headers/XRequestId' },
          ...(limited && (status === '429' || status === '503') ? { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } } : {}),
        };
        // Health responses have their own documented bodies (not ErrorResponse).
        if (limited && /^[45]/.test(status) && !response.content) response.content = errorContent;
      }
    }
  }
  return document;
}

/** The PawFlow OpenAPI document of `app` (the global `api` prefix must already be set). */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return applyCrossCuttingContract(SwaggerModule.createDocument(app, buildOpenApiConfig()));
}
