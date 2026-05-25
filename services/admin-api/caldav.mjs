// CalDAV client for writing meeting events to the shared SOGo calendar.
//
// admin-api PUTs a single .ics resource per booking; SOGo turns that into the
// outbound iMIP invite/cancel email. Calendar writes are best-effort: the
// caller logs failures (booking_id only) and never fails room creation on
// account of CalDAV.
//
// Reads config from the environment by name:
//   CALDAV_URL_BASE  e.g. https://<MAIL_HOST>/SOGo/dav/<user>/Calendar/personal
//   CALDAV_USER      shared scheduling mailbox (Basic auth user)
//   CALDAV_PASSWORD  app password (never logged)
//
// The Authorization header and password are never logged.

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

// True when CalDAV is configured. When false, callers should skip calendar
// writes entirely (a clinic without SOGo still gets working rooms).
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
