import { createServer } from "node:http";
import { createHmac, randomBytes, pbkdf2 } from "node:crypto";

import { authorizeRequest } from "./auth.mjs";
import { buildVEvent } from "./ics.mjs";
import { putEvent, deleteEvent, isConfigured as caldavConfigured } from "./caldav.mjs";

// --- Configuration ---
const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://localhost:8008";
const BOT_ACCESS_TOKEN = process.env.BOT_ACCESS_TOKEN;
const SERVER_NAME = process.env.SERVER_NAME;
const ELEMENT_CALL_BASE_URL = process.env.ELEMENT_CALL_BASE_URL;
const API_KEY = process.env.ADMIN_API_KEY;
const PORT = parseInt(process.env.PORT || "6091", 10);
const REGISTRATION_SHARED_SECRET = process.env.REGISTRATION_SHARED_SECRET;

// Room whose joined members are allowed to schedule meetings with their own
// Matrix access token (the browser auth path). When unset, only the static
// service key is accepted.
const SCHEDULERS_ROOM_ID = process.env.SCHEDULERS_ROOM_ID;

// Comma-separated list of allowed origins (for CORS and request validation)
// e.g. "https://example.com,https://staging.example.com"
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];

const MEETING_STATE_TYPE =
  process.env.MEETING_STATE_TYPE || "io.element.call.scheduled_meeting";
const BOT_USER_PREFIX = process.env.BOT_USER_PREFIX || "call-bot";

// The calendar ORGANIZER is the shared scheduling identity that owns the
// collection, and implicit scheduling depends on it matching that account: a
// server resolves it against the collection owner's addresses and does nothing
// when it does not match. It coincides with the CalDAV login on some
// deployments and not on others, since a login may be a bare username, which
// is not a usable mailto value — so it is configured in its own right and
// falls back to the login only when that login is itself an address.
const CALDAV_ORGANIZER_EMAIL =
  process.env.CALDAV_ORGANIZER_EMAIL ||
  (process.env.CALDAV_USER?.includes("@")
    ? process.env.CALDAV_USER
    : undefined);

// Display name shown beside the organizer address. Unset omits the parameter.
const CALDAV_ORGANIZER_NAME = process.env.CALDAV_ORGANIZER_NAME;

// What a calendar shows for a meeting. The summary becomes the event title and
// the subject line of every invitation mail, so it surfaces in notification
// previews on every device the collection reaches: the default says nothing
// about who is meeting whom, and a deployment opts in to more. The description
// is the body text clients render, which is where a join link belongs.
//
// Placeholders: {{prospect_name}}, {{organizer_name}}, {{meet_link}}.
const MEETING_SUMMARY_TEMPLATE =
  process.env.MEETING_SUMMARY_TEMPLATE || "Appointment";
const MEETING_DESCRIPTION_TEMPLATE =
  process.env.MEETING_DESCRIPTION_TEMPLATE || "Join: {{meet_link}}";

// Substitute {{placeholder}} values. An unknown placeholder renders empty, so
// a template is never shown to a reader with its own markup in it.
function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "").trim();
}

// Default reminder lead time (minutes) when a request omits reminder_minutes.
// 0 disables the reminder email.
const REMINDER_DEFAULT_MINUTES = parseInt(
  process.env.REMINDER_DEFAULT_MINUTES || "30",
  10,
);

// Stable iCalendar UID for a booking. Domain comes from SERVER_NAME so no
// deployment hostname is baked into the source.
//
// The composition itself is deliberately not configurable: the UID is the
// identity of the event in every calendar it reaches, so changing it would
// orphan every resource already written. meeting-worker derives the same value
// independently for the retention purge.
export function bookingUid(bookingId) {
  return `booking-${bookingId}@${SERVER_NAME}`;
}

// Normalize reminder_minutes from a request body: integer >= 0, defaulting to
// REMINDER_DEFAULT_MINUTES when absent. 0 means no reminder.
export function normalizeReminderMinutes(value) {
  if (value === undefined || value === null) {
    return REMINDER_DEFAULT_MINUTES;
  }
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    return REMINDER_DEFAULT_MINUTES;
  }
  return n;
}

