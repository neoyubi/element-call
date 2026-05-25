import { sendReminder } from "./mailer.mjs";

// --- Configuration (env by name only) ---
const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://localhost:8008";
const BOT_ACCESS_TOKEN = process.env.BOT_ACCESS_TOKEN;
const SERVER_NAME = process.env.SERVER_NAME;
const MEETING_STATE_TYPE =
  process.env.MEETING_STATE_TYPE || "io.element.call.scheduled_meeting";
const ELEMENT_CALL_BASE_URL = process.env.ELEMENT_CALL_BASE_URL;

const CALDAV_URL_BASE = process.env.CALDAV_URL_BASE;
const CALDAV_USER = process.env.CALDAV_USER;
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD;

const REMINDER_DEFAULT_MINUTES = parseInt(
  process.env.REMINDER_DEFAULT_MINUTES || "30",
  10,
);
const REMINDER_LANG = process.env.REMINDER_LANG === "en" ? "en" : "nl";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const MEETING_RETENTION_DAYS = parseInt(
  process.env.MEETING_RETENTION_DAYS || "30",
  10,
);
const MEETING_DRY_RUN = /^(1|true|yes)$/i.test(process.env.MEETING_DRY_RUN || "");

const DAY_MS = 86400000;
const SYNAPSE_TIMEOUT_MS = 5000;
const CALDAV_TIMEOUT_MS = 8000;

// --- Validation ---
if (!BOT_ACCESS_TOKEN) {
  console.error("BOT_ACCESS_TOKEN is required");
  process.exit(1);
}
if (!SERVER_NAME) {
  console.error("SERVER_NAME is required");
  process.exit(1);
}

