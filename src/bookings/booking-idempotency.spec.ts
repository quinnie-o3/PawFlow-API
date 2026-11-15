import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import {
  fingerprintCreateBookingRequest,
  IDEMPOTENCY_KEY_FORMAT_MESSAGE,
  parseIdempotencyKey,
} from './booking-idempotency';
import { CreateBookingDto } from './dto/create-booking.dto';

describe('parseIdempotencyKey (P2-07)', () => {
  it('returns undefined when the header is absent (legacy behaviour)', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it.each([
    ['UUID v4', '3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00'],
    ['upper-case UUID', '3F0C8A52-6C1E-4F5B-9A7E-2D4B8C1E9F00'],
    ['ULID', '01JC0Z8Q5N3W6Y2V7T4R9S1P0M'],
    ['nanoid', 'V1StGXR8_Z5jdHi6B-myT'],
    ['16 characters', 'a'.repeat(16)],
    ['128 characters', 'a'.repeat(128)],
  ])('accepts a %s exactly as sent', (_label, key) => {
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it.each([
    ['an empty value', ''],
    ['15 characters', 'a'.repeat(15)],
    ['129 characters', 'a'.repeat(129)],
    ['a 10 KB value', 'a'.repeat(10_240)],
    ['spaces', '3f0c8a52 6c1e 4f5b 9a7e 2d4b8c1e9f00'],
    ['padding', ' 3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00'],
    ['repeated headers joined by Node', '3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00, 3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00'],
    ['non-ASCII letters', 'clé-de-réservation-0001'],
    ['punctuation', 'booking:attempt/0001.2'],
  ])('rejects %s with 400', (_label, key) => {
    expect(() => parseIdempotencyKey(key)).toThrow(
      new BadRequestException(IDEMPOTENCY_KEY_FORMAT_MESSAGE),
    );
  });

  it('rejects array-valued headers with 400', () => {
    expect(() => parseIdempotencyKey(['a'.repeat(20), 'b'.repeat(20)])).toThrow(
      BadRequestException,
    );
  });
});

describe('fingerprintCreateBookingRequest (P2-07)', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
  const normalize = (body: object) =>
    pipe.transform(body, {
      type: 'body',
      metatype: CreateBookingDto,
    }) as Promise<CreateBookingDto>;
  const fingerprint = async (body: object) =>
    fingerprintCreateBookingRequest(await normalize(body));

  it('is a 64-character lowercase hex digest', async () => {
    expect(await fingerprint({ petId: '8', slotId: '12' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches for payloads that validate to the same request', async () => {
    const base = await fingerprint({ petId: '8', slotId: '12', customerNote: 'gentle' });

    expect(await fingerprint({ petId: 8, slotId: 12, customerNote: 'gentle' })).toBe(base);
    expect(await fingerprint({ slotId: '12', customerNote: '  gentle ', petId: '8' })).toBe(base);
  });

  it('treats a missing, null and blank note as the same request', async () => {
    const base = await fingerprint({ petId: '8', slotId: '12' });

    expect(await fingerprint({ petId: '8', slotId: '12', customerNote: null })).toBe(base);
    expect(await fingerprint({ petId: '8', slotId: '12', customerNote: '   ' })).toBe(base);
  });

  it.each([
    ['pet', { petId: '9', slotId: '12', customerNote: 'gentle' }],
    ['slot', { petId: '8', slotId: '13', customerNote: 'gentle' }],
    ['note', { petId: '8', slotId: '12', customerNote: 'Gentle' }],
    ['missing note', { petId: '8', slotId: '12' }],
  ])('differs when the %s differs', async (_label, body) => {
    expect(await fingerprint(body)).not.toBe(
      await fingerprint({ petId: '8', slotId: '12', customerNote: 'gentle' }),
    );
  });

  it('does not let field boundaries collide', () => {
    expect(
      fingerprintCreateBookingRequest({ petId: '1', slotId: '23' }),
    ).not.toBe(fingerprintCreateBookingRequest({ petId: '12', slotId: '3' }));
  });
});
