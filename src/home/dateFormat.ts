// Parsing and formatting for the scheduling form's own inputs.
//
// A date input exchanges "YYYY-MM-DD" and a time input "HH:MM" whatever order
// the browser presents the fields in, so nothing here assumes a written date
// format. Anything a person reads is formatted in ../calendar/dates.

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
