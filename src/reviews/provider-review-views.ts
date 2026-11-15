import type { SchemaObject } from '@nestjs/swagger';

/**
 * Provider-facing review projection (P3-BE08).
 *
 * Built from an explicit column list (never a raw entity). It carries what
 * is needed to manage feedback and nothing else: no customer id, email or
 * phone, no pet, price, notes or status history, no `updatedAt`, and no
 * moderation metadata beyond the visibility flag (no reason exists).
 */
export interface ProviderReviewView {
  id: string;
  rating: number;
  comment: string | null;
  isVisible: boolean;
  createdAt: Date;
  booking: {
    id: string;
    service: { id: string; name: string };
    slot: { slotDate: string; startTime: string };
  };
  customer: { fullName: string };
  response: {
    text: string;
    respondedAt: Date;
    /** Null only if the responding account was deleted (FK ON DELETE SET NULL). */
    respondedBy: { id: string; fullName: string } | null;
  } | null;
}

/** Raw row selected by `PROVIDER_REVIEW_COLUMNS`. */
export interface ProviderReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  is_visible: boolean;
  created_at: Date;
  booking_id: string;
  service_id: string;
  service_name: string;
  slot_date: string;
  start_time: string;
  customer_full_name: string;
  provider_response: string | null;
  responded_at: Date | null;
  responded_by: string | null;
  responder_full_name: string | null;
}

/**
 * FROM clause shared by the list and the post-write read. The provider
 * scope is always applied on `b.provider_id` by the caller's WHERE clause.
 */
export const PROVIDER_REVIEW_FROM = `
  FROM reviews r
  JOIN bookings b ON b.id = r.booking_id
  JOIN users c ON c.id = b.customer_id
  JOIN services s ON s.id = b.service_id
  JOIN availability_slots sl ON sl.id = b.slot_id
  LEFT JOIN users ru ON ru.id = r.responded_by`;

export const PROVIDER_REVIEW_COLUMNS = `
  r.id::text AS id,
  r.rating::int AS rating,
  r.comment,
  r.is_visible,
  r.created_at,
  b.id::text AS booking_id,
  s.id::text AS service_id,
  s.name AS service_name,
  sl.slot_date::text AS slot_date,
  sl.start_time::text AS start_time,
  c.full_name AS customer_full_name,
  r.provider_response,
  r.responded_at,
  r.responded_by::text AS responded_by,
  ru.full_name AS responder_full_name`;

export function toProviderReviewView(row: ProviderReviewRow): ProviderReviewView {
  return {
    id: row.id,
    rating: Number(row.rating),
    comment: row.comment,
    isVisible: row.is_visible,
    createdAt: row.created_at,
    booking: {
      id: row.booking_id,
      service: { id: row.service_id, name: row.service_name },
      slot: { slotDate: row.slot_date, startTime: row.start_time },
    },
    customer: { fullName: row.customer_full_name },
    response:
      row.provider_response === null || row.responded_at === null
        ? null
        : {
            text: row.provider_response,
            respondedAt: row.responded_at,
            respondedBy:
              row.responded_by === null
                ? null
                : { id: row.responded_by, fullName: row.responder_full_name ?? '' },
          },
  };
}

export const PROVIDER_REVIEW_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'rating', 'comment', 'isVisible', 'createdAt', 'booking', 'customer', 'response'],
  properties: {
    id: { type: 'string', example: '41', description: 'BIGINT id as a string.' },
    rating: { type: 'integer', minimum: 1, maximum: 5, example: 2 },
    comment: { type: 'string', nullable: true, example: 'Late by 20 minutes.' },
    isVisible: { type: 'boolean', example: true, description: 'false = hidden by an administrator (not shown publicly, not in the rating).' },
    createdAt: { type: 'string', format: 'date-time' },
    booking: {
      type: 'object',
      properties: {
        id: { type: 'string', example: '310' },
        service: { type: 'object', properties: { id: { type: 'string', example: '7' }, name: { type: 'string', example: 'Full grooming' } } },
        slot: { type: 'object', properties: { slotDate: { type: 'string', example: '2026-11-09' }, startTime: { type: 'string', example: '09:00:00' } } },
      },
    },
    customer: { type: 'object', properties: { fullName: { type: 'string', example: 'Nguyen An' } } },
    response: {
      type: 'object',
      nullable: true,
      properties: {
        text: { type: 'string', example: 'Sorry for the wait. We have added a groomer on Saturdays.' },
        respondedAt: { type: 'string', format: 'date-time', description: 'PostgreSQL time of the response.' },
        respondedBy: {
          type: 'object',
          nullable: true,
          description: 'The provider owner who responded; null only if that account was deleted.',
          properties: { id: { type: 'string', example: '12' }, fullName: { type: 'string', example: 'Tran Binh' } },
        },
      },
    },
  },
};
