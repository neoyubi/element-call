// iCalendar (RFC 5545) generation for meeting invitations.
//
// Dependency-free: produces a complete VCALENDAR string for a single VEVENT,
// suitable for PUTting to a CalDAV collection. A scheduling-aware CalDAV
// server derives the iTIP message from the operation itself — a PUT carrying
// ATTENDEE properties is a REQUEST, a DELETE is a CANCEL — and dispatches the
// mail, which is why no METHOD property appears below: RFC 4791 §4.1 forbids
// one in a stored calendar object, and servers that enforce it reject the
// whole resource.
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
// mailto). These must never contain a line break.
function sanitizeRaw(value) {
  return String(value ?? "").replace(/[\r\n]/g, "");
}

// Render a property parameter value. RFC 5545 §3.1.1 requires a quoted-string
// when the value contains ':', ';' or ',', and defines no escaping mechanism
// for parameter values at all — so the TEXT escapes must not be used here, and
// a DQUOTE, which has no representation inside a quoted-string, is dropped.
function paramValue(value) {
  const clean = sanitizeRaw(value).replace(/"/g, "");
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

// ORGANIZER / ATTENDEE line for one calendar user. CN is a display name, so it
// is left out when no name is known rather than filled with the address, which
// is what a client falls back to showing anyway.
function calendarUser(property, { email, name }, parameters = "") {
  const cn = name ? `;CN=${paramValue(name)}` : "";
  return `${property}${cn}${parameters}:mailto:${sanitizeRaw(email)}`;
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

// Format a unix-ms instant as an iCalendar UTC date-time (RFC 5545 §3.3.5).
// Every time this module writes is an absolute instant, so a TZID parameter
// would carry nothing the UTC form does not — while RFC 4791 §4.1 requires a
// matching VTIMEZONE component for each TZID used, and clients that enforce
// that reject or silently shift an event without one.
function formatUtc(ms) {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// buildVEvent({
//   uid, sequence, startMs, endMs, summary, description,
//   location, organizer, attendees
// }) -> VCALENDAR string (CRLF line endings).
export function buildVEvent({
  uid,
  sequence = 0,
  startMs,
  endMs,
  summary,
  description,
  location,
  organizer,
  attendees = [],
}) {
  const cleanUid = sanitizeRaw(uid);

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push(`PRODID:${PRODID}`);
  lines.push("VERSION:2.0");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${cleanUid}`);
  lines.push(`SEQUENCE:${Number.isInteger(sequence) ? sequence : 0}`);
  lines.push(`DTSTAMP:${formatUtc(Date.now())}`);
  lines.push(`DTSTART:${formatUtc(startMs)}`);
  lines.push(`DTEND:${formatUtc(endMs)}`);
  lines.push(`SUMMARY:${escapeText(summary)}`);
  if (description) {
    lines.push(`DESCRIPTION:${escapeText(description)}`);
  }
  if (location) {
    lines.push(`LOCATION:${escapeText(location)}`);
    lines.push(`URL:${sanitizeRaw(location)}`);
  }

  if (organizer?.email) {
    lines.push(calendarUser("ORGANIZER", organizer));
  }
  for (const attendee of attendees) {
    if (!attendee?.email) continue;
    lines.push(
      calendarUser(
        "ATTENDEE",
        attendee,
        ";RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION",
      ),
    );
  }

  lines.push("STATUS:CONFIRMED");

  // A 10-minute display reminder. (An alarm on the organizer's copy notifies
  // the calendar owner, not the attendees, so attendee reminders are handled
  // out of band by the mail worker.)
  lines.push("BEGIN:VALARM");
  lines.push("ACTION:DISPLAY");
  lines.push("TRIGGER:-PT10M");
  lines.push(`DESCRIPTION:${escapeText(summary)}`);
  lines.push("END:VALARM");

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}
