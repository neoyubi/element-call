// iCalendar (RFC 5545) generation for meeting invitations.
//
// Dependency-free: produces a complete VCALENDAR string for a single VEVENT,
// suitable for PUTting to a CalDAV collection. SOGo then dispatches the iMIP
// REQUEST/CANCEL emails to the attendees.
//
// All caller-supplied text is sanitized: raw CR/LF are stripped (header
// injection guard) and the RFC 5545 special characters (backslash, semicolon,
// comma, newline) are escaped. Property lines are folded at 75 octets.

// Product identifier for the calendar object. Derived from the deployment's
// SERVER_NAME so no tenant identity is baked into the source; falls back to a
// neutral default when unset.
const PRODID = `-//${process.env.SERVER_NAME || "Element Call"}//Element Call//EN`;

// Strip raw CR/LF (no untrusted line breaks may reach a property line) and
// escape the RFC 5545 TEXT specials. Order matters: escape backslash first.
function escapeText(value) {
  return String(value ?? "")
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// Remove any CR/LF from a value used outside a TEXT context (UID, URL, CN,
// mailto, TZID). These must never contain a line break.
function sanitizeRaw(value) {
  return String(value ?? "").replace(/[\r\n]/g, "");
}

// Fold a single content line to <= 75 octets per RFC 5545 §3.1, continuing
// with a CRLF + single space. Folding is octet-based (UTF-8), so we operate
// on bytes and never split a multi-byte sequence.
function foldLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) {
    return line;
  }
  const pieces = [];
  let start = 0;
  // First line: up to 75 octets. Continuations: up to 74 (the leading space
  // counts toward the 75-octet limit of the continuation line).
  let limit = 75;
  while (start < bytes.length) {
    let endByte = Math.min(start + limit, bytes.length);
    // Do not split a UTF-8 continuation byte (0b10xxxxxx) from its leader.
    while (endByte < bytes.length && (bytes[endByte] & 0xc0) === 0x80) {
      endByte--;
    }
    pieces.push(bytes.subarray(start, endByte).toString("utf8"));
    start = endByte;
    limit = 74;
  }
  return pieces.join("\r\n ");
}

// Format a unix-ms instant as an iCal date-time. With a tzid we emit local
// "floating" time (the TZID parameter on the property gives the zone); without
// one we emit UTC (trailing Z).
function formatDateTime(ms, tzid) {
  const d = new Date(ms);
  if (tzid) {
    // Render the wall-clock time in the target zone via Intl, then assemble.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tzid,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
    let hour = get("hour");
    // Intl may render midnight as "24"; normalize to "00".
    if (hour === "24") hour = "00";
    return `${get("year")}${get("month")}${get("day")}T${hour}${get("minute")}${get("second")}`;
  }
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return iso;
}

function dtstamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// buildVEvent({
//   uid, sequence, method, startMs, endMs, summary, description,
//   location, organizerEmail, attendeeEmails, tzid
// }) -> VCALENDAR string (CRLF line endings).
//
// method: "REQUEST" creates/updates (STATUS:CONFIRMED);
//         "CANCEL" cancels (STATUS:CANCELLED).
export function buildVEvent({
  uid,
  sequence = 0,
  method = "REQUEST",
  startMs,
  endMs,
  summary,
  description,
  location,
  organizerEmail,
  attendeeEmails = [],
  tzid,
}) {
  const isCancel = method === "CANCEL";
  const cleanUid = sanitizeRaw(uid);
  const cleanTzid = tzid ? sanitizeRaw(tzid) : null;
  const tzParam = cleanTzid ? `;TZID=${cleanTzid}` : "";

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push(`PRODID:${PRODID}`);
  lines.push("VERSION:2.0");
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`METHOD:${isCancel ? "CANCEL" : "REQUEST"}`);
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${cleanUid}`);
  lines.push(`SEQUENCE:${Number.isInteger(sequence) ? sequence : 0}`);
  lines.push(`DTSTAMP:${dtstamp()}`);
  lines.push(`DTSTART${tzParam}:${formatDateTime(startMs, cleanTzid)}`);
  lines.push(`DTEND${tzParam}:${formatDateTime(endMs, cleanTzid)}`);
  lines.push(`SUMMARY:${escapeText(summary)}`);
  if (description) {
    lines.push(`DESCRIPTION:${escapeText(description)}`);
  }
  if (location) {
    lines.push(`LOCATION:${escapeText(location)}`);
    lines.push(`URL:${sanitizeRaw(location)}`);
  }

  if (organizerEmail) {
    lines.push(`ORGANIZER;CN=${escapeText(organizerEmail)}:mailto:${sanitizeRaw(organizerEmail)}`);
  }
  for (const email of attendeeEmails) {
    if (!email) continue;
    const clean = sanitizeRaw(email);
    lines.push(
      `ATTENDEE;CN=${escapeText(email)};RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${clean}`,
    );
  }

  lines.push(`STATUS:${isCancel ? "CANCELLED" : "CONFIRMED"}`);

  // A 10-minute display reminder. (Email alarms in SOGo notify the calendar
  // owner, not attendees, so attendee reminders are handled out of band.)
  if (!isCancel) {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push("TRIGGER:-PT10M");
    lines.push(`DESCRIPTION:${escapeText(summary)}`);
    lines.push("END:VALARM");
  }

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}
