import { sendReminder, sendReschedule } from "./mailer.mjs";

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
const REMINDER_LANG = ["nl", "de"].includes(process.env.REMINDER_LANG)
  ? process.env.REMINDER_LANG
  : "en";
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

// --- Task 1: reminder + reschedule emails ---
//
// Both notices live in the same state event and a Matrix state PUT is a full
// replace, so handling them in separate passes could race: two passes reading
// the same revision and each writing back its own stamp would silently drop
// the other's, re-sending that email on the next tick. Instead one pass per
// room reads the state once, applies the reschedule notice first (a moved
// meeting announces the move before any reminder for the new time), then the
// reminder, and persists everything with a single write.
export async function processMeetingEmails() {
  const now = Date.now();
  const rooms = await listJoinedRooms();

  for (const roomId of rooms) {
    let meeting;
    try {
      meeting = await getMeetingState(roomId);
    } catch (err) {
      console.warn(`Emails: failed to read state for a room: ${err.message}`);
      continue;
    }
    if (!meeting) continue; // not a meeting room

    const bookingId = meeting.booking_id || "?";
    // Working copy: both notices stamp into this and one PUT persists it,
    // preserving every other field incl. key_material.
    const updated = { ...meeting };
    let changed = false;

    // -- Reschedule notice --
    const previousStart = Number(meeting.reschedule_previous_start);
    if (Number.isFinite(previousStart) && !meeting.reschedule_notified) {
      const recipients = [
        meeting.prospect_email,
        meeting.organizer_email,
      ].filter(Boolean);
      const end = Number(meeting.scheduled_end);
      if (recipients.length === 0) {
        // No recipient to notify; stamp so we stop retrying this meeting.
        updated.reschedule_notified = now;
        changed = true;
        console.warn(
          `Reschedule: meeting has no recipient (booking ${bookingId}); marking notified`,
        );
      } else if (Number.isFinite(end) && now >= end) {
        // Meeting already over: the change is no longer actionable, so stamp
        // without emailing. This also bounds the SMTP-failure retry loop.
        updated.reschedule_notified = now;
        changed = true;
        console.log(
          `Reschedule: marked past-end meeting notified without emailing (booking ${bookingId})`,
        );
      } else if (!meeting.meet_link) {
        // Without a stored link there is nothing useful to send; skip quietly.
        console.warn(
          `Reschedule: meeting has no meet_link (booking ${bookingId}); skipping`,
        );
      } else if (MEETING_DRY_RUN) {
        console.log(
          `Reschedule (dry-run): would notify booking ${bookingId} (${recipients.length} recipient(s))`,
        );
      } else {
        try {
          await sendReschedule({
            to: recipients,
            prospectName: meeting.prospect_name,
            previousStartMs: previousStart,
            startMs: Number(meeting.scheduled_start),
            tzid: meeting.timezone,
            meetLink: meeting.meet_link,
            lang: REMINDER_LANG,
          });
          updated.reschedule_notified = now;
          changed = true;
          console.log(
            `Reschedule: notice sent for booking ${bookingId} (${recipients.length} recipient(s))`,
          );
        } catch (err) {
          // SMTP failure: leave reschedule_notified unset so we retry next
          // tick (bounded — once now >= scheduled_end the branch above
          // stamps it). Log only the error code: nodemailer's message can
          // embed the recipient address from an MTA rejection, which must
          // not hit logs.
          console.warn(
            `Reschedule: send failed (booking ${bookingId}): ${err.code ?? "SMTP_ERROR"}`,
          );
        }
      }
    }

    // -- Reminder --
    const start = Number(meeting.scheduled_start);
    const reminderMinutes = Number.isFinite(Number(meeting.reminder_minutes))
      ? Number(meeting.reminder_minutes)
      : REMINDER_DEFAULT_MINUTES;

    if (
      Number.isFinite(start) &&
      reminderMinutes > 0 &&
      !meeting.reminder_sent
    ) {
      if (now >= start) {
        // Past start: never email, but stamp reminder_sent to stop
        // re-scanning.
        updated.reminder_sent = now;
        changed = true;
        console.log(
          `Reminder: marked past-start meeting sent without emailing (booking ${bookingId})`,
        );
      } else if (now >= start - reminderMinutes * 60000) {
        const meetLink = meeting.meet_link;
        if (!meetLink) {
          // Without a stored link there is nothing to send; skip quietly.
          console.warn(
            `Reminder: meeting has no meet_link (booking ${bookingId}); skipping`,
          );
        } else {
          const recipients = [
            meeting.prospect_email,
            meeting.organizer_email,
          ].filter(Boolean);
          if (recipients.length === 0) {
            // No recipient to notify; stamp so we stop retrying.
            updated.reminder_sent = now;
            changed = true;
            console.warn(
              `Reminder: meeting has no recipient (booking ${bookingId}); marking sent`,
            );
          } else {
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
              updated.reminder_sent = now;
              changed = true;
              console.log(
                `Reminder: sent for booking ${bookingId} (${recipients.length} recipient(s))`,
              );
            } catch (err) {
              // SMTP failure: leave reminder_sent unset so we retry next
              // tick (bounded — the past-start branch stamps it). Error
              // code only, as above.
              console.warn(
                `Reminder: send failed (booking ${bookingId}): ${err.code ?? "SMTP_ERROR"}`,
              );
            }
          }
        }
      }
    }

    // Single write per room. A successful send is stamped even when another
    // send for the same room failed, so nothing already emailed is lost.
    if (changed) {
      const ok = await putMeetingState(roomId, updated);
      if (!ok) {
        // Stamps did not persist; already-sent emails may repeat next tick.
        console.warn(
          `Emails: failed to persist notification stamps (booking ${bookingId})`,
        );
      }
    }
  }
}

// --- Task 2: retention purge ---
export const PII_FIELDS = [
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

export async function processRetention() {
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
let emailsRunning = false;
async function emailsTick() {
  if (emailsRunning) return; // never overlap a slow tick with the next
  emailsRunning = true;
  try {
    await processMeetingEmails();
  } catch (err) {
    console.error(`Email tick error: ${err.message}`);
  } finally {
    emailsRunning = false;
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

  // Reminder + reschedule emails: every POLL_INTERVAL_MS, plus an immediate
  // first pass.
  void emailsTick();
  setInterval(() => void emailsTick(), POLL_INTERVAL_MS);

  // Retention: daily, plus an immediate first pass.
  void retentionTick();
  setInterval(() => void retentionTick(), DAY_MS);
}

// Run the poll loops only when this file is the program being run, so the
// passes above can be invoked directly.
if (import.meta.main) {
  main();
}
