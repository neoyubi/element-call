// CalDAV client for writing meeting events to a shared calendar collection.
//
// admin-api PUTs one .ics resource per booking. On a server implementing RFC
// 6638 scheduling, that PUT is what produces the invitation: the server
// derives the iTIP message from the operation itself and delivers it — into a
// local attendee's own calendar where it can, and by mail where it cannot.
// Calendar writes are best-effort: the caller logs failures (booking_id only)
// and never fails a room operation on account of the calendar.
//
// Reads config from the environment by name:
//   CALDAV_URL_BASE  the collection URL, e.g.
//                    https://caldav.example.com/dav/calendar@example.com/Calendar/personal
//   CALDAV_USER      the account that owns the collection (Basic auth user)
//   CALDAV_PASSWORD  its password (never logged)
//
// The Authorization header and password are never logged.

// Matches the convention used for the other outbound calls in this service:
// five seconds for authentication, eight for the calendar. Not configurable —
// a calendar write is best-effort, so a longer wait buys nothing but a slower
// room operation.
const CALDAV_TIMEOUT_MS = 8000;

export class CalDavError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "CalDavError";
    this.status = status;
  }
}

function config() {
  const base = process.env.CALDAV_URL_BASE;
  const user = process.env.CALDAV_USER;
  const password = process.env.CALDAV_PASSWORD;
  return { base, user, password };
}

// True when CalDAV is configured. When false, callers skip calendar writes
// entirely: a deployment with no calendar server still gets working rooms.
export function isConfigured() {
  const { base, user, password } = config();
  return Boolean(base && user && password);
}

function authHeader(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function resourceUrl(base, uid) {
  // uid is server-controlled (booking-<id>@<server>) but encode defensively.
  return `${base.replace(/\/$/, "")}/${encodeURIComponent(uid)}.ics`;
}

async function caldavFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALDAV_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// putEvent({ uid, ics }) -> void. Throws CalDavError on a non-2xx response or
// a network/timeout failure. Success: 200/201/204.
export async function putEvent({ uid, ics }) {
  const { base, user, password } = config();
  if (!base || !user || !password) {
    throw new CalDavError("CalDAV is not configured", 0);
  }

  let resp;
  try {
    resp = await caldavFetch(resourceUrl(base, uid), {
      method: "PUT",
      headers: {
        Authorization: authHeader(user, password),
        "Content-Type": "text/calendar; charset=utf-8",
      },
      body: ics,
    });
  } catch (err) {
    throw new CalDavError(
      err.name === "AbortError" ? "CalDAV request timed out" : "CalDAV request failed",
      0,
    );
  }

  if (resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
    throw new CalDavError(`CalDAV PUT returned ${resp.status}`, resp.status);
  }
}

// deleteEvent({ uid }) -> void. A 404 is treated as success (already gone).
// Throws CalDavError on other non-2xx responses or network/timeout failure.
export async function deleteEvent({ uid }) {
  const { base, user, password } = config();
  if (!base || !user || !password) {
    throw new CalDavError("CalDAV is not configured", 0);
  }

  let resp;
  try {
    resp = await caldavFetch(resourceUrl(base, uid), {
      method: "DELETE",
      headers: { Authorization: authHeader(user, password) },
    });
  } catch (err) {
    throw new CalDavError(
      err.name === "AbortError" ? "CalDAV request timed out" : "CalDAV request failed",
      0,
    );
  }

  if (resp.status === 404) {
    return;
  }
  if (resp.status !== 200 && resp.status !== 204) {
    throw new CalDavError(`CalDAV DELETE returned ${resp.status}`, resp.status);
  }
}

// One-shot startup probe. RFC 6638 requires a scheduling-aware server to
// advertise "calendar-auto-schedule" among the compliance classes in its DAV
// response header, and that capability is what puts a meeting straight into
// the calendar of an attendee who has an account on the same server. Logging
// it once turns an assumption into something an operator can read: without it,
// attendees depend entirely on emailed invitations and on whatever their own
// client chooses to do with one.
export async function probeScheduling() {
  if (!isConfigured()) {
    console.log("Calendar: not configured, calendar writes are disabled");
    return;
  }

  const { base, user, password } = config();
  let resp;
  try {
    resp = await caldavFetch(base, {
      method: "OPTIONS",
      headers: { Authorization: authHeader(user, password) },
    });
  } catch {
    console.warn("Calendar: could not reach the server to check its features");
    return;
  }

  if (resp.status >= 400) {
    console.warn(`Calendar: feature check rejected (status ${resp.status})`);
    return;
  }

  const advertised = (resp.headers.get("dav") ?? "")
    .split(",")
    .map((token) => token.trim());
  console.log(
    advertised.includes("calendar-auto-schedule")
      ? "Calendar: server schedules automatically, attendees with an account on it get the meeting in their own calendar"
      : "Calendar: server does not schedule automatically, attendees depend on emailed invitations",
  );
}
