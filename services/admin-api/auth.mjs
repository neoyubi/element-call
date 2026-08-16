import { timingSafeEqual } from "node:crypto";

// Authorization for /api/admin/* requests.
//
// Two accepted credentials, in order:
//   1. Service: bearer token equals the static ADMIN_API_KEY (timing-safe).
//      Intended for trusted backend-to-backend calls. Never shipped to a
//      browser. Returns scope "service".
//   2. Scheduler: bearer token is a Matrix access token. We resolve it to a
//      user via Synapse whoami, then require that user to be a joined member
//      of SCHEDULERS_ROOM_ID (checked with the bot token). Returns scope
//      "scheduler". This is the browser path.
//
// Synapse calls use a hard 5s timeout (Node's global fetch has none), so a
// hung homeserver cannot stall a request indefinitely.

const SYNAPSE_AUTH_TIMEOUT_MS = 5000;

function extractBearer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

function matchesApiKey(token, apiKey) {
  if (!apiKey || token.length !== apiKey.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(apiKey));
}

// GET against Synapse with a caller-supplied bearer token and a 5s abort.
// Returns { status, data } or throws on network/timeout (caller maps to 503).
async function synapseGet(synapseUrl, path, token) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    SYNAPSE_AUTH_TIMEOUT_MS,
  );
  try {
    const resp = await fetch(`${synapseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { status: resp.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// authorizeRequest(req, env) -> Promise<
//   { ok: true, scope: "service" } |
//   { ok: true, scope: "scheduler", userId } |
//   { ok: false, status, error }
// >
//
// env: { apiKey, synapseUrl, botAccessToken, schedulersRoomId }
export async function authorizeRequest(req, env) {
  const { apiKey, synapseUrl, botAccessToken, schedulersRoomId } = env;

  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, error: "Missing or malformed Authorization header" };
  }

  // Path A — service credential.
  if (matchesApiKey(token, apiKey)) {
    return { ok: true, scope: "service" };
  }

  // Path B — Matrix access token + #schedulers membership.
  if (!schedulersRoomId) {
    // Scheduler path is not configured; only the service key is accepted.
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  let whoami;
  try {
    whoami = await synapseGet(
      synapseUrl,
      "/_matrix/client/v3/account/whoami",
      token,
    );
  } catch {
    return { ok: false, status: 503, error: "Authentication service unavailable" };
  }

  if (whoami.status === 401) {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
  if (whoami.status !== 200 || !whoami.data?.user_id) {
    return { ok: false, status: 503, error: "Authentication service unavailable" };
  }

  const userId = whoami.data.user_id;

  let member;
  try {
    member = await synapseGet(
      synapseUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(schedulersRoomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
      botAccessToken,
    );
  } catch {
    return { ok: false, status: 503, error: "Authentication service unavailable" };
  }

  // The bot reads this state on the caller's behalf, so a refusal here is
  // about the bot, not the caller: Synapse answers 403 when the bot is not in
  // the schedulers room at all. Reporting that as "not authorized" sends
  // whoever debugs it looking at the wrong account, so it is a configuration
  // fault and says so. Access is still denied either way.
  if (member.status === 403) {
    console.error(
      "Scheduler check failed: the bot account cannot read membership in the schedulers room. Invite it to SCHEDULERS_ROOM_ID.",
    );
    return {
      ok: false,
      status: 503,
      error: "Scheduling is not configured correctly",
    };
  }

  // 404 = no membership state for this user in the schedulers room.
  if (member.status === 404 || member.data?.membership !== "join") {
    return { ok: false, status: 403, error: "Not authorized to schedule meetings" };
  }
  if (member.status !== 200) {
    return { ok: false, status: 503, error: "Authentication service unavailable" };
  }

  return { ok: true, scope: "scheduler", userId };
}
