import type { Booking } from '../../src/bookings/entities/booking.entity';

/**
 * A booking entity with every relation fully loaded, including the
 * internal and sensitive columns a raw entity would carry. Projections
 * must drop all of them (P2-08B).
 */
export function bookingEntityFixture(
  overrides: Partial<Record<keyof Booking, unknown>> = {},
): Booking {
  const createdAt = new Date('2026-11-02T07:05:30.250Z');
  const updatedAt = new Date('2026-11-02T07:06:00.000Z');

  return {
    id: '100',
    customerId: '20',
    petId: '8',
    providerId: '3',
    serviceId: '5',
    slotId: '12',
    status: 'PENDING_CONFIRMATION',
    bookedPrice: '150000.00',
    customerNote: 'Please be gentle',
    createdAt,
    updatedAt,
    customer: {
      id: '20',
      fullName: 'Nguyen Van A',
      email: 'a@example.com',
      phone: '0900000001',
      passwordHash: '$2b$10$secret',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      createdAt,
      updatedAt,
    },
    pet: {
      id: '8',
      ownerId: '20',
      petTypeId: '1',
      name: 'Milo',
      breed: 'Corgi',
      birthDate: '2022-05-01',
      weight: '12.50',
      healthNote: 'Allergic to oat shampoo',
      status: 'ACTIVE',
      createdAt,
      updatedAt,
      petType: { id: '1', name: 'Dog', status: 'ACTIVE', createdAt, updatedAt },
      owner: { id: '20', passwordHash: '$2b$10$secret', email: 'a@example.com' },
    },
    provider: {
      id: '3',
      ownerId: '30',
      businessName: 'Paw Spa',
      address: '1 Nguyen Hue, District 1',
      phone: '0911222333',
      description: 'Grooming',
      approvalStatus: 'APPROVED',
      ratingAvg: '4.50',
      ratingCount: 2,
      createdAt,
      updatedAt,
      owner: { id: '30', passwordHash: '$2b$10$owner', email: 'owner@example.com' },
    },
    service: {
      id: '5',
      providerId: '3',
      categoryId: '2',
      name: 'Full grooming',
      price: '180000.00',
      durationMinutes: 60,
      description: 'Bath and cut',
      status: 'ACTIVE',
      createdAt,
      updatedAt,
    },
    slot: {
      id: '12',
      providerId: '3',
      serviceId: '5',
      slotDate: '2026-11-03',
      startTime: '09:00:00',
      endTime: '10:00:00',
      capacity: 2,
      bookedCount: 1,
      status: 'OPEN',
      createdAt,
      updatedAt,
    },
    statusLogs: [
      {
        id: '501',
        bookingId: '100',
        oldStatus: 'PENDING_CONFIRMATION',
        newStatus: 'CONFIRMED',
        changedBy: '30',
        reason: null,
        createdAt: new Date('2026-11-02T08:00:00.000Z'),
      },
      {
        id: '500',
        bookingId: '100',
        oldStatus: null,
        newStatus: 'PENDING_CONFIRMATION',
        changedBy: '20',
        reason: null,
        createdAt,
      },
    ],
    ...overrides,
  } as unknown as Booking;
}

const BASE_VIEW_OF_FIXTURE = {
  id: '100',
  status: 'PENDING_CONFIRMATION',
  bookedPrice: '150000.00',
  customerNote: 'Please be gentle',
  createdAt: '2026-11-02T07:05:30.250Z',
  updatedAt: '2026-11-02T07:06:00.000Z',
  service: { id: '5', name: 'Full grooming', durationMinutes: 60 },
  slot: {
    id: '12',
    slotDate: '2026-11-03',
    startTime: '09:00:00',
    endTime: '10:00:00',
  },
};

/** JSON body of the customer projection of `bookingEntityFixture()`. */
export const CUSTOMER_VIEW_OF_FIXTURE = {
  ...BASE_VIEW_OF_FIXTURE,
  pet: {
    id: '8',
    name: 'Milo',
    breed: 'Corgi',
    petType: { id: '1', name: 'Dog' },
  },
  provider: {
    id: '3',
    businessName: 'Paw Spa',
    address: '1 Nguyen Hue, District 1',
  },
};

/** JSON body of the provider/staff projection of `bookingEntityFixture()`. */
export const PROVIDER_VIEW_OF_FIXTURE = {
  ...BASE_VIEW_OF_FIXTURE,
  customer: { id: '20', fullName: 'Nguyen Van A' },
  pet: {
    id: '8',
    name: 'Milo',
    breed: 'Corgi',
    birthDate: '2022-05-01',
    weight: '12.50',
    healthNote: 'Allergic to oat shampoo',
    petType: { id: '1', name: 'Dog' },
  },
};

/** Status history of the fixture as serialized, oldest first. */
export const STATUS_LOGS_OF_FIXTURE = [
  {
    id: '500',
    oldStatus: null,
    newStatus: 'PENDING_CONFIRMATION',
    reason: null,
    createdAt: '2026-11-02T07:05:30.250Z',
  },
  {
    id: '501',
    oldStatus: 'PENDING_CONFIRMATION',
    newStatus: 'CONFIRMED',
    reason: null,
    createdAt: '2026-11-02T08:00:00.000Z',
  },
];

/** Field names that must not appear anywhere in a booking response. */
export const FORBIDDEN_BOOKING_RESPONSE_KEYS = [
  'passwordHash',
  'password',
  'email',
  'phone',
  'role',
  'owner',
  'ownerId',
  'approvalStatus',
  'customerId',
  'petId',
  'providerId',
  'serviceId',
  'slotId',
  'categoryId',
  'petTypeId',
  'bookingId',
  'changedBy',
  'capacity',
  'bookedCount',
  'ratingAvg',
  'ratingCount',
  'price',
];

/** Every key path of a JSON value, e.g. `pet.petType.name`, `statusLogs[].id`. */
export function jsonKeyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => jsonKeyPaths(item, `${prefix}[]`)))];
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...jsonKeyPaths(child, path)];
    });
  }

  return [];
}

/** Key names from `FORBIDDEN_BOOKING_RESPONSE_KEYS` found at any depth. */
export function forbiddenKeysIn(value: unknown): string[] {
  return jsonKeyPaths(value).filter((path) =>
    FORBIDDEN_BOOKING_RESPONSE_KEYS.includes(path.split('.').pop()!),
  );
}
