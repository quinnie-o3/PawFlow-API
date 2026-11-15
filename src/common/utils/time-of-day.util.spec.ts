import { BadRequestException } from '@nestjs/common';

import {
  assertStartTimeBeforeEndTime,
  parseTimeOfDayToSeconds,
} from './time-of-day.util';

describe('parseTimeOfDayToSeconds', () => {
  it('parses HH:mm request values', () => {
    expect(parseTimeOfDayToSeconds('00:00')).toBe(0);
    expect(parseTimeOfDayToSeconds('09:00')).toBe(9 * 3600);
    expect(parseTimeOfDayToSeconds('23:59')).toBe(23 * 3600 + 59 * 60);
  });

  it('parses HH:mm:ss values returned by PostgreSQL TIME columns', () => {
    expect(parseTimeOfDayToSeconds('17:00:00')).toBe(17 * 3600);
    expect(parseTimeOfDayToSeconds('17:00:30')).toBe(17 * 3600 + 30);
    expect(parseTimeOfDayToSeconds('17:00:00.5')).toBe(17 * 3600 + 0.5);
  });

  it('treats HH:mm and HH:mm:00 as the same instant', () => {
    expect(parseTimeOfDayToSeconds('17:00')).toBe(
      parseTimeOfDayToSeconds('17:00:00'),
    );
  });

  it('accepts the PostgreSQL end-of-day value 24:00', () => {
    expect(parseTimeOfDayToSeconds('24:00')).toBe(86400);
    expect(parseTimeOfDayToSeconds('24:00:00')).toBe(86400);
  });

  it.each([
    '',
    '9:00',
    '24:01',
    '25:00',
    '12:60',
    '12:00:60',
    '12:00:00.1234567',
    '12-00',
    'noon',
    ' 12:00',
  ])('rejects malformed value %p', (value) => {
    expect(parseTimeOfDayToSeconds(value)).toBeNull();
  });

  it('rejects non-string values', () => {
    expect(parseTimeOfDayToSeconds(null)).toBeNull();
    expect(parseTimeOfDayToSeconds(undefined)).toBeNull();
    expect(parseTimeOfDayToSeconds(900)).toBeNull();
  });
});

describe('assertStartTimeBeforeEndTime', () => {
  it('accepts a valid range', () => {
    expect(() => assertStartTimeBeforeEndTime('09:00', '17:00')).not.toThrow();
  });

  it('accepts the full-day boundary range 00:00 to 23:59', () => {
    expect(() => assertStartTimeBeforeEndTime('00:00', '23:59')).not.toThrow();
  });

  it('rejects equal times', () => {
    expect(() => assertStartTimeBeforeEndTime('17:00', '17:00')).toThrow(
      BadRequestException,
    );
  });

  it('rejects reversed times', () => {
    expect(() => assertStartTimeBeforeEndTime('18:00', '17:00')).toThrow(
      BadRequestException,
    );
  });

  it('rejects HH:mm compared against an equal persisted HH:mm:ss value', () => {
    // Lexically '17:00' < '17:00:00', which previously let this pass.
    expect(() => assertStartTimeBeforeEndTime('17:00', '17:00:00')).toThrow(
      'startTime must be earlier than endTime',
    );
    expect(() => assertStartTimeBeforeEndTime('17:00:00', '17:00')).toThrow(
      'startTime must be earlier than endTime',
    );
  });

  it('keeps persisted seconds significant instead of truncating them', () => {
    expect(() =>
      assertStartTimeBeforeEndTime('17:00', '17:00:30'),
    ).not.toThrow();
    expect(() => assertStartTimeBeforeEndTime('17:00:30', '17:00')).toThrow(
      BadRequestException,
    );
  });

  it('does not support overnight ranges', () => {
    expect(() => assertStartTimeBeforeEndTime('22:00', '02:00')).toThrow(
      BadRequestException,
    );
  });

  it('rejects malformed times with 400', () => {
    expect(() => assertStartTimeBeforeEndTime('9am', '17:00')).toThrow(
      'startTime must be a valid time',
    );
    expect(() => assertStartTimeBeforeEndTime('09:00', '5pm')).toThrow(
      'endTime must be a valid time',
    );
  });
});
