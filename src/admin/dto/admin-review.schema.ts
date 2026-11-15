import type { SchemaObject } from '@nestjs/swagger';

/**
 * OpenAPI shape of an admin review (list item, detail, and the result of
 * hide/restore). Mirrors `ReviewAdminResponse` in admin.service.ts.
 */
export const ADMIN_REVIEW_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'bookingId', 'rating', 'comment', 'providerResponse', 'respondedBy', 'respondedAt', 'isVisible', 'createdAt', 'updatedAt', 'booking'],
  properties: {
    id: { type: 'string', example: '41' },
    bookingId: { type: 'string', example: '310' },
    rating: { type: 'integer', minimum: 1, maximum: 5, example: 2 },
    comment: { type: 'string', nullable: true },
    providerResponse: { type: 'string', nullable: true, description: 'Provider response text; null when there is none.' },
    respondedBy: {
      type: 'object',
      nullable: true,
      description:
        'The provider user who responded (id and name only). Null when there is no response, or when the responding ' +
        'account was deleted; then providerResponse and respondedAt are still present.',
      properties: { id: { type: 'string', example: '12' }, fullName: { type: 'string', example: 'Tran Binh' } },
    },
    respondedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Database time of the response.' },
    isVisible: { type: 'boolean', description: 'false = hidden by an administrator.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    booking: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customerId: { type: 'string' },
        providerId: { type: 'string' },
        serviceId: { type: 'string' },
        status: { type: 'string', example: 'COMPLETED' },
      },
    },
  },
};
