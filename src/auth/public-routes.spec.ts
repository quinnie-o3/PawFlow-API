import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Secure by default: JwtAuthGuard is global (APP_GUARD), so a route is public
 * only when it or its controller carries @Public(). This is the reviewed
 * allowlist, kept in sync with PUBLIC_ROUTES in test/qa/api-security-matrix.cjs.
 * Opening any other route must change this list, so it shows up in review.
 */
const PUBLIC_ROUTES = [
  'GET /',
  'POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /auth/verify-email',
  'GET /availability/public', 'GET /availability/public/search', 'GET /availability/public/:id',
  'GET /pet-types', 'GET /service-categories',
  'GET /providers/public/search', 'GET /providers/public/:id', 'GET /reviews/provider/:providerId',
  'GET /services/public', 'GET /services/public/search', 'GET /services/public/:id',
  'GET /health/live', 'GET /health/ready',
];

const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

const joinPath = (...parts: unknown[]) =>
  '/' + parts.map((p) => String(p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

interface Route {
  key: string;
  isPublic: boolean;
}

function routes(): Route[] {
  const found: Route[] = [];
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    for (const exported of Object.values(require(file) as Record<string, unknown>)) {
      if (typeof exported !== 'function') continue;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, exported);
      if (base === undefined) continue;
      const proto = (exported as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        found.push({
          key: `${RequestMethod[method]} ${joinPath(base, Reflect.getMetadata(PATH_METADATA, handler))}`,
          isPublic:
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC_KEY, exported) === true,
        });
      }
    }
  }
  return found;
}

describe('global authentication (secure by default)', () => {
  const all = routes();

  it('discovers the application routes', () => {
    expect(all.length).toBeGreaterThan(PUBLIC_ROUTES.length);
  });

  it('exposes exactly the reviewed public allowlist; every other route requires a token', () => {
    const publicKeys = all.filter((r) => r.isPublic).map((r) => r.key);
    expect([...publicKeys].sort()).toEqual([...PUBLIC_ROUTES].sort());
  });
});
