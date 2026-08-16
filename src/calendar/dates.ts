import { type TFunction } from "i18next";

import { Config } from "../config/Config";
import {
  CALENDAR_DEFAULTS,
  type FirstDayOfWeek,
} from "../config/ConfigOptions";
import { type ScheduledMeeting } from "../home/useScheduledMeetings";

/**
 * Date arithmetic, layout projection and formatting for the calendar and the
 * meeting list.
 *
 * Every user-visible name, number and time comes from Intl keyed on the
 * application's language rather than the browser's, so a Dutch interface on an
 * English browser still reads in Dutch. Weekday and month names never come
 * from translation keys.
 *
 * Positions in the time grid are derived from local wall-clock fields and
 * never from a difference of two instants: on the two days a year that are 23
 * or 25 hours long, the two disagree by an hour.
 */

export const CALENDAR_VIEWS = ["day", "week", "month", "agenda"] as const;

export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: string | null): value is CalendarView {
  return CALENDAR_VIEWS.includes(value as CalendarView);
}

// Intl formatters cost far more to construct than to use, and a month grid
// needs one per cell, so they are kept keyed by language and option set.
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  let format = relativeTimeFormats.get(locale);
  if (format === undefined) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeTimeFormats.set(locale, format);
  }
  return format;
}

/** Whether two instants fall on the same local calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local midnight on the day containing `date`. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `date` moved by whole calendar days, keeping its time of day. */
export function addDays(date: Date, days: number): Date {
  const moved = new Date(date);
  moved.setDate(moved.getDate() + days);
  return moved;
}

/** Whole calendar days from `from` to `to`, unaffected by clock changes. */
export function daysBetween(from: Date, to: Date): number {
  const utc = (d: Date): number =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(to) - utc(from)) / 86400000);
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

interface WeekInfo {
  /** 1 = Monday through 7 = Sunday, as the locale data numbers weekdays. */
  firstDay: number;
}

function localeWeekInfo(locale: Intl.Locale): WeekInfo | undefined {
  // The proposal changed shape late: some engines shipped weekInfo as a
  // property before getWeekInfo() was settled on, and some ship neither.
  const candidate = locale as Intl.Locale & {
    getWeekInfo?: () => WeekInfo;
    weekInfo?: WeekInfo;
  };
  return typeof candidate.getWeekInfo === "function"
    ? candidate.getWeekInfo()
    : candidate.weekInfo;
}

/**
 * The weekday a week starts on, as a Sunday-based index. "auto" asks the
 * runtime's locale data and falls back to the ISO week where it has none.
 */
export function resolveFirstDayOfWeek(
  setting: FirstDayOfWeek,
  locale: string,
): number {
  if (setting !== "auto") return WEEKDAYS.indexOf(setting);
  try {
    const info = localeWeekInfo(new Intl.Locale(locale));
    if (info) return info.firstDay % 7;
  } catch {
    // An unparseable language tag; the ISO week is the safer answer.
  }
  return 1;
}

/** The configured first day of the week, resolved for `locale`. */
export function firstDayOfWeek(locale: string): number {
  return resolveFirstDayOfWeek(
    Config.get().calendar?.first_day_of_week ??
      CALENDAR_DEFAULTS.first_day_of_week,
    locale,
  );
}

/**
 * The hours the time grid highlights and scrolls to. The grid still renders
 * the whole day, so a meeting outside them is never hidden.
 */
export function workingHours(): { start: number; end: number } {
  const calendar = Config.get().calendar;
  return {
    start: calendar?.day_start_hour ?? CALENDAR_DEFAULTS.day_start_hour,
    end: calendar?.day_end_hour ?? CALENDAR_DEFAULTS.day_end_hour,
  };
}

/** The first day of the week containing `date`, at local midnight. */
export function startOfWeek(date: Date, firstDay: number): Date {
  const start = startOfDay(date);
  return addDays(start, -((start.getDay() - firstDay + 7) % 7));
}

