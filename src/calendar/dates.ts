import { type TFunction } from "i18next";

/**
 * Date arithmetic and formatting for the calendar and the meeting list.
 *
 * Every user-visible name, number and time comes from Intl keyed on the
 * application's language rather than the browser's, so a Dutch interface on an
 * English browser still reads in Dutch. Weekday and month names never come
 * from translation keys.
 */

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

/** The time of day, in the locale's own clock convention. */
export function formatTimeOfDay(locale: string, date: Date | number): string {
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
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

/** The label for one row of a time grid's hour gutter. */
export function formatHour(locale: string, hour: number): string {
  return dateTimeFormat(locale, { hour: "numeric" }).format(
    new Date(2000, 0, 1, hour),
  );
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
