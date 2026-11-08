import {
  buildMessage,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Returns true for a real calendar date in strict `YYYY-MM-DD` form.
 *
 * Validates month and day ranges arithmetically (Gregorian leap years)
 * instead of relying on `Date` parsing, which silently rolls invalid dates
 * forward (e.g. `2027-02-30` becomes March 2). Year 0000 is rejected because
 * PostgreSQL DATE has no year zero.
 */
export function isCalendarDateString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const match = CALENDAR_DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

const CALENDAR_DATE_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))?)?$/;

/** Largest real-world UTC offset (UTC+14:00 / UTC-12:00 fit within it). */
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

/**
 * Returns true for an extended ISO 8601 timestamp that `new Date()` parses
 * without normalization:
 * - `YYYY-MM-DD` (interpreted by `Date` as UTC midnight), or
 * - `YYYY-MM-DDTHH:mm[:ss[.fraction]]` with optional `Z` or `±HH:MM`
 *   (no offset means server local time, as `Date` does).
 *
 * Rejects impossible calendar dates (`2026-02-30`), out-of-range times
 * (`24:00`, `:60`), offsets beyond ±14:00, and ISO forms that `Date` cannot
 * parse (week `2026-W40`, ordinal `2026-274`, basic `20261001T100000Z`,
 * partial `2026-10`), which would otherwise reach PostgreSQL as
 * `"Invalid Date"` (SQLSTATE 22007).
 */
export function isCalendarDateTimeString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const match = CALENDAR_DATE_TIME_PATTERN.exec(value);

  if (!match || !isCalendarDateString(match[1])) {
    return false;
  }

  const [, , hour, minute, second, zone, , offsetHour, offsetMinute] = match;

  if (hour !== undefined) {
    if (Number(hour) > 23 || Number(minute) > 59) {
      return false;
    }

    if (second !== undefined && Number(second) > 59) {
      return false;
    }
  }

  if (zone !== undefined && zone !== 'Z') {
    const offsetMinutes = Number(offsetHour) * 60 + Number(offsetMinute);

    if (Number(offsetMinute) > 59 || offsetMinutes > MAX_UTC_OFFSET_MINUTES) {
      return false;
    }
  }

  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Today's calendar date as `YYYY-MM-DD` in the server's local time zone.
 *
 * This matches the existing convention for "today" in availability and
 * booking date checks; the server is expected to run in the business time
 * zone (Asia/Ho_Chi_Minh).
 */
export function getTodayDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Current local time of day as `HH:mm`, in the same server time zone as
 * `getTodayDateString`. Booking compares slot start times against this value.
 */
export function getCurrentTimeOfDayString(now: Date = new Date()): string {
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');

  return `${hour}:${minute}`;
}

/** Validates a strict `YYYY-MM-DD` calendar date (no time or offset). */
export function IsCalendarDate(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isCalendarDate',
      validator: {
        validate: (value: unknown) => isCalendarDateString(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be a valid calendar date in YYYY-MM-DD format`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/**
 * Validates a strict ISO 8601 timestamp for datetime filters
 * (see `isCalendarDateTimeString`).
 */
export function IsCalendarDateTime(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isCalendarDateTime',
      validator: {
        validate: (value: unknown) => isCalendarDateTimeString(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be a valid ISO 8601 date-time (YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:MM])`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/**
 * Rejects calendar dates after today (server local date). Today is allowed.
 * Non-dates are left to `IsCalendarDate` so only one message is reported.
 */
export function IsNotFutureCalendarDate(
  validationOptions?: ValidationOptions,
) {
  return ValidateBy(
    {
      name: 'isNotFutureCalendarDate',
      validator: {
        // Canonical YYYY-MM-DD strings compare chronologically.
        validate: (value: unknown) =>
          !isCalendarDateString(value) || value <= getTodayDateString(),
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property cannot be in the future`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
