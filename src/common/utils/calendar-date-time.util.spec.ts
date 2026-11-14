import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { AdminActivityLogQueryDto } from '../../admin/dto/admin-activity-log-query.dto';
import { DashboardQueryDto } from '../../dashboard/dto/dashboard-query.dto';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../pipes/validation-pipe.options';
import { isCalendarDateTimeString } from './calendar-date.util';

const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function query(metatype: new () => object, value: unknown) {
  return pipe.transform(value, { type: 'query', metatype }) as Promise<
    Record<string, unknown>
  >;
}

const validDateTimes = [
  '2026-10-01',
  '2028-02-29',
  '2000-02-29T00:00:00Z',
  '2026-10-01T10:00',
  '2026-10-01T10:00:00',
  '2026-10-01T10:00:00Z',
  '2026-10-01T10:00:00.123Z',
  '2026-10-01T10:00:00.123456Z',
  '2026-10-01T23:59:59+07:00',
  '2026-10-01T00:00:00-05:30',
  '2026-10-01T00:00:00+14:00',
  '2026-10-01T00:00:00-12:00',
];

const invalidDateTimes: Array<[string, unknown]> = [
  ['impossible date Feb 30', '2026-02-30T00:00:00Z'],
  ['non-leap Feb 29', '2027-02-29T10:00:00Z'],
  ['century non-leap Feb 29', '1900-02-29'],
  ['April 31 date-only', '2026-04-31'],
  ['month 13', '2026-13-01T00:00:00Z'],
  ['hour 24', '2026-10-01T24:00:00Z'],
  ['minute 60', '2026-10-01T23:60:00Z'],
  ['second 60', '2026-10-01T10:00:60Z'],
  ['offset +15:00', '2026-10-01T10:00:00+15:00'],
  ['offset +24:00', '2026-10-01T10:00:00+24:00'],
  ['offset minutes 60', '2026-10-01T10:00:00+07:60'],
  ['offset without colon', '2026-10-01T10:00:00+0700'],
  ['ISO week date', '2026-W40'],
  ['ISO ordinal date', '2026-274'],
  ['basic format', '20261001T100000Z'],
  ['partial year-month', '2026-10'],
  ['year only', '2026'],
  ['space separator', '2026-10-01 10:00:00'],
  ['hour only', '2026-10-01T10'],
  ['lowercase t/z', '2026-10-01t10:00:00z'],
  ['fraction without seconds', '2026-10-01T10:00.5Z'],
  ['year 0000', '0000-01-01T00:00:00Z'],
  ['empty string', ''],
  ['word', 'yesterday'],
  ['number', 1759312800000],
  ['array', ['2026-10-01']],
];

describe('isCalendarDateTimeString', () => {
  it.each(validDateTimes)('accepts %s', (value) => {
    expect(isCalendarDateTimeString(value)).toBe(true);
  });

  it.each(invalidDateTimes)('rejects %s', (_label, value) => {
    expect(isCalendarDateTimeString(value)).toBe(false);
  });

  it('only accepts values that Date parses without normalization', () => {
    for (const value of validDateTimes) {
      expect(Number.isNaN(new Date(value).getTime())).toBe(false);
    }
  });
});

describe('AdminActivityLogQueryDto from/to', () => {
  it.each(validDateTimes)('accepts from=%s', async (from) => {
    await expect(query(AdminActivityLogQueryDto, { from })).resolves.toMatchObject({
      from,
    });
  });

  it.each(invalidDateTimes)('rejects from as %s with 400', async (_label, from) => {
    await expect(
      query(AdminActivityLogQueryDto, { from }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(invalidDateTimes)('rejects to as %s with 400', async (_label, to) => {
    await expect(
      query(AdminActivityLogQueryDto, { to }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps from/to optional and pagination defaults unchanged', async () => {
    await expect(query(AdminActivityLogQueryDto, {})).resolves.toMatchObject({
      limit: 50,
      offset: 0,
    });
  });

  it('keeps combined filters working', async () => {
    await expect(
      query(AdminActivityLogQueryDto, {
        from: '2026-10-01T00:00:00+07:00',
        to: '2026-10-31T23:59:59+07:00',
        targetType: 'USER',
        limit: '10',
      }),
    ).resolves.toMatchObject({
      from: '2026-10-01T00:00:00+07:00',
      to: '2026-10-31T23:59:59+07:00',
      targetType: 'USER',
      limit: 10,
    });
  });
});

describe('DashboardQueryDto from/to', () => {
  const period = (from: unknown, to: unknown) => ({ from, to });

  it.each([
    ['2026-10-01', '2026-10-31'],
    ['2028-02-01', '2028-02-29'],
    ['2026-01-01', '2026-01-01'],
  ])('accepts %s..%s', async (from, to) => {
    await expect(query(DashboardQueryDto, period(from, to))).resolves.toMatchObject({
      from,
      to,
    });
  });

  it.each([
    ['impossible Feb 30', '2026-02-30'],
    ['non-leap Feb 29', '2027-02-29'],
    ['April 31', '2026-04-31'],
    ['month 13', '2026-13-01'],
    ['non-padded', '2026-1-5'],
    ['datetime', '2026-10-01T00:00:00Z'],
    ['datetime with offset', '2026-10-01T00:00:00+07:00'],
    ['partial', '2026-10'],
    ['empty string', ''],
    ['array', ['2026-10-01']],
  ])('rejects from as %s with 400', async (_label, from) => {
    await expect(
      query(DashboardQueryDto, period(from, '2026-10-31')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an impossible to date with 400', async () => {
    await expect(
      query(DashboardQueryDto, period('2026-02-01', '2026-02-30')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['from missing', { to: '2026-10-31' }],
    ['to missing', { from: '2026-10-01' }],
    ['both missing', {}],
  ])('keeps the period required (%s -> 400)', async (_label, value) => {
    await expect(query(DashboardQueryDto, value)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('leaves the from <= to range rule to the service (DTO accepts a reversed period)', async () => {
    await expect(
      query(DashboardQueryDto, period('2026-10-31', '2026-10-01')),
    ).resolves.toMatchObject({ from: '2026-10-31', to: '2026-10-01' });
  });
});
