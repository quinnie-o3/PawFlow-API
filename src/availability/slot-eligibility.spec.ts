import {
  captureSchedulingClock,
  getDayOfWeek,
  hasSlotStarted,
  slotFitsWorkingHours,
  type WorkingInterval,
} from './slot-eligibility';

describe('captureSchedulingClock', () => {
  it('captures local date, millisecond time and seconds of day from one instant', () => {
    expect(captureSchedulingClock(new Date(2026, 10, 2, 9, 5, 7, 45))).toEqual({
      today: '2026-11-02',
      timeOfDay: '09:05:07.045',
      secondsOfDay: 9 * 3600 + 5 * 60 + 7.045,
    });
  });

  it('rolls over correctly at the end of a leap-year February', () => {
    expect(
      captureSchedulingClock(new Date(2028, 1, 29, 23, 59, 59, 999)).today,
    ).toBe('2028-02-29');
    expect(captureSchedulingClock(new Date(2028, 2, 1, 0, 0, 0, 0))).toMatchObject({
      today: '2028-03-01',
      timeOfDay: '00:00:00.000',
      secondsOfDay: 0,
    });
  });
});

describe('getDayOfWeek', () => {
  it.each([
    ['2026-11-01', 0], // Sunday
    ['2026-11-02', 1],
    ['2026-11-07', 6],
    ['2028-02-29', 2], // leap day
    ['2027-01-01', 5], // year boundary
    ['2026-12-31', 4],
    ['2000-02-29', 2], // century leap year
  ])('%s -> %d (0 = Sunday)', (date, expected) => {
    expect(getDayOfWeek(date)).toBe(expected);
  });

  it.each(['2027-02-29', '2026-13-01', '2026-11-2', '2026-11-02T00:00'])(
    'rejects the invalid date %s',
    (date) => {
      expect(() => getDayOfWeek(date)).toThrow('Invalid calendar date');
    },
  );
});

describe('hasSlotStarted', () => {
  // 2026-11-02 14:05:30.250 local.
  const clock = captureSchedulingClock(new Date(2026, 10, 2, 14, 5, 30, 250));
  const at = (slotDate: string, startTime: string) => ({ slotDate, startTime });

  it.each([
    ['earlier day', at('2026-11-01', '23:59:59'), true],
    ['earlier within the current minute (HH:mm)', at('2026-11-02', '14:05'), true],
    ['earlier within the current minute (HH:mm:ss)', at('2026-11-02', '14:05:00'), true],
    ['same second, before the milliseconds', at('2026-11-02', '14:05:30'), true],
    ['exactly now', at('2026-11-02', '14:05:30.250'), true],
    ['one millisecond later', at('2026-11-02', '14:05:30.251'), false],
    ['next second', at('2026-11-02', '14:05:31'), false],
    ['next minute (HH:mm)', at('2026-11-02', '14:06'), false],
    ['tomorrow at midnight', at('2026-11-03', '00:00:00'), false],
  ])('%s -> started=%s', (_case, slot, started) => {
    expect(hasSlotStarted(slot, clock)).toBe(started);
  });

  it('compares chronologically, not by string length', () => {
    // "14:05:00" > "14:05" lexically; chronologically they are equal.
    expect(hasSlotStarted(at('2026-11-02', '14:05:00'), clock)).toBe(
      hasSlotStarted(at('2026-11-02', '14:05'), clock),
    );
  });

  it('throws for an invalid time instead of guessing', () => {
    expect(() => hasSlotStarted(at('2026-11-02', '25:00'), clock)).toThrow(
      'Invalid time of day',
    );
  });
});

describe('slotFitsWorkingHours', () => {
  const monday = '2026-11-02';
  const interval = (
    dayOfWeek: number,
    startTime: string,
    endTime: string,
  ): WorkingInterval => ({ dayOfWeek, startTime, endTime });
  const slot = (startTime: string, endTime: string, slotDate = monday) => ({
    slotDate,
    startTime,
    endTime,
  });

  it.each([
    ['fully inside', slot('10:00', '11:00'), true],
    ['exactly the interval', slot('09:00', '17:00'), true],
    ['starting at opening (mixed HH:mm vs HH:mm:ss)', slot('09:00:00', '09:30'), true],
    ['ending at closing', slot('16:00', '17:00:00'), true],
    ['before opening', slot('07:00', '08:00'), false],
    ['after closing', slot('17:00', '18:00'), false],
    ['crossing opening', slot('08:59', '09:30'), false],
    ['crossing closing by one second', slot('16:00', '17:00:01'), false],
  ])('%s -> %s', (_case, value, fits) => {
    expect(slotFitsWorkingHours(value, [interval(1, '09:00:00', '17:00:00')])).toBe(fits);
  });

  it('requires an interval on the slot weekday (closed day)', () => {
    expect(
      slotFitsWorkingHours(slot('10:00', '11:00'), [interval(2, '00:00:00', '23:59:00')]),
    ).toBe(false);
    expect(slotFitsWorkingHours(slot('10:00', '11:00'), [])).toBe(false);
  });

  it('accepts any one of several intervals but does not merge them', () => {
    const split = [interval(1, '08:00', '12:00'), interval(1, '13:00', '17:00')];

    expect(slotFitsWorkingHours(slot('13:00', '14:00'), split)).toBe(true);
    expect(slotFitsWorkingHours(slot('11:30', '12:00'), split)).toBe(true);
    expect(slotFitsWorkingHours(slot('11:30', '13:30'), split)).toBe(false);
    // Adjacent or overlapping entries are still separate intervals.
    expect(
      slotFitsWorkingHours(slot('11:00', '13:00'), [
        interval(1, '08:00', '12:00'),
        interval(1, '12:00', '17:00'),
      ]),
    ).toBe(false);
  });

  it('uses the weekday of the slot date across leap-day and year boundaries', () => {
    expect(
      slotFitsWorkingHours(slot('09:00', '10:00', '2028-02-29'), [interval(2, '09:00', '17:00')]),
    ).toBe(true);
    expect(
      slotFitsWorkingHours(slot('09:00', '10:00', '2027-01-01'), [interval(4, '09:00', '17:00')]),
    ).toBe(false);
  });
});
