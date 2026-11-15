import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateAvailabilitySlotDto } from '../../availability/dto/create-availability-slot.dto';
import { UpdateAvailabilitySlotDto } from '../../availability/dto/update-availability-slot.dto';
import { CreatePetDto } from '../../pets/dto/create-pet.dto';
import { UpdatePetDto } from '../../pets/dto/update-pet.dto';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../pipes/validation-pipe.options';
import { getTodayDateString, isCalendarDateString } from './calendar-date.util';

const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function body(metatype: new () => object, value: unknown) {
  return pipe.transform(value, { type: 'body', metatype }) as Promise<
    Record<string, unknown>
  >;
}

function shiftDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);

  return getTodayDateString(date);
}

const invalidDates: Array<[string, unknown]> = [
  ['non-leap Feb 29', '2027-02-29'],
  ['Feb 30', '2027-02-30'],
  ['month 13', '2026-13-01'],
  ['month 00', '2026-00-10'],
  ['April 31', '2026-04-31'],
  ['day 00', '2026-01-00'],
  ['non-padded', '2026-1-5'],
  ['UTC datetime', '2026-01-15T10:00:00Z'],
  ['offset datetime', '2026-01-15T10:00:00+07:00'],
  ['date with space time', '2026-01-15 10:00'],
  ['year 0000', '0000-01-01'],
  ['5-digit year', '20260-01-15'],
  ['padded', ' 2026-01-15'],
  ['slashes', '2026/01/15'],
  ['empty string', ''],
  ['number', 20260115],
  ['object', { year: 2026 }],
  ['array', ['2026-01-15']],
  ['boolean', true],
];

describe('isCalendarDateString', () => {
  it.each(['2026-01-15', '2028-02-29', '2000-02-29', '1999-12-31', '0001-01-01', '9999-12-31'])(
    'accepts %s',
    (value) => {
      expect(isCalendarDateString(value)).toBe(true);
    },
  );

  it.each(invalidDates)('rejects %s', (_label, value) => {
    expect(isCalendarDateString(value)).toBe(false);
  });

  it('applies Gregorian century leap rules', () => {
    expect(isCalendarDateString('1900-02-29')).toBe(false);
    expect(isCalendarDateString('2100-02-29')).toBe(false);
    expect(isCalendarDateString('2000-02-29')).toBe(true);
    expect(isCalendarDateString('2400-02-29')).toBe(true);
  });

  it('knows the length of every month', () => {
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    lengths.forEach((days, index) => {
      const month = String(index + 1).padStart(2, '0');

      expect(isCalendarDateString(`2027-${month}-${days}`)).toBe(true);
      expect(isCalendarDateString(`2027-${month}-${days + 1}`)).toBe(false);
    });
  });
});

describe('getTodayDateString', () => {
  it('formats the local calendar date, not the UTC date', () => {
    // 00:30 local time on Jan 15 is still Jan 14 in UTC for UTC+ zones.
    expect(getTodayDateString(new Date(2026, 0, 15, 0, 30))).toBe('2026-01-15');
    expect(getTodayDateString(new Date(2026, 0, 15, 23, 59))).toBe('2026-01-15');
  });
});

describe('CreatePetDto.birthDate', () => {
  const pet = (birthDate: unknown) => ({ petTypeId: '1', name: 'Milo', birthDate });

  it('accepts today', async () => {
    const today = getTodayDateString();

    await expect(body(CreatePetDto, pet(today))).resolves.toMatchObject({
      birthDate: today,
    });
  });

  it.each(['1990-06-15', '2000-02-29', '2024-02-29'])(
    'accepts historical date %s',
    async (birthDate) => {
      await expect(body(CreatePetDto, pet(birthDate))).resolves.toMatchObject({
        birthDate,
      });
    },
  );

  it('rejects tomorrow', async () => {
    await expect(body(CreatePetDto, pet(shiftDays(1)))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects 2099-01-01 as a future date', async () => {
    await expect(body(CreatePetDto, pet('2099-01-01'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each(invalidDates)('rejects %s with 400', async (_label, birthDate) => {
    await expect(body(CreatePetDto, pet(birthDate))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('keeps birthDate optional', async () => {
    const result = await body(CreatePetDto, { petTypeId: '1', name: 'Milo' });

    expect(result.birthDate).toBeUndefined();
  });

  it('keeps PATCH semantics: omitted is absent, null clears', async () => {
    const omitted = await body(UpdatePetDto, {});

    expect(omitted.birthDate).toBeUndefined();
    await expect(body(UpdatePetDto, { birthDate: null })).resolves.toMatchObject({
      birthDate: null,
    });
    await expect(
      body(UpdatePetDto, { birthDate: '2027-02-30' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Availability slotDate', () => {
  const slot = (slotDate: unknown) => ({
    serviceId: '1',
    slotDate,
    startTime: '09:00',
    endTime: '10:00',
    capacity: 2,
  });

  it.each(['2028-02-29', shiftDays(7)])('accepts %s on create', async (slotDate) => {
    await expect(
      body(CreateAvailabilitySlotDto, slot(slotDate)),
    ).resolves.toMatchObject({ slotDate });
  });

  it('leaves the not-in-past business rule to the service (DTO accepts a past date)', async () => {
    await expect(
      body(CreateAvailabilitySlotDto, slot('2020-01-15')),
    ).resolves.toMatchObject({ slotDate: '2020-01-15' });
  });

  it.each(invalidDates)('rejects %s on create with 400', async (_label, slotDate) => {
    await expect(
      body(CreateAvailabilitySlotDto, slot(slotDate)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects null for the required create field', async () => {
    await expect(
      body(CreateAvailabilitySlotDto, slot(null)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps PATCH semantics: omitted is absent, null and invalid are rejected', async () => {
    // Class fields exist as own properties set to undefined; the service
    // treats undefined as "not supplied".
    const omitted = await body(UpdateAvailabilitySlotDto, {});

    expect(omitted.slotDate).toBeUndefined();
    await expect(
      body(UpdateAvailabilitySlotDto, { slotDate: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      body(UpdateAvailabilitySlotDto, { slotDate: '2026-04-31' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      body(UpdateAvailabilitySlotDto, { slotDate: '2028-02-29' }),
    ).resolves.toMatchObject({ slotDate: '2028-02-29' });
  });
});
