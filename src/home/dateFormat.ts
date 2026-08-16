// Parsing and formatting for the scheduling form's own inputs.
//
// The form exchanges "YYYY-MM-DD" and "HH:MM" with the rest of the app, so
// nothing here assumes a written date format. Anything a person reads is
// formatted in ../calendar/dates.

import { type DateOrder } from "../config/ConfigOptions";

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parse a date input's value plus a time input's value into an epoch-ms
// instant in local time. Returns undefined when either is empty or the date is
// not a real one (e.g. "2026-02-31", which would otherwise roll over).
export function parseStart(
  dateStr: string,
  timeStr: string,
): number | undefined {
  const match = DATE_REGEX.exec(dateStr.trim());
  if (!match || !timeStr) return undefined;
  const [, , mm, dd] = match;
  const ms = new Date(`${dateStr}T${timeStr}`).getTime();
  if (Number.isNaN(ms)) return undefined;
  const parsed = new Date(ms);
  if (parsed.getMonth() + 1 !== Number(mm) || parsed.getDate() !== Number(dd))
    return undefined;
  return ms;
}

// Format an epoch-ms instant for an <input type="date">, in local time.
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Format an epoch-ms instant for an <input type="time">, in local time.
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${min}`;
}

// --- Masked entry -----------------------------------------------------------
//
// Native date and time inputs render in the browser's UI locale and ignore the
// `lang` attribute entirely, so they cannot be pinned to one written format.
// These helpers back a plain text input instead: the field holds a stream of
// digits, and the separators are inserted on the way out. Entry order is
// configuration rather than locale, so a mixed fleet of workstations shares one
// muscle memory.

// A fixed-width run of digits within the stream. `min`/`max` bound the value a
// full segment may take; a `width` of 4 (the year) is left unbounded.
interface Segment {
  width: number;
  min: number;
  max: number;
}

const DAY: Segment = { width: 2, min: 1, max: 31 };
const MONTH: Segment = { width: 2, min: 1, max: 12 };
const YEAR: Segment = { width: 4, min: 0, max: 9999 };
const HOUR: Segment = { width: 2, min: 0, max: 23 };
const MINUTE: Segment = { width: 2, min: 0, max: 59 };

const DATE_SEGMENTS: Record<DateOrder, Segment[]> = {
  dmy: [DAY, MONTH, YEAR],
  mdy: [MONTH, DAY, YEAR],
  ymd: [YEAR, MONTH, DAY],
};
const TIME_SEGMENTS = [HOUR, MINUTE];

const dateSegments = (order: DateOrder): Segment[] => DATE_SEGMENTS[order];

// Which segment the next digit belongs to, and how far into it we already are.
function locate(
  segments: Segment[],
  length: number,
): { segment: Segment; offset: number } | undefined {
  let remaining = length;
  for (const segment of segments) {
    if (remaining < segment.width) return { segment, offset: remaining };
    remaining -= segment.width;
  }
  return undefined;
}

// Append one typed digit, returning the new stream, or the stream unchanged
// when the digit cannot begin or complete a valid value.
//
// A two-digit segment whose first digit is too large to lead any value in range
// can only have meant a zero-padded single digit, so it is padded and completed
// immediately: in a day, 4 through 9 become 04 through 09, while 0 through 3
// wait for a second digit because 10 through 31 exist.
function appendDigit(
  segments: Segment[],
  digits: string,
  digit: string,
): string {
  const at = locate(segments, digits.length);
  if (at === undefined) return digits;
  const { segment, offset } = at;
  const value = Number(digit);

  if (segment.width === 4 || offset > 0) {
    // Mid-segment: accept only if the completed value stays in range.
    if (offset === segment.width - 1 && segment.width === 2) {
      const complete = Number(digits.slice(-1)) * 10 + value;
      if (complete < segment.min || complete > segment.max) return digits;
    }
    return digits + digit;
  }

  if (value <= Math.floor(segment.max / 10)) return digits + digit;
  return value >= segment.min ? `${digits}0${digit}` : digits;
}

// Separators people reach for, whatever the configured one is — they type what
// their previous system used.
const SEPARATOR_CHARS = new Set([".", "/", "-", ",", ":", " "]);

// Complete a two-digit segment holding a single digit, so typing "1." means the
// 1st. A leading 0 is left alone because 00 is not a real day or month.
function padSegment(segments: Segment[], digits: string): string {
  const at = locate(segments, digits.length);
  if (at === undefined || at.segment.width !== 2 || at.offset !== 1)
    return digits;
  const typed = digits.slice(-1);
  if (Number(typed) < at.segment.min) return digits;
  return `${digits.slice(0, -1)}0${typed}`;
}

// Feed a whole string through the segments. Digits extend the stream, a
// separator completes the segment in progress, and everything else is ignored.
// Used for typing, for pasting, and for seeding.
function appendAll(segments: Segment[], digits: string, input: string): string {
  let next = digits;
  for (const char of input) {
    if (char >= "0" && char <= "9") next = appendDigit(segments, next, char);
    else if (SEPARATOR_CHARS.has(char)) next = padSegment(segments, next);
  }
  return next;
}

const capacity = (segments: Segment[]): number =>
  segments.reduce((total, segment) => total + segment.width, 0);

// Split a stream into its segments, dropping any trailing empty ones.
function split(segments: Segment[], digits: string): string[] {
  const parts: string[] = [];
  let rest = digits;
  for (const segment of segments) {
    if (rest.length === 0) break;
    parts.push(rest.slice(0, segment.width));
    rest = rest.slice(segment.width);
  }
  return parts;
}

// Render a stream for display, with a trailing separator once a segment fills
// so the caret visibly moves on.
function join(segments: Segment[], digits: string, separator: string): string {
  const parts = split(segments, digits);
  if (parts.length === 0) return "";
  const complete =
    parts.length < segments.length &&
    parts[parts.length - 1].length === segments[parts.length - 1].width;
  return parts.join(separator) + (complete ? separator : "");
}

export function appendDateInput(
  digits: string,
  input: string,
  order: DateOrder,
): string {
  return appendAll(dateSegments(order), digits, input);
}

export function appendTimeInput(digits: string, input: string): string {
  return appendAll(TIME_SEGMENTS, digits, input);
}

export function formatDateDigits(
  digits: string,
  order: DateOrder,
  separator: string,
): string {
  return join(dateSegments(order), digits, separator);
}

export function formatTimeDigits(digits: string): string {
  return join(TIME_SEGMENTS, digits, ":");
}

export const dateDigitCapacity = (order: DateOrder): number =>
  capacity(dateSegments(order));
export const timeDigitCapacity = (): number => capacity(TIME_SEGMENTS);

// The year a bare day and month must have meant: the next time that date comes
// round, starting today. Typing 05.01 in December means next January, never a
// date that has already gone by. The search runs a few years out so that 29.02
// lands on a leap year.
export function inferYear(day: number, month: number, today: Date): number {
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  for (
    let year = today.getFullYear();
    year <= today.getFullYear() + 4;
    year++
  ) {
    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getMonth() + 1 === month &&
      candidate.getDate() === day &&
      candidate.getTime() >= start
    )
      return year;
  }
  return today.getFullYear();
}

// Complete a partly typed segment on blur. A single leading digit can only have
// meant itself zero-padded, and 0 alone is not a real day or month.
function padLeft(
  part: string | undefined,
  segment: Segment,
): number | undefined {
  if (part === undefined || part.length === 0) return undefined;
  const value = Number(part);
  if (part.length < segment.width && value < segment.min) return undefined;
  return value;
}

// Resolve a date stream to "YYYY-MM-DD", or undefined while it is still too
// incomplete to mean anything. A two-digit year is read as this century.
export function dateDigitsToIso(
  digits: string,
  order: DateOrder,
  today: Date,
): string | undefined {
  const segments = dateSegments(order);
  const parts = split(segments, digits);
  const index = (segment: Segment): string | undefined =>
    parts[segments.indexOf(segment)];

  const day = padLeft(index(DAY), DAY);
  const month = padLeft(index(MONTH), MONTH);
  if (day === undefined || month === undefined) return undefined;

  const rawYear = index(YEAR);
  let year: number;
  if (rawYear === undefined || rawYear.length === 0) {
    year = inferYear(day, month, today);
  } else if (rawYear.length === 2) {
    year = 2000 + Number(rawYear);
  } else if (rawYear.length === 4) {
    year = Number(rawYear);
  } else {
    return undefined; // one or three digits is a half-typed year
  }

  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Reject dates the calendar does not have, e.g. 31.02.
  return parseStart(iso, "00:00") === undefined ? undefined : iso;
}

// Resolve a time stream to "HH:MM". A lone trailing minute digit pads to the
// right, so 9:3 becomes 09:30 rather than 09:03 — clinic times cluster on the
// quarter hour, and the normalised value is shown back for correction.
export function timeDigitsToCanonical(digits: string): string | undefined {
  if (digits.length === 0) return undefined;
  const [rawHour, rawMinute] = split(TIME_SEGMENTS, digits);
  const hour = Number(rawHour);
  if (hour > HOUR.max) return undefined;
  const minute =
    rawMinute === undefined || rawMinute.length === 0
      ? 0
      : Number(rawMinute.padEnd(2, "0"));
  if (minute > MINUTE.max) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Seed a date stream from the "YYYY-MM-DD" the rest of the app exchanges.
export function isoToDateDigits(iso: string, order: DateOrder): string {
  const match = ISO_LIKE.exec(iso.trim());
  if (!match) return "";
  const [, year, month, day] = match;
  const parts: Record<string, string> = { d: day, m: month, y: year };
  return order
    .split("")
    .map((key) => parts[key])
    .join("");
}

export function canonicalTimeToDigits(time: string): string {
  return /^\d{2}:\d{2}$/.test(time.trim()) ? time.replace(":", "") : "";
}

const PASTE_DATE = /^(\d{1,4})[./\-\s](\d{1,2})[./\-\s](\d{2}|\d{4})$/;
const PASTE_TIME = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i;

// Read a pasted date. An ISO string is reordered to the configured order; a
// separated date is read in that order; anything else falls back to its digits,
// so 21082026 works.
export function parsePastedDate(text: string, order: DateOrder): string {
  const trimmed = text.trim();
  const iso = ISO_LIKE.exec(trimmed);
  if (iso) return isoToDateDigits(trimmed, order);

  const separated = PASTE_DATE.exec(trimmed);
  if (separated) {
    const [, first, second, third] = separated;
    const pad = (part: string): string => part.padStart(2, "0");
    if (order === "ymd") return part4(first) + pad(second) + pad(third);
    return pad(first) + pad(second) + part4(third);
  }

  return appendDateInput("", trimmed, order);
}

// A pasted year may be written short; read two digits as this century.
function part4(year: string): string {
  return year.length === 2 ? `20${year}` : year.padStart(4, "0");
}

// Read a pasted time, including the 12-hour form that turns up in email.
export function parsePastedTime(text: string): string {
  const trimmed = text.trim();
  const meridiem = PASTE_TIME.exec(trimmed);
  if (meridiem) {
    const [, rawHour, minute, half] = meridiem;
    let hour = Number(rawHour) % 12;
    if (half.toLowerCase() === "p") hour += 12;
    return String(hour).padStart(2, "0") + minute;
  }
  return appendTimeInput("", trimmed);
}
