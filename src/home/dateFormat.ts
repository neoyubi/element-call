// Shared date helpers for the scheduling forms. Both the create form and the
// inline reschedule editor use the same "dd.mm.YYYY" convention; keeping the
// parsing and formatting in one module stops the two from drifting apart.

// Date entered as "dd.mm.YYYY".
const DATE_REGEX = /^(\d{2})\.(\d{2})\.(\d{4})$/;

// Parse "dd.mm.YYYY" + "HH:MM" into an epoch-ms instant in local time.
// Returns undefined when the input is malformed or not a real calendar date
// (e.g. "40.13.2026" or a day that rolled over into the next month).
export function parseStart(
  dateStr: string,
  timeStr: string,
): number | undefined {
  const match = DATE_REGEX.exec(dateStr.trim());
  if (!match || !timeStr) return undefined;
  const [, dd, mm, yyyy] = match;
  const ms = new Date(`${yyyy}-${mm}-${dd}T${timeStr}`).getTime();
  if (Number.isNaN(ms)) return undefined;
  const parsed = new Date(ms);
  if (parsed.getMonth() + 1 !== Number(mm) || parsed.getDate() !== Number(dd))
    return undefined;
  return ms;
}

// Format an epoch-ms instant as "dd.mm.YYYY" in local time (the inverse of
// parseStart's date part).
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Format an epoch-ms instant as "HH:MM" in local time, suitable for
// prefilling an <input type="time">.
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${min}`;
}
