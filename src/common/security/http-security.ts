import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NextFunction, Request, Response } from 'express';

import { REQUEST_ID_HEADER } from '../observability/request-id';

/**
 * P3-BE11 HTTP security headers and CORS policy (no extra dependency: the
 * header set an API needs is small and explicit here).
 *
 * Every response (including errors, 429 and health) gets:
 *   X-Content-Type-Options: nosniff
 *   X-Frame-Options: DENY               (+ CSP frame-ancestors 'none')
 *   Referrer-Policy: no-referrer
 *   Permissions-Policy: all powerful features off
 *   Cross-Origin-Opener-Policy: same-origin
 *   X-DNS-Prefetch-Control: off
 *   Content-Security-Policy: "default-src 'none'" for JSON, a Swagger-UI
 *     compatible policy under /api/docs (scripts only from 'self'; the UI
 *     page has one inline <style>)
 *   Cache-Control: no-store            (API responses carry personal data)
 *   Strict-Transport-Security          only when HSTS is configured AND the
 *     request is HTTPS as Express sees it (`req.secure`, which trusts
 *     X-Forwarded-Proto only from TRUST_PROXY peers): never on local HTTP,
 *     never because an untrusted client sent X-Forwarded-Proto: https.
 * X-Powered-By is removed in main.ts.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const DOCS_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

const DOCS_PREFIX = '/api/docs';

export interface SecurityHeadersOptions {
  /** 0 disables HSTS. */
  hstsMaxAgeSeconds: number;
}

export function securityHeadersMiddleware(options: SecurityHeadersOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const docs = req.path === DOCS_PREFIX || req.path.startsWith(`${DOCS_PREFIX}/`) || req.path.startsWith(`${DOCS_PREFIX}-`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Content-Security-Policy', docs ? DOCS_CSP : API_CSP);
    if (!docs) res.setHeader('Cache-Control', 'no-store');
    if (options.hstsMaxAgeSeconds > 0 && req.secure) {
      res.setHeader('Strict-Transport-Security', `max-age=${options.hstsMaxAgeSeconds}; includeSubDomains`);
    }
    next();
  };
}

export const CORS_ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'Idempotency-Key', REQUEST_ID_HEADER];

/**
 * Exact-match origin allowlist. The Origin header is compared with the
 * configured origins as whole strings: no reflection of unknown origins, no
 * suffix or substring matching, no wildcard, and no CORS headers at all for
 * a disallowed or absent Origin (the browser then blocks the response).
 * CORS is not authorization: every request is still authenticated and
 * authorized by the guards.
 *
 * Credentials: authentication is header-based (Bearer tokens, no cookies),
 * but the existing frontend sends `credentials: "include"`, so
 * Access-Control-Allow-Credentials stays true; this is safe only because
 * origins are an exact allowlist (never "*").
 */
export function corsOptions(allowedOrigins: readonly string[], exposedHeaders: readonly string[]): CorsOptions {
  const allowed = new Set(allowedOrigins);
  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: string | boolean) => void) => {
      callback(null, typeof origin === 'string' && allowed.has(origin) ? origin : false);
    },
    credentials: true,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: [...exposedHeaders],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
}
