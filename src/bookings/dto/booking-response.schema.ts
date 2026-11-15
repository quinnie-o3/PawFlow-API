import type { SchemaObject } from '@nestjs/swagger';

/**
 * OpenAPI schemas of the P2-08B booking projections (`booking-views.ts`).
 * Keep both files in sync: the QA contract test compares them.
 */

const BOOKING_STATUSES = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'REJECTED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

const id = (example: string): SchemaObject => ({
  type: 'string',
  description: 'BIGINT identifier serialized as a string.',
  example,
});

const PET_TYPE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: id('1'),
    name: { type: 'string', example: 'Dog' },
  },
};

const BASE_PROPERTIES: Record<string, SchemaObject> = {
  id: id('42'),
  status: {
    type: 'string',
    enum: BOOKING_STATUSES,
    example: 'PENDING_CONFIRMATION',
  },
  bookedPrice: {
    type: 'string',
    description:
      'Service price snapshot taken at booking time; NUMERIC(12,2) serialized as a string.',
    example: '150000.00',
  },
  customerNote: {
    type: 'string',
    nullable: true,
    example: 'Please be gentle, she is nervous.',
  },
  createdAt: {
    type: 'string',
    format: 'date-time',
    example: '2026-11-02T07:05:30.250Z',
  },
  updatedAt: {
    type: 'string',
    format: 'date-time',
    example: '2026-11-02T07:05:30.250Z',
  },
  service: {
    type: 'object',
    required: ['id', 'name', 'durationMinutes'],
    properties: {
      id: id('5'),
      name: { type: 'string', example: 'Full grooming' },
      durationMinutes: {
        type: 'integer',
        description: 'Current service duration (not a booking-time snapshot).',
        example: 60,
      },
    },
  },
  slot: {
    type: 'object',
    required: ['id', 'slotDate', 'startTime', 'endTime'],
    description: 'Scheduled appointment, in server-local time.',
    properties: {
      id: id('12'),
      slotDate: { type: 'string', format: 'date', example: '2026-11-05' },
      startTime: {
        type: 'string',
        pattern: '^\\d{2}:\\d{2}:\\d{2}$',
        example: '09:00:00',
      },
      endTime: {
        type: 'string',
        pattern: '^\\d{2}:\\d{2}:\\d{2}$',
        example: '10:00:00',
      },
    },
  },
};
const BASE_REQUIRED = Object.keys(BASE_PROPERTIES);

const PET_BASIC_PROPERTIES: Record<string, SchemaObject> = {
  id: id('8'),
  name: { type: 'string', example: 'Milo' },
  breed: { type: 'string', nullable: true, example: 'Corgi' },
  petType: PET_TYPE_SCHEMA,
};

const STATUS_LOGS_SCHEMA: SchemaObject = {
  type: 'array',
  description: 'Status history, oldest first.',
  items: {
    type: 'object',
    required: ['id', 'oldStatus', 'newStatus', 'reason', 'createdAt'],
    properties: {
      id: id('77'),
      oldStatus: {
        type: 'string',
        enum: BOOKING_STATUSES,
        nullable: true,
        description: 'null for the creation entry.',
        example: null,
      },
      newStatus: {
        type: 'string',
        enum: BOOKING_STATUSES,
        example: 'PENDING_CONFIRMATION',
      },
      reason: { type: 'string', nullable: true, example: null },
      createdAt: {
        type: 'string',
        format: 'date-time',
        example: '2026-11-02T07:05:30.250Z',
      },
    },
  },
};

export const CUSTOMER_BOOKING_SCHEMA: SchemaObject = {
  type: 'object',
  description:
    "A customer's own booking. Owner IDs, provider contact/approval data and slot capacity counters are not exposed.",
  required: [...BASE_REQUIRED, 'pet', 'provider'],
  properties: {
    ...BASE_PROPERTIES,
    pet: {
      type: 'object',
      required: Object.keys(PET_BASIC_PROPERTIES),
      properties: PET_BASIC_PROPERTIES,
    },
    provider: {
      type: 'object',
      required: ['id', 'businessName', 'address'],
      description: 'Public provider profile fields.',
      properties: {
        id: id('3'),
        businessName: { type: 'string', example: 'Paw Spa' },
        address: { type: 'string', example: '1 Nguyen Hue, District 1' },
      },
    },
  },
};

export const CUSTOMER_BOOKING_DETAIL_SCHEMA: SchemaObject = {
  ...CUSTOMER_BOOKING_SCHEMA,
  required: [...(CUSTOMER_BOOKING_SCHEMA.required ?? []), 'statusLogs'],
  properties: {
    ...CUSTOMER_BOOKING_SCHEMA.properties,
    statusLogs: STATUS_LOGS_SCHEMA,
  },
};

export const PROVIDER_BOOKING_SCHEMA: SchemaObject = {
  type: 'object',
  description:
    "A booking of the caller's provider. The customer is identified by name only (no email, phone or account data); pet care details are included to fulfil the appointment.",
  required: [...BASE_REQUIRED, 'customer', 'pet'],
  properties: {
    ...BASE_PROPERTIES,
    customer: {
      type: 'object',
      required: ['id', 'fullName'],
      properties: {
        id: id('20'),
        fullName: { type: 'string', example: 'Nguyen Van A' },
      },
    },
    pet: {
      type: 'object',
      required: [
        ...Object.keys(PET_BASIC_PROPERTIES),
        'birthDate',
        'weight',
        'healthNote',
      ],
      properties: {
        ...PET_BASIC_PROPERTIES,
        birthDate: {
          type: 'string',
          format: 'date',
          nullable: true,
          example: '2022-05-01',
        },
        weight: {
          type: 'string',
          nullable: true,
          description: 'NUMERIC(6,2) serialized as a string.',
          example: '12.50',
        },
        healthNote: {
          type: 'string',
          nullable: true,
          example: 'Allergic to oat shampoo',
        },
      },
    },
  },
};

export const PROVIDER_BOOKING_DETAIL_SCHEMA: SchemaObject = {
  ...PROVIDER_BOOKING_SCHEMA,
  required: [...(PROVIDER_BOOKING_SCHEMA.required ?? []), 'statusLogs'],
  properties: {
    ...PROVIDER_BOOKING_SCHEMA.properties,
    statusLogs: STATUS_LOGS_SCHEMA,
  },
};
