/**
 * Shared scheduling rules for availability slots (P2-06B, P2-08A).
 *
 * One definition is used by slot management, booking creation and the
 * public availability queries, so a slot is offered publicly exactly when
 * booking would accept it.
 *
 * Time zone: dates and times of day are interpreted in the server's local
 * time zone, which must be the business time zone (Asia/Ho_Chi_Minh). This
 * is the existing convention of `getTodayDateString`; slot and working-hour
 * columns are zone-less DATE/TIME values.
 */
import { isCalendarDateString } from '../common/utils/calendar-date.util';
import { parseTimeOfDayToSeconds } from '../common/utils/time-of-day.util';

export interface SlotSchedule {
  slotDate: string;
  startTime: string;
  endTime: string;
}

export interface WorkingInterval {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** One captured "now", so every check in an operation uses the same instant. */
export interface SchedulingClock {
  /** Local calendar date, `YYYY-MM-DD`. */
  today: string;
  /** Local time of day with milliseconds, `HH:mm:ss.SSS` (PostgreSQL TIME literal). */
  timeOfDay: string;
  /** Local time of day in seconds since midnight, including the fraction. */
  secondsOfDay: number;
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

export function captureSchedulingClock(now: Date = new Date()): SchedulingClock {
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();

  return {
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    timeOfDay: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`,
    secondsOfDay: hours * 3600 + minutes * 60 + seconds + milliseconds / 1000,
  };
}

/**
 * Weekday of a strict `YYYY-MM-DD` date: 0 = Sunday ... 6 = Saturday, the
 * convention of `provider_working_hours.day_of_week` and PostgreSQL
 * `EXTRACT(DOW ...)`. Computed in UTC so the server time zone cannot shift
 * the day.
 */
export function getDayOfWeek(slotDate: string): number {
  if (!isCalendarDateString(slotDate)) {
    throw new Error(`Invalid calendar date: ${slotDate}`);
  }

  const [year, month, day] = slotDate.split('-').map(Number);
  const date = new Date(Date.UTC(2000, month - 1, day));

  // Date.UTC maps years 0-99 to 1900-1999, so set the full year explicitly.
  date.setUTCFullYear(year);

  return date.getUTCDay();
}

function toSeconds(value: string): number {
  const seconds = parseTimeOfDayToSeconds(value);

  if (seconds === null) {
    throw new Error(`Invalid time of day: ${value}`);
  }

  return seconds;
}

/**
 * True once the slot's start instant is not strictly in the future: any
 * earlier day, or today with a start time at or before the current instant
 * (seconds and milliseconds included). There is no minimum lead time.
 */
export function hasSlotStarted(
  slot: Pick<SlotSchedule, 'slotDate' | 'startTime'>,
  clock: SchedulingClock,
): boolean {
  if (slot.slotDate !== clock.today) {
    return slot.slotDate < clock.today;
  }

  return toSeconds(slot.startTime) <= clock.secondsOfDay;
}

/**
 * P2-08A: true when the slot is at least as long as its service
 * (`end - start >= durationMinutes`), compared in seconds so persisted
 * `HH:mm:ss` values with nonzero seconds are measured exactly.
 */
export function slotCoversServiceDuration(
  slot: Pick<SlotSchedule, 'startTime' | 'endTime'>,
  durationMinutes: number,
): boolean {
  return toSeconds(slot.endTime) - toSeconds(slot.startTime) >= durationMinutes * 60;
}

/**
 * True when the slot lies entirely inside one active working interval of
 * its weekday. Intervals are not merged: adjacent entries stay separate,
 * historical entries may still overlap (P2-09B only blocks new overlaps)
 * and overnight intervals do not exist (`start_time < end_time` CHECK), so
 * a slot that only fits the union of two entries is rejected.
 */
export function slotFitsWorkingHours(
  slot: SlotSchedule,
  intervals: readonly WorkingInterval[],
): boolean {
  const dayOfWeek = getDayOfWeek(slot.slotDate);
  const start = toSeconds(slot.startTime);
  const end = toSeconds(slot.endTime);

  return intervals.some(
    (interval) =>
      interval.dayOfWeek === dayOfWeek &&
      toSeconds(interval.startTime) <= start &&
      end <= toSeconds(interval.endTime),
  );
}

/**
 * P2-09B: the first of `intervals` that overlaps `candidate` on the same
 * weekday. Intervals are half-open `[start, end)` and compared in seconds,
 * so 08:00-12:00 and 12:00-17:00 only touch and do not overlap. Callers
 * pass the active intervals, without the entry being changed.
 */
export function findOverlappingWorkingInterval<T extends WorkingInterval>(
  candidate: WorkingInterval,
  intervals: readonly T[],
): T | undefined {
  const start = toSeconds(candidate.startTime);
  const end = toSeconds(candidate.endTime);

  return intervals.find(
    (interval) =>
      interval.dayOfWeek === candidate.dayOfWeek &&
      toSeconds(interval.startTime) < end &&
      start < toSeconds(interval.endTime),
  );
}

/**
 * SQL form of "not started" for a query builder with a `slot` alias.
 * Parameters: `:today`, `:currentTime` from a `SchedulingClock`.
 */
export const SLOT_NOT_STARTED_SQL =
  '(slot.slotDate > :today OR (slot.slotDate = :today AND slot.startTime > :currentTime))';

/**
 * SQL form of `slotFitsWorkingHours` for a query builder with a `slot`
 * alias. `EXTRACT(DOW ...)` uses the same 0 = Sunday convention.
 */
export const SLOT_WITHIN_WORKING_HOURS_SQL =
  'EXISTS (SELECT 1 FROM provider_working_hours working_hour WHERE working_hour.provider_id = slot.providerId AND working_hour.is_active = TRUE AND working_hour.day_of_week = EXTRACT(DOW FROM slot.slotDate) AND working_hour.start_time <= slot.startTime AND working_hour.end_time >= slot.endTime)';

/**
 * SQL form of `slotCoversServiceDuration` for a query builder with `slot`
 * and `service` aliases. TIME - TIME is an interval; its epoch keeps
 * fractional seconds.
 */
export const SLOT_COVERS_SERVICE_DURATION_SQL =
  'EXTRACT(EPOCH FROM (slot.endTime - slot.startTime)) >= service.durationMinutes * 60';

/**
 * SQL: the slot's appointment has not ended yet (end instant after the
 * clock). Parameters: `:today`, `:currentTime` from a `SchedulingClock`.
 */
export const SLOT_NOT_ENDED_SQL =
  '(slot.slotDate > :today OR (slot.slotDate = :today AND slot.endTime > :currentTime))';

export const SLOT_STARTED_MESSAGE =
  'The availability slot has already started; its start time must be in the future';

export const SLOT_OUTSIDE_WORKING_HOURS_MESSAGE =
  "The slot must fit entirely within one of the provider's active working hours for that day";
