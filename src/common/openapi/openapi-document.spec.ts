import type { OpenAPIObject } from '@nestjs/swagger';

import { applyCrossCuttingContract, buildOpenApiConfig, BEARER_SCHEME } from './openapi-document';

const doc = (): OpenAPIObject =>
  ({
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/api/pets': {
        get: { responses: { '200': { description: 'ok' }, '401': { description: 'no token' } } },
      },
      '/api/auth/login': {
        post: { responses: { '200': { description: 'ok' }, '429': { description: 'Too many requests (`code: RATE_LIMITED`).' } } },
      },
      '/api/health/ready': {
        get: { responses: { '200': { description: 'ready' }, '503': { description: 'unavailable', content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
    },
  }) as unknown as OpenAPIObject;

describe('OpenAPI release contract (P3-BE12)', () => {
  it('documents the API-wide 429/503 with Retry-After on every limited operation', () => {
    const out = applyCrossCuttingContract(doc());
    const pets = out.paths['/api/pets'].get!.responses as Record<string, { description: string; headers?: Record<string, unknown> }>;
    expect(pets['429'].description).toContain('RATE_LIMITED');
    expect(pets['503'].description).toContain('RATE_LIMIT_UNAVAILABLE');
    expect(pets['429'].headers).toHaveProperty('Retry-After');
    expect(pets['503'].headers).toHaveProperty('Retry-After');
  });

  it('keeps route-specific descriptions instead of duplicating them', () => {
    const out = applyCrossCuttingContract(doc());
    const login = out.paths['/api/auth/login'].post!.responses['429'] as { description: string };
    expect(login.description).toBe('Too many requests (`code: RATE_LIMITED`).');
  });

  it('leaves the health endpoints exempt and keeps their own bodies', () => {
    const out = applyCrossCuttingContract(doc());
    const ready = out.paths['/api/health/ready'].get!.responses as Record<string, { headers?: Record<string, unknown>; content?: unknown }>;
    expect(ready['429']).toBeUndefined();
    expect(ready['503'].headers).not.toHaveProperty('Retry-After');
    expect(ready['503'].content).toEqual({ 'application/json': { schema: { type: 'object' } } });
  });

  it('adds X-Request-ID to every response and ErrorResponse to error responses without content', () => {
    const out = applyCrossCuttingContract(doc());
    for (const item of Object.values(out.paths)) {
      for (const op of Object.values(item) as Array<{ responses: Record<string, { headers?: Record<string, unknown> }> }>) {
        for (const response of Object.values(op.responses)) expect(response.headers).toHaveProperty('X-Request-ID');
      }
    }
    const unauthorized = out.paths['/api/pets'].get!.responses['401'] as { content?: Record<string, { schema: { $ref: string } }> };
    expect(unauthorized.content?.['application/json'].schema.$ref).toBe('#/components/schemas/ErrorResponse');
    expect(out.components?.schemas?.ErrorResponse).toBeDefined();
  });

  it('is deterministic and idempotent', () => {
    const once = applyCrossCuttingContract(doc());
    expect(JSON.stringify(applyCrossCuttingContract(doc()))).toBe(JSON.stringify(once));
    expect(JSON.stringify(applyCrossCuttingContract(JSON.parse(JSON.stringify(once)) as OpenAPIObject))).toBe(JSON.stringify(once));
  });

  it('declares the bearer scheme and the X-Request-ID request parameter', () => {
    const config = buildOpenApiConfig();
    expect(config.components?.securitySchemes?.[BEARER_SCHEME]).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(JSON.stringify(config)).toContain('X-Request-ID');
  });
});
