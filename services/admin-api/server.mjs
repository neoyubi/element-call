import { createServer } from "node:http";
import { createHmac, randomBytes, pbkdf2 } from "node:crypto";

import { authorizeRequest } from "./auth.mjs";

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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

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

// --- Room Management ---

async function createMeetingRoom(body) {
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
  } = body;

  if (!booking_id || !room_name || !scheduled_start || !scheduled_end) {
    return {
      status: 400,
      body: {
        error: "Missing required fields: booking_id, room_name, scheduled_start, scheduled_end",
      },
    };
  }

  const aliasLocalpart = `demo-${booking_id}`;
  const roomAlias = `#${aliasLocalpart}:${SERVER_NAME}`;

  // Generate E2EE key material before room creation so it's in the initial state
  const keyMaterial = generateKeyMaterial();

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
            practice_type: practice_type || "solo",
            timezone: timezone || "Europe/Amsterdam",
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
  const password = await deriveSharedKey(keyMaterial, roomAlias);

  const meetLink = `${ELEMENT_CALL_BASE_URL}/${aliasLocalpart}?meetingStart=${scheduled_start}&roomId=${encodeURIComponent(roomId)}&password=${password}`;
  const organizerLink = `${meetLink}&organizer=1`;

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
      console.log(`Joined ${organizer_user_id} to room ${roomId}`);
    } else {
      console.warn(`Failed to join ${organizer_user_id}:`, joinResult.data);
    }
  }

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

async function updateMeetingRoom(roomId, body) {
  const {
    booking_id,
    scheduled_start,
    scheduled_end,
    organizer_name,
    prospect_name,
    practice_type,
    timezone,
    room_name,
  } = body;

  // Update the meeting state event
  const stateResult = await synapseRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEETING_STATE_TYPE}/`,
    {
      method: "PUT",
      body: JSON.stringify({
        booking_id: booking_id || "",
        scheduled_start,
        scheduled_end,
        organizer_name: organizer_name || "",
        prospect_name: prospect_name || "",
        practice_type: practice_type || "solo",
        timezone: timezone || "Europe/Amsterdam",
      }),
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

  console.log(`Updated room ${roomId} meeting metadata`);
  return { status: 200, body: { success: true, room_id: roomId } };
}

async function deleteMeetingRoom(roomId) {
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