/** The seven days of the week containing `date`. */
export function weekDays(date: Date, firstDay: number): Date[] {
  const start = startOfWeek(date, firstDay);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * The days a month grid shows: whole weeks covering the month of `date`, and
 * no more rows than that needs.
 */
export function monthGridDays(date: Date, firstDay: number): Date[] {
  const start = startOfWeek(
    new Date(date.getFullYear(), date.getMonth(), 1),
    firstDay,
  );
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const weeks = Math.ceil((daysBetween(start, last) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

/** The window a view covers, as local midnights with `end` exclusive. */
export function viewRange(
  view: CalendarView,
  focusedDate: Date,
  firstDay: number,
): { start: Date; end: Date } {
  switch (view) {
    case "day": {
      const start = startOfDay(focusedDate);
      return { start, end: addDays(start, 1) };
    }
    case "week": {
      const start = startOfWeek(focusedDate, firstDay);
      return { start, end: addDays(start, 7) };
    }
    case "month": {
      const days = monthGridDays(focusedDate, firstDay);
      return { start: days[0], end: addDays(days[days.length - 1], 1) };
    }
    case "agenda":
      return {
        start: new Date(focusedDate.getFullYear(), focusedDate.getMonth(), 1),
        end: new Date(focusedDate.getFullYear(), focusedDate.getMonth() + 1, 1),
      };
  }
}

/** Where the previous or next control lands, which differs per view. */
export function stepDate(
  view: CalendarView,
  focusedDate: Date,
  direction: 1 | -1,
): Date {
  switch (view) {
    case "day":
      return addDays(focusedDate, direction);
    case "week":
      return addDays(focusedDate, 7 * direction);
    case "month":
    case "agenda":
      return new Date(
        focusedDate.getFullYear(),
        focusedDate.getMonth() + direction,
        1,
      );
  }
}

/** The focused date as it appears in the URL. */
export function toDateParam(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Reads a `YYYY-MM-DD` URL parameter as a local date. */
export function fromDateParam(value: string | null): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Reject dates that only exist after rolling over, such as 2026-02-31.
  return date.getMonth() === Number(month) - 1 ? date : undefined;
}

export const MINUTES_PER_DAY = 1440;

/** An instant on `day`, that many minutes after its local midnight. */
export function atMinute(day: Date, minute: number): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minute / 60),
    minute % 60,
  );
}

/**
 * Minutes from local midnight at a fractional distance down a day column,
 * snapped to a multiple of `snap`.
 *
 * The two roundings are not interchangeable. `floor` places a press in the
 * slot cell it landed in, which is how clicking an hour already picks its
 * start time. `nearest` is for the edge a pointer is dragging, which would
 * otherwise trail up to a whole slot behind the cursor and feel slack.
 */
export function snappedMinute(
  fraction: number,
  snap: number,
  rounding: "floor" | "nearest",
): number {
  const minutes = Math.min(Math.max(fraction, 0), 1) * MINUTES_PER_DAY;
  const slots = minutes / snap;
  const round = rounding === "floor" ? Math.floor : Math.round;
  return round(slots) * snap;
}

/**
 * The block a drag covers, from the slot the pointer went down in to the slot
 * it has reached. Dragging upward grows the block above the press.
 *
 * The pressed slot is always inside the result, so a drag is never shorter
 * than one slot and never flips to the far side of where it began. Both edges
 * are clamped to the day: the grid has no multi-day lane to draw the result
 * in, so it cannot be dragged into one.
 */
export function dragRange(
  anchorMinute: number,
  edgeMinute: number,
  slotMinutes: number,
): { startMinute: number; endMinute: number } {
  const anchorStart = Math.min(
    Math.max(anchorMinute, 0),
    MINUTES_PER_DAY - slotMinutes,
  );
  const anchorEnd = anchorStart + slotMinutes;
  return edgeMinute >= anchorEnd
    ? {
        startMinute: anchorStart,
        endMinute: Math.min(edgeMinute, MINUTES_PER_DAY),
      }
    : {
        startMinute: Math.max(Math.min(edgeMinute, anchorStart), 0),
        endMinute: anchorEnd,
      };
}

/**
 * A dragged block's start instant and its length in real minutes.
 *
 * The edges are local wall-clock positions in a grid of 1440 fixed minutes,
 * but the length handed to the scheduling form is elapsed time, because that
 * is what the form adds to the start to get an end. The two differ on the two
 * days a year that are not 24 hours long: a block drawn across the hour the
 * clocks skip covers three rows but lasts two hours, and it has to end where
 * the pointer was released rather than an hour past it.
 */
export function slotSelection(
  day: Date,
  startMinute: number,
  endMinute: number,
): { start: Date; durationMinutes: number } {
  const start = atMinute(day, startMinute);
  const end = atMinute(day, endMinute);
  return {
    start,
    durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
  };
}

/** A length of time, as "45 min", "2 h" or "1 h 15 min". */
export function formatLength(t: TFunction<"app">, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0)
    return t("schedule_meeting.minutes_short", { count: minutes });
  if (rest === 0) return t("schedule_meeting.hours_short", { count: hours });
  // One key rather than two joined: an hour and a remainder are not written
  // in that order, or with that spacing, in every language.
  return t("schedule_meeting.hours_minutes_short", {
    count: hours,
    minutes: rest,
  });
}

