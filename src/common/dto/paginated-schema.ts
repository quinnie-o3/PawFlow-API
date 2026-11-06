import type { SchemaObject } from '@nestjs/swagger';

/**
 * OpenAPI schema for the `PaginatedResult` envelope returned by the public
 * search endpoints: `{ items, meta, query }`.
 */
export function paginatedSchema(
  itemSchema: SchemaObject,
  queryProperties: Record<string, SchemaObject>,
): SchemaObject {
  return {
    type: 'object',
    required: ['items', 'meta', 'query'],
    properties: {
      items: { type: 'array', items: itemSchema },
      meta: {
        type: 'object',
        required: [
          'page',
          'limit',
          'totalItems',
          'totalPages',
          'hasNextPage',
          'hasPreviousPage',
        ],
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 20 },
          totalItems: { type: 'integer', example: 42 },
          totalPages: {
            type: 'integer',
            example: 3,
            description: '0 when there are no matching items.',
          },
          hasNextPage: { type: 'boolean', example: true },
          hasPreviousPage: { type: 'boolean', example: false },
        },
      },
      query: {
        type: 'object',
        description:
          'Normalized filters actually applied (absent filters are null; sort shows the default when omitted). Useful for URL synchronization and for discarding stale responses.',
        properties: queryProperties,
      },
    },
  };
}