// --- Synapse client (bot token, 5s timeout) ---
// Mirrors the admin-api synapseRequest shape; reimplemented here so the
// worker stays a self-contained service with no cross-directory imports.
async function synapseRequest(path, options = {}) {
  const url = `${SYNAPSE_URL}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOT_ACCESS_TOKEN}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(SYNAPSE_TIMEOUT_MS),
  });
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

// Read a room's meeting state event. Returns the content object, or null if
// the room has no such event (404 / M_NOT_FOUND).
async function getMeetingState(roomId) {
  const { status, data } = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
  );
  if (status === 200 && data && typeof data === "object") {
    return data;
  }
  return null;
}

// PUT the full meeting state content back (caller passes the merged object so
// every field, including key_material, is preserved).
async function putMeetingState(roomId, content) {
  const { status } = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
    {
      method: "PUT",
      body: JSON.stringify(content),
    },
  );
  return status === 200;
}

async function listJoinedRooms() {
  const { status, data } = await synapseRequest(
    "/_matrix/client/v3/joined_rooms",
  );
  if (status === 200 && data && Array.isArray(data.joined_rooms)) {
    return data.joined_rooms;
  }
  console.warn(`Failed to list joined rooms (status ${status})`);
  return [];
}

// --- CalDAV (retention purge only) ---
function caldavAuthHeader() {
  const token = Buffer.from(`${CALDAV_USER}:${CALDAV_PASSWORD}`).toString(
    "base64",
  );
  return `Basic ${token}`;
}

// DELETE the CalDAV event for a booking. 404 is treated as already-gone.
async function deleteCaldavEvent(uid) {
  if (!CALDAV_URL_BASE || !CALDAV_USER || !CALDAV_PASSWORD) {
    console.warn("CalDAV not configured; skipping calendar delete");
    return;
  }
  const url = `${CALDAV_URL_BASE}/${encodeURIComponent(uid)}.ics`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: caldavAuthHeader() },
    signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
  });
  if (resp.status === 404 || (resp.status >= 200 && resp.status < 300)) {
    return;
  }
  throw new Error(`CalDAV delete failed (status ${resp.status})`);
}

// --- Task 1: reminder emails ---
async function processReminders() {
  const now = Date.now();
  const rooms = await listJoinedRooms();

  for (const roomId of rooms) {
    let meeting;
    try {
      meeting = await getMeetingState(roomId);
    } catch (err) {
      console.warn(`Reminder: failed to read state for a room: ${err.message}`);
      continue;
    }
    if (!meeting) continue; // not a meeting room

    const start = Number(meeting.scheduled_start);
    if (!Number.isFinite(start)) continue;

    const reminderMinutes = Number.isFinite(Number(meeting.reminder_minutes))
      ? Number(meeting.reminder_minutes)
      : REMINDER_DEFAULT_MINUTES;

    // No reminder requested, or already handled.
    if (reminderMinutes <= 0) continue;
    if (meeting.reminder_sent) continue;

    // Past start: never email, but stamp reminder_sent to stop re-scanning.
    if (now >= start) {
      const ok = await putMeetingState(roomId, {
        ...meeting,
        reminder_sent: now,
      });
      if (ok) {
        console.log(
          `Reminder: marked past-start meeting sent without emailing (booking ${meeting.booking_id || "?"})`,
        );
      }
      continue;
    }

    // Outside the send window (too early).
    if (now < start - reminderMinutes * 60000) continue;

    const meetLink = meeting.meet_link;
    if (!meetLink) {
      // Without a stored link there is nothing to send; skip quietly.
      console.warn(
        `Reminder: meeting has no meet_link (booking ${meeting.booking_id || "?"}); skipping`,
      );
      continue;
    }

    const recipients = [meeting.prospect_email, meeting.organizer_email].filter(
      Boolean,
    );
    if (recipients.length === 0) {
      // No recipient to notify; stamp so we stop retrying this meeting.
      await putMeetingState(roomId, { ...meeting, reminder_sent: now });
      console.warn(
        `Reminder: meeting has no recipient (booking ${meeting.booking_id || "?"}); marking sent`,
      );
      continue;
    }

    try {
      await sendReminder({
        to: recipients,
        prospectName: meeting.prospect_name,
        startMs: start,
        tzid: meeting.timezone,
        minutes: reminderMinutes,
        meetLink,
        lang: REMINDER_LANG,
      });
    } catch (err) {
      // SMTP failure: leave reminder_sent unset so we retry next tick
      // (bounded — once now >= start the past-start branch stamps it).
      // Log only the error code: nodemailer's message can embed the
      // recipient address from an MTA rejection, which must not hit logs.
      console.warn(
        `Reminder: send failed (booking ${meeting.booking_id || "?"}): ${err.code ?? "SMTP_ERROR"}`,
      );
      continue;
    }

    // Stamp reminder_sent, preserving every other field incl. key_material.
    const ok = await putMeetingState(roomId, { ...meeting, reminder_sent: now });
    if (ok) {
      console.log(
        `Reminder: sent for booking ${meeting.booking_id || "?"} (${recipients.length} recipient(s))`,
      );
    } else {
      // Email went out but the flag did not persist. Next tick will resend.
      console.warn(
        `Reminder: email sent but failed to persist reminder_sent (booking ${meeting.booking_id || "?"})`,
      );
    }
  }
}

// --- Task 2: retention purge ---
const PII_FIELDS = [
  "organizer_name",
  "prospect_name",
  "organizer_email",
  "prospect_email",
  "meet_link",
];

function isAlreadyRedacted(meeting) {
  return PII_FIELDS.every((field) => {
    const value = meeting[field];
    return value === undefined || value === "";
  });
}

async function processRetention() {
  const now = Date.now();
  const cutoff = now - MEETING_RETENTION_DAYS * DAY_MS;
  const rooms = await listJoinedRooms();

  let targets = 0;
  for (const roomId of rooms) {
    let meeting;
    try {
      meeting = await getMeetingState(roomId);
    } catch (err) {
      console.warn(`Retention: failed to read state for a room: ${err.message}`);
      continue;
    }
    if (!meeting) continue;

    const end = Number(meeting.scheduled_end);
    if (!Number.isFinite(end) || end >= cutoff) continue; // still within retention

    if (isAlreadyRedacted(meeting)) continue; // idempotent: nothing to do

    targets++;
    const bookingId = meeting.booking_id || "?";

    if (MEETING_DRY_RUN) {
      console.log(`Retention (dry-run): would purge booking ${bookingId}`);
      continue;
    }

    // Redact PII in the state event, preserving structural fields.
    const redacted = { ...meeting };
    for (const field of PII_FIELDS) redacted[field] = "";

    const ok = await putMeetingState(roomId, redacted);
    if (!ok) {
      console.warn(`Retention: failed to redact state for booking ${bookingId}`);
      continue;
    }

    // Delete the calendar event (404 = already gone).
    if (meeting.booking_id) {
      const uid = `booking-${meeting.booking_id}@${SERVER_NAME}`;
      try {
        await deleteCaldavEvent(uid);
      } catch (err) {
        console.warn(
          `Retention: CalDAV delete failed for booking ${bookingId}: ${err.message}`,
        );
      }
    }

    console.log(`Retention: purged booking ${bookingId}`);
  }

  if (MEETING_DRY_RUN) {
    console.log(`Retention (dry-run): ${targets} target(s) identified`);
  }
}

// --- Scheduling ---
let reminderRunning = false;
async function reminderTick() {
  if (reminderRunning) return; // never overlap a slow tick with the next
  reminderRunning = true;
  try {
    await processReminders();
  } catch (err) {
    console.error(`Reminder tick error: ${err.message}`);
  } finally {
    reminderRunning = false;
  }
}

let retentionRunning = false;
async function retentionTick() {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    await processRetention();
  } catch (err) {
    console.error(`Retention tick error: ${err.message}`);
  } finally {
    retentionRunning = false;
  }
}

function main() {
  console.log(
    `meeting-worker starting (poll ${POLL_INTERVAL_MS}ms, retention ${MEETING_RETENTION_DAYS}d, lang ${REMINDER_LANG}${MEETING_DRY_RUN ? ", DRY RUN" : ""})`,
  );

  // Reminders: every POLL_INTERVAL_MS, plus an immediate first pass.
  void reminderTick();
  setInterval(() => void reminderTick(), POLL_INTERVAL_MS);

  // Retention: daily, plus an immediate first pass.
  void retentionTick();
  setInterval(() => void retentionTick(), DAY_MS);
}

main();