/** A meeting placed in a day column, ready for a grid or a list. */
export interface PositionedEvent {
  meeting: ScheduledMeeting;
  /** Days from the start of the window to the day the meeting starts on. */
  dayIndex: number;
  /** Minutes from that day's local midnight to the top edge. */
  startMinute: number;
  /** Minutes from that day's local midnight to the bottom edge. */
  endMinute: number;
  /** Which of the side-by-side columns this meeting occupies. */
  column: number;
  /** How many columns the overlapping meetings were split into. */
  columnCount: number;
  inProgress: boolean;
}

/**
 * Places every meeting that starts inside the window into a day column, side
 * by side with the ones it overlaps.
 *
 * A meeting running past midnight is clipped at the end of its own day rather
 * than repeated in the next one: there is no multi-day lane, by design.
 */
export function visibleEvents(
  meetings: readonly ScheduledMeeting[],
  windowStart: Date,
  windowEnd: Date,
  now: number,
): PositionedEvent[] {
  const dayCount = daysBetween(windowStart, windowEnd);
  const byDay: PositionedEvent[][] = Array.from({ length: dayCount }, () => []);

  for (const meeting of meetings) {
    const start = new Date(meeting.scheduledStart);
    const dayIndex = daysBetween(windowStart, start);
    if (dayIndex < 0 || dayIndex >= dayCount) continue;

    const end = new Date(meeting.scheduledEnd);
    byDay[dayIndex].push({
      meeting,
      dayIndex,
      startMinute: start.getHours() * 60 + start.getMinutes(),
      endMinute: isSameDay(start, end)
        ? end.getHours() * 60 + end.getMinutes()
        : MINUTES_PER_DAY,
      column: 0,
      columnCount: 1,
      inProgress: meeting.scheduledStart <= now && now < meeting.scheduledEnd,
    });
  }

  return byDay.flatMap(layOutDay);
}

/**
 * Splits one day's meetings into columns: every run of meetings that overlaps
 * transitively shares a run of columns, and each meeting takes the leftmost
 * column that is free at its start.
 */