// Environment slice handed to the authorization engine.
const AUTH_ENV = {
  apiKey: API_KEY,
  synapseUrl: SYNAPSE_URL,
  botAccessToken: BOT_ACCESS_TOKEN,
  schedulersRoomId: SCHEDULERS_ROOM_ID,
};

// Rate limiting
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "30", 10);

// --- Validation ---
if (!BOT_ACCESS_TOKEN) {
  console.error("BOT_ACCESS_TOKEN is required");
  process.exit(1);
}
if (!SERVER_NAME) {
  console.error("SERVER_NAME is required");
  process.exit(1);
}
if (!ELEMENT_CALL_BASE_URL) {
  console.error("ELEMENT_CALL_BASE_URL is required");
  process.exit(1);
}
if (!API_KEY) {
  console.error("ADMIN_API_KEY is required");
  process.exit(1);
}

// --- E2EE Shared Key ---
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PBKDF2_ITERATIONS = 600_000;
const DERIVED_KEY_BITS = 256;

function generateKeyMaterial(length = 4) {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
  }
  return result;
}

function deriveSharedKey(keyMaterial, roomAlias) {
  return new Promise((resolve, reject) => {
    pbkdf2(
      keyMaterial,
      roomAlias,
      PBKDF2_ITERATIONS,
      DERIVED_KEY_BITS / 8,
      "sha256",
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(
          derivedKey
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, ""),
        );
      },
    );
  });
}

// --- Rate Limiter ---
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Housekeeping only, so it must not be a reason for the process to stay alive.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// --- Helpers ---
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress
  );
}

function getCorsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(res, status, body, origin) {
  const cors = getCorsHeaders(origin);
  res.writeHead(status, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

async function synapseRequest(path, options = {}) {
  const url = `${SYNAPSE_URL}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOT_ACCESS_TOKEN}`,
      ...options.headers,
    },
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

// --- Calendar (best-effort) ---
//
// Write or remove the calendar event for a meeting. Failures are logged
// (booking_id only) and swallowed: the calendar is best-effort and never fails
// the room operation. No-ops when CalDAV is not configured.
async function writeCalendarEvent({
  bookingId,
  sequence,
  startMs,
  endMs,
  meetLink,
  organizerName,
  prospectName,
  organizerEmail,
  prospectEmail,
}) {
  if (!caldavConfigured()) {
    return;
  }
  const attendees = [
    { email: organizerEmail, name: organizerName },
    { email: prospectEmail, name: prospectName },
  ].filter((attendee) => attendee.email);
  const values = {
    organizer_name: organizerName,
    prospect_name: prospectName,
    meet_link: meetLink,
  };
  const uid = bookingUid(bookingId);
  try {
    const ics = buildVEvent({
      uid,
      sequence,
      startMs,
      endMs,
      summary: renderTemplate(MEETING_SUMMARY_TEMPLATE, values),
      description: renderTemplate(MEETING_DESCRIPTION_TEMPLATE, values),
      location: meetLink,
      organizer: {
        email: CALDAV_ORGANIZER_EMAIL,
        name: CALDAV_ORGANIZER_NAME,
      },
      attendees,
    });
    await putEvent({ uid, ics });
  } catch (err) {
    console.warn(
      `Calendar write failed for booking ${bookingId}: ${err.message}`,
    );
  }
}

// Remove the calendar resource for a cancelled meeting. Deleting is the whole
// cancellation: RFC 6638 §3.2.1.3 makes an organizer DELETE the operation that
// inspects each ATTENDEE and sends the iTIP CANCEL. Writing a cancellation
// revision first would put a second, contradictory "updated invitation" in
// front of it. A 404 is treated as already-gone.
async function cancelCalendarEvent(bookingId) {
  if (!caldavConfigured()) {
    return;
  }
  try {
    await deleteEvent({ uid: bookingUid(bookingId) });
  } catch (err) {
    console.warn(
      `Calendar cancel failed for booking ${bookingId}: ${err.message}`,
    );
  }
}

// Read the current meeting state event content for a room, or null if absent.
async function readMeetingState(roomId) {
  const result = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
  );
  if (result.status !== 200) {
    return null;
  }
  return result.data;
}

// --- Room Management ---

export async function createMeetingRoom(body) {
  const {
    booking_id,
    room_name,
    scheduled_start,
    scheduled_end,
    organizer_name,
    prospect_name,
    practice_type,
    timezone,
    organizer_user_id,
    organizer_email,
    prospect_email,
    reminder_minutes,
  } = body;

  if (!booking_id || !room_name || !scheduled_start || !scheduled_end) {
    return {
      status: 400,
      body: {
        error: "Missing required fields: booking_id, room_name, scheduled_start, scheduled_end",
      },
    };
  }

  const tz = timezone || "Europe/Amsterdam";
  const reminderMinutes = normalizeReminderMinutes(reminder_minutes);

  const aliasLocalpart = `demo-${booking_id}`;
  const roomAlias = `#${aliasLocalpart}:${SERVER_NAME}`;

  // Generate E2EE key material before room creation so it's in the initial state
  const keyMaterial = generateKeyMaterial();

  // Compute the join link up front so it can be persisted in room state (the
  // reminder worker reads meet_link rather than re-deriving it).
  const password = await deriveSharedKey(keyMaterial, roomAlias);

  const result = await synapseRequest("/_matrix/client/v3/createRoom", {
    method: "POST",
    body: JSON.stringify({
      room_alias_name: aliasLocalpart,
      name: room_name,
      visibility: "private",
      preset: "public_chat",
      initial_state: [
        {
          type: "m.room.join_rules",
          state_key: "",
          content: { join_rule: "knock" },
        },
        {
          type: MEETING_STATE_TYPE,
          state_key: "",
          content: {
            booking_id,
            scheduled_start,
            scheduled_end,
            organizer_name: organizer_name || "",
            prospect_name: prospect_name || "",
            organizer_email: organizer_email || "",
            prospect_email: prospect_email || "",
            practice_type: practice_type || "solo",
            timezone: tz,
            sequence: 0,
            reminder_minutes: reminderMinutes,
            key_material: keyMaterial,
          },
        },
      ],
      power_level_content_override: {
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 50,
        state_default: 0,
        events_default: 0,
        users_default: 0,
        events: {
          "m.room.power_levels": 100,
          "m.room.history_visibility": 100,
          "m.room.tombstone": 100,
          "m.room.encryption": 100,
          "m.room.join_rules": 100,
          "m.room.name": 50,
          "m.room.message": 0,
          "m.room.encrypted": 50,
          "m.sticker": 50,
          "org.matrix.msc3401.call.member": 0,
        },
        users: {
          [`@${BOT_USER_PREFIX}:${SERVER_NAME}`]: 100,
          ...(organizer_user_id ? { [organizer_user_id]: 100 } : {}),
        },
      },
    }),
  });

  if (result.status !== 200) {
    console.error("Room creation failed:", result.data);
    return {
      status: result.status === 400 ? 400 : 502,
      body: {
        error: result.data.error || "Room creation failed",
        errcode: result.data.errcode,
      },
    };
  }

  const roomId = result.data.room_id;

  const meetLink = `${ELEMENT_CALL_BASE_URL}/${aliasLocalpart}?meetingStart=${scheduled_start}&roomId=${encodeURIComponent(roomId)}&password=${password}`;
  const organizerLink = `${meetLink}&organizer=1`;

  // Persist meet_link in the meeting state event. It depends on the room id,
  // which is only known after creation, so it is added with a follow-up PUT
  // (the reminder worker reads it instead of re-deriving the join link).
  const persistResult = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
    {
      method: "PUT",
      body: JSON.stringify({
        booking_id,
        scheduled_start,
        scheduled_end,
        organizer_name: organizer_name || "",
        prospect_name: prospect_name || "",
        organizer_email: organizer_email || "",
        prospect_email: prospect_email || "",
        practice_type: practice_type || "solo",
        timezone: tz,
        sequence: 0,
        reminder_minutes: reminderMinutes,
        meet_link: meetLink,
        key_material: keyMaterial,
      }),
    },
  );
  if (persistResult.status !== 200) {
    console.warn(`Failed to persist meet_link for booking ${booking_id}`);
  }

  // Force-join the organizer via Synapse admin API so the room appears
  // in their sync immediately (invite alone won't populate state events)
  if (organizer_user_id) {
    const joinResult = await synapseRequest(
      `/_synapse/admin/v1/join/${encodeURIComponent(roomId)}`,
      {
        method: "POST",
        body: JSON.stringify({ user_id: organizer_user_id }),
      },
    );
    if (joinResult.status === 200) {
      console.log(`Joined organizer to room ${roomId}`);
    } else {
      console.warn(`Failed to join organizer to room ${roomId}`);
    }
  }

  // Write the calendar invite (best-effort; never fails room creation).
  await writeCalendarEvent({
    bookingId: booking_id,
    sequence: 0,
    startMs: scheduled_start,
    endMs: scheduled_end,
    meetLink,
    organizerName: organizer_name,
    prospectName: prospect_name,
    organizerEmail: organizer_email,
    prospectEmail: prospect_email,
  });

  console.log(`Created room ${roomId} (${roomAlias}) for booking ${booking_id}`);

  return {
    status: 201,
    body: {
      room_id: roomId,
      room_alias: roomAlias,
      meet_link: meetLink,
      organizer_link: organizerLink,
      booking_id,
      key_material: keyMaterial,
    },
  };
}

