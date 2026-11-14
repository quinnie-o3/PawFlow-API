import { BadRequestException } from '@nestjs/common';

/**
 * Matches time-of-day values in the representations this API encounters:
 * - `HH:mm` from request DTOs.
 * - `HH:mm:ss[.ffffff]` returned by PostgreSQL TIME columns.
 * - `24:00[:00]`, which PostgreSQL TIME accepts as end of day.
 */
const TIME_OF_DAY_PATTERN =
  /^(?:([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d(?:\.\d{1,6})?))?|24:00(?::00(?:\.0{1,6})?)?)$/;

/**
 * Converts a time-of-day string to seconds since midnight.
 *
 * Seconds and fractional seconds are preserved, so `17:00` and `17:00:00`
 * compare as equal while `17:00:30` remains later than `17:00`.
 *
 * Returns `null` when the value is not a valid time of day.
 */
export function parseTimeOfDayToSeconds(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = TIME_OF_DAY_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  if (match[1] === undefined) {
    return 24 * 60 * 60;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Enforces `startTime < endTime` chronologically rather than lexically.
 *
 * Overnight ranges are not supported: an end time equal to or earlier than
 * the start time is rejected, matching the `start_time < end_time` CHECK
 * constraints on `provider_working_hours` and `availability_slots`.
 */
export function assertStartTimeBeforeEndTime(
  startTime: string,
  endTime: string,
): void {
  const startSeconds = parseTimeOfDayToSeconds(startTime);
  const endSeconds = parseTimeOfDayToSeconds(endTime);

  if (startSeconds === null) {
    throw new BadRequestException('startTime must be a valid time');
  }

  if (endSeconds === null) {
    throw new BadRequestException('endTime must be a valid time');
  }

  if (startSeconds >= endSeconds) {
    throw new BadRequestException(
      'startTime must be earlier than endTime',
    );
  }
}