function layOutDay(events: PositionedEvent[]): PositionedEvent[] {
  events.sort(
    (a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute,
  );

  let group: PositionedEvent[] = [];
  let groupEnd = -1;

  const closeGroup = (): void => {
    if (group.length === 0) return;
    const columnEnds: number[] = [];
    for (const event of group) {
      const free = columnEnds.findIndex((end) => end <= event.startMinute);
      event.column = free === -1 ? columnEnds.length : free;
      columnEnds[event.column] = event.endMinute;
    }
    for (const event of group) event.columnCount = columnEnds.length;
    group = [];
  };

  for (const event of events) {
    if (event.startMinute >= groupEnd) closeGroup();
    group.push(event);
    groupEnd = Math.max(groupEnd, event.endMinute);
  }
  closeGroup();

  return events;
}

// Times are typed on a 24-hour clock, so by default they are shown on one too:
// displaying a convention the form does not accept makes the app contradict
// itself. A deployment can opt back into the locale's own clock.
function hourCycle(): Intl.DateTimeFormatOptions["hourCycle"] {
  const configured =
    Config.get().calendar?.time_display_24h ??
    CALENDAR_DEFAULTS.time_display_24h;
  return configured ? "h23" : undefined;
}

/** The time of day. */
export function formatTimeOfDay(locale: string, date: Date | number): string {
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: hourCycle(),
  }).format(date);
}

/** The day of the month on its own, for a grid cell. */
export function formatDayOfMonth(locale: string, date: Date): string {
  return dateTimeFormat(locale, { day: "numeric" }).format(date);
}

/** Month and year, for a calendar caption. */
export function formatMonth(locale: string, date: Date): string {
  return dateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    date,
  );
}

/** Weekday, day and month, for a day heading. */
export function formatDay(locale: string, date: Date): string {
  return dateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/** Day and month, for a compact reference to another date. */
export function formatShortDate(locale: string, date: Date | number): string {
  return dateTimeFormat(locale, { day: "numeric", month: "short" }).format(
    date,
  );
}

/** A span of days, collapsed the way the locale writes one. */
export function formatDateRange(locale: string, from: Date, to: Date): string {
  return dateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatRange(from, to);
}

/** The label for one row of a time grid's hour gutter. */
export function formatHour(locale: string, hour: number): string {
  return dateTimeFormat(locale, {
    hour: "numeric",
    hourCycle: hourCycle(),
  }).format(new Date(2000, 0, 1, hour));
}

/**
 * The seven weekday names for a grid header, starting on `firstDayOfWeek`
 * (0 = Sunday).
 */
export function weekdayNames(
  locale: string,
  firstDayOfWeek: number,
  width: "short" | "long",
): string[] {
  const format = dateTimeFormat(locale, { weekday: width });
  // 4 January 1970 was a Sunday, so offsetting from it by a weekday index
  // lands on that weekday.
  return Array.from({ length: 7 }, (_, i) =>
    format.format(new Date(1970, 0, 4 + ((firstDayOfWeek + i) % 7))),
  );
}

/**
 * How a meeting's start reads in a list: counting down while it is close,
 * then a time of day, then a date. `urgent` marks the cases that deserve
 * emphasis.
 */
export function formatRelativeStart(
  locale: string,
  t: TFunction<"app">,
  scheduledStart: number,
  now: number,
): { text: string; urgent: boolean } {
  const minutes = Math.floor((scheduledStart - now) / 60000);
  if (minutes <= 0) return { text: t("meetings.in_progress"), urgent: true };
  if (minutes < 60)
    return {
      text: relativeTimeFormat(locale).format(minutes, "minute"),
      urgent: true,
    };

  const start = new Date(scheduledStart);
  const time = formatTimeOfDay(locale, start);
  const today = new Date(now);
  if (isSameDay(start, today))
    return { text: t("meetings.today_at", { time }), urgent: false };

  const tomorrow = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1,
  );
  if (isSameDay(start, tomorrow))
    return { text: t("meetings.tomorrow_at", { time }), urgent: false };

  return {
    text: t("meetings.date_at", {
      date: formatShortDate(locale, start),
      time,
    }),
    urgent: false,
  };
}