export async function updateMeetingRoom(roomId, body) {
  const {
    booking_id,
    scheduled_start,
    scheduled_end,
    organizer_name,
    prospect_name,
    practice_type,
    timezone,
    room_name,
    organizer_email,
    prospect_email,
    reminder_minutes,
  } = body;

  // Read the current meeting state so fields not in the request (notably
  // key_material, which must survive a reschedule) are preserved.
  const current = (await readMeetingState(roomId)) || {};

  // Merge: request value wins when present, otherwise keep the stored value.
  const merge = (incoming, key, fallback = "") =>
    incoming !== undefined ? incoming : current[key] ?? fallback;

  const newStart = scheduled_start !== undefined ? scheduled_start : current.scheduled_start;
  const newEnd = scheduled_end !== undefined ? scheduled_end : current.scheduled_end;
  const startChanged =
    scheduled_start !== undefined && scheduled_start !== current.scheduled_start;

  // SEQUENCE bumps on every revision; a missing prior value is treated as 0.
  const sequence = (Number.isInteger(current.sequence) ? current.sequence : 0) + 1;

  const reminderMinutes =
    reminder_minutes !== undefined
      ? normalizeReminderMinutes(reminder_minutes)
      : Number.isInteger(current.reminder_minutes)
        ? current.reminder_minutes
        : REMINDER_DEFAULT_MINUTES;

  const tz = merge(timezone, "timezone", "Europe/Amsterdam");
  const organizerEmail = merge(organizer_email, "organizer_email");
  const prospectEmail = merge(prospect_email, "prospect_email");

  // The join link embeds the start time as a lobby-countdown query param, so
  // it goes stale when the meeting moves. Refresh only that param: the path
  // and password derive from the alias and key_material (both unchanged), so
  // previously emailed links keep working.
  let meetLink = current.meet_link || "";
  if (startChanged && meetLink) {
    try {
      const linkUrl = new URL(meetLink);
      linkUrl.searchParams.set("meetingStart", String(newStart));
      meetLink = linkUrl.toString();
    } catch {
      // Unparseable stored link: carry it through unchanged.
    }
  }

  const newState = {
    booking_id: merge(booking_id, "booking_id"),
    scheduled_start: newStart,
    scheduled_end: newEnd,
    organizer_name: merge(organizer_name, "organizer_name"),
    prospect_name: merge(prospect_name, "prospect_name"),
    organizer_email: organizerEmail,
    prospect_email: prospectEmail,
    practice_type: merge(practice_type, "practice_type", "solo"),
    timezone: tz,
    sequence,
    reminder_minutes: reminderMinutes,
    // Preserve the E2EE key; dropping it would break existing join links.
    key_material: current.key_material,
  };
  if (meetLink) {
    newState.meet_link = meetLink;
  }
  // Carry reminder_sent forward, but clear it when the start time moved so the
  // worker re-arms and re-sends the reminder for the new time.
  if (current.reminder_sent !== undefined && !startChanged) {
    newState.reminder_sent = current.reminder_sent;
  }
  // Reschedule notice for the worker: when the start moved, record the
  // previous start and clear the notified flag so the worker emails the
  // attendees about the new time. On other updates both fields are carried
  // forward unchanged (mirroring the reminder_sent carry above).
  if (startChanged && Number.isFinite(Number(current.scheduled_start))) {
    newState.reschedule_previous_start = current.scheduled_start;
  } else if (!startChanged) {
    if (current.reschedule_previous_start !== undefined) {
      newState.reschedule_previous_start = current.reschedule_previous_start;
    }
    if (current.reschedule_notified !== undefined) {
      newState.reschedule_notified = current.reschedule_notified;
    }
  }

  // Update the meeting state event
  const stateResult = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
    {
      method: "PUT",
      body: JSON.stringify(newState),
    },
  );

  if (stateResult.status !== 200) {
    console.error("State update failed:", stateResult.data);
    return {
      status: stateResult.status === 403 ? 403 : 502,
      body: {
        error: stateResult.data.error || "State update failed",
        errcode: stateResult.data.errcode,
      },
    };
  }

  // Optionally update room name
  if (room_name) {
    await synapseRequest(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`,
      {
        method: "PUT",
        body: JSON.stringify({ name: room_name }),
      },
    );
  }

  // Push an updated calendar invite with the bumped SEQUENCE (best-effort).
  await writeCalendarEvent({
    bookingId: newState.booking_id,
    sequence,
    startMs: newStart,
    endMs: newEnd,
    meetLink,
    organizerName: newState.organizer_name,
    prospectName: newState.prospect_name,
    organizerEmail,
    prospectEmail,
  });

  console.log(`Updated room ${roomId} meeting metadata`);
  return { status: 200, body: { success: true, room_id: roomId } };
}

export async function deleteMeetingRoom(roomId) {
  // Read the meeting state first: once the room is purged the booking id is
  // gone, and it is what addresses the calendar resource.
  const current = await readMeetingState(roomId);
  if (current?.booking_id) {
    await cancelCalendarEvent(current.booking_id);
  }

  // Use Synapse admin API to purge the room entirely
  // This requires the bot token to have admin privileges,
  // OR we use the registration shared secret for admin auth
  const result = await synapseRequest(
    `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ purge: true }),
    },
  );

  if (result.status !== 200) {
    // If admin API fails (bot isn't server admin), try graceful leave
    if (result.status === 403) {
      console.warn(
        `Bot lacks admin privileges for room purge. Attempting graceful cleanup for ${roomId}`,
      );
      // Kick all members and leave
      const membersResult = await synapseRequest(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      );
      if (membersResult.status === 200 && membersResult.data.joined) {
        const botUserId = `@${BOT_USER_PREFIX}:${SERVER_NAME}`;
        for (const userId of Object.keys(membersResult.data.joined)) {
          if (userId !== botUserId) {
            await synapseRequest(
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`,
              {
                method: "POST",
                body: JSON.stringify({
                  user_id: userId,
                  reason: "Meeting cancelled",
                }),
              },
            );
          }
        }
      }
      // Close the room (set join rule to invite)
      await synapseRequest(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`,
        {
          method: "PUT",
          body: JSON.stringify({ join_rule: "invite" }),
        },
      );
      // Bot leaves
      await synapseRequest(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
        { method: "POST", body: JSON.stringify({}) },
      );

      console.log(`Gracefully cleaned up room ${roomId}`);
      return { status: 200, body: { success: true, room_id: roomId, method: "graceful" } };
    }

    console.error("Room deletion failed:", result.data);
    return {
      status: 502,
      body: {
        error: result.data.error || "Room deletion failed",
        errcode: result.data.errcode,
      },
    };
  }

  console.log(`Purged room ${roomId}`);
  return { status: 200, body: { success: true, room_id: roomId, method: "purge" } };
}

// --- Routing ---

function parseRoute(method, pathname) {
  // POST /api/admin/rooms
  if (method === "POST" && pathname === "/api/admin/rooms") {
    return { action: "create" };
  }
  // PUT /api/admin/rooms/:roomId
  const putMatch = pathname.match(/^\/api\/admin\/rooms\/(.+)$/);
  if (method === "PUT" && putMatch) {
    return { action: "update", roomId: decodeURIComponent(putMatch[1]) };
  }
  // DELETE /api/admin/rooms/:roomId
  const deleteMatch = pathname.match(/^\/api\/admin\/rooms\/(.+)$/);
  if (method === "DELETE" && deleteMatch) {
    return { action: "delete", roomId: decodeURIComponent(deleteMatch[1]) };
  }
  // GET /api/admin/rooms/:roomId
  const getMatch = pathname.match(/^\/api\/admin\/rooms\/(.+)$/);
  if (method === "GET" && getMatch) {
    return { action: "get", roomId: decodeURIComponent(getMatch[1]) };
  }
  return null;
}

async function getRoomInfo(roomId) {
  // Get room state to retrieve meeting metadata
  const stateResult = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
  );

  if (stateResult.status !== 200) {
    return {
      status: stateResult.status === 404 ? 404 : 502,
      body: {
        error: stateResult.data.error || "Failed to get room info",
        errcode: stateResult.data.errcode,
      },
    };
  }

  return {
    status: 200,
    body: {
      room_id: roomId,
      meeting: stateResult.data,
    },
  };
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const clientIp = getClientIp(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    const cors = getCorsHeaders(origin);
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // Health check (no auth required)
  if (
    (url.pathname === "/health" || url.pathname === "/api/admin/health") &&
    req.method === "GET"
  ) {
    json(res, 200, { status: "ok", service: "element-call-admin-api" }, origin);
    return;
  }

  // --- All /api/admin/* routes require auth ---
  const route = parseRoute(req.method, url.pathname);
  if (!route) {
    json(res, 404, { error: "Not found" }, origin);
    return;
  }

  // 1. Rate limit (before auth so a flood can't drive Synapse lookups)
  if (isRateLimited(clientIp)) {
    json(res, 429, { error: "Too many requests" }, origin);
    return;
  }

  // 2. Authorize: static service key, or a scheduler's Matrix access token
  // verified against #schedulers membership.
  const auth = await authorizeRequest(req, AUTH_ENV);
  if (!auth.ok) {
    console.warn(
      `Authorization failed (${auth.status}) from ${clientIp} to ${req.method} ${url.pathname}`,
    );
    json(res, auth.status, { error: auth.error }, origin);
    return;
  }

  // 3. Log the request
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${url.pathname} from ${clientIp} (${auth.scope})`,
  );

  try {
    let result;
    switch (route.action) {
      case "create": {
        const body = await readBody(req);
        if (!body) {
          json(res, 400, { error: "Invalid JSON body" }, origin);
          return;
        }
        result = await createMeetingRoom(body);
        break;
      }
      case "update": {
        const body = await readBody(req);
        if (!body) {
          json(res, 400, { error: "Invalid JSON body" }, origin);
          return;
        }
        result = await updateMeetingRoom(route.roomId, body);
        break;
      }
      case "delete":
        result = await deleteMeetingRoom(route.roomId);
        break;
      case "get":
        result = await getRoomInfo(route.roomId);
        break;
      default:
        json(res, 404, { error: "Not found" }, origin);
        return;
    }
    json(res, result.status, result.body, origin);
  } catch (err) {
    console.error(`Error handling ${route.action}:`, err);
    json(res, 500, { error: "Internal server error" }, origin);
  }
});

// Bind the port only when this file is the program being run, so the handlers
// above can be imported and exercised directly.
if (import.meta.main) {
  server.listen(PORT, () => {
    console.log(`Element Call Admin API listening on port ${PORT}`);
    console.log(`Synapse URL: ${SYNAPSE_URL}`);
    console.log(`Server name: ${SERVER_NAME}`);
    console.log(`Element Call base URL: ${ELEMENT_CALL_BASE_URL}`);
    console.log(
      `Allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "none (CORS disabled)"}`,
    );
    console.log(
      `Scheduler auth: ${SCHEDULERS_ROOM_ID ? "enabled" : "disabled (service key only)"}`,
    );
  });
}
