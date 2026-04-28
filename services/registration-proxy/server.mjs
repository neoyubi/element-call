import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://localhost:8008";
const SHARED_SECRET = process.env.REGISTRATION_SHARED_SECRET;
const PORT = parseInt(process.env.PORT || "6090", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "5", 10);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];
const MAX_RETRIES = 3;

if (!SHARED_SECRET) {
  console.error("REGISTRATION_SHARED_SECRET is required");
  process.exit(1);
}

// In-memory rate limiter keyed by IP
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

// Periodically clean up stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

function getCorsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (
    ALLOWED_ORIGINS.length === 0 ||
    (origin && ALLOWED_ORIGINS.includes(origin))
  ) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
  }
  return headers;
}

function json(res, status, body, origin) {
  const cors = getCorsHeaders(origin);
  res.writeHead(status, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify(body));
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

function generateHmac(nonce, username, password, admin = false) {
  const mac = createHmac("sha1", SHARED_SECRET);
  mac.update(nonce);
  mac.update("\0");
  mac.update(username);
  mac.update("\0");
  mac.update(password);
  mac.update("\0");
  mac.update(admin ? "admin" : "notadmin");
  return mac.digest("hex");
}

async function registerGuest(displayName, origin, clientIp) {
  // Rate limit check
  if (isRateLimited(clientIp)) {
    return {
      status: 429,
      body: { error: "Too many requests. Try again later." },
    };
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Step 1: Get nonce
    const nonceResp = await fetchJson(
      `${SYNAPSE_URL}/_synapse/admin/v1/register`,
    );
    if (nonceResp.status !== 200 || !nonceResp.data.nonce) {
      return {
        status: 502,
        body: { error: "Failed to get registration nonce from homeserver" },
      };
    }
    const { nonce } = nonceResp.data;

    // Step 2: Generate credentials
    const username = "guest_" + randomBytes(6).toString("hex");
    const password = randomBytes(12).toString("base64url");

    // Step 3: Sign and register
    const mac = generateHmac(nonce, username, password);
    const regResp = await fetchJson(
      `${SYNAPSE_URL}/_synapse/admin/v1/register`,
      {
        method: "POST",
        body: JSON.stringify({
          nonce,
          username,
          password,
          displayname: displayName || username,
          admin: false,
          mac,
        }),
      },
    );

    if (regResp.status === 200) {
      return {
        status: 200,
        body: {
          user_id: regResp.data.user_id,
          access_token: regResp.data.access_token,
          device_id: regResp.data.device_id,
          home_server: regResp.data.home_server,
          password,
        },
      };
    }

    // Retry on username collision
    if (
      regResp.data.errcode === "M_USER_IN_USE" &&
      attempt < MAX_RETRIES - 1
    ) {
      continue;
    }

    return {
      status: regResp.status,
      body: {
        error: regResp.data.error || "Registration failed",
        errcode: regResp.data.errcode,
      },
    };
  }

  return { status: 500, body: { error: "Failed after max retries" } };
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

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    const cors = getCorsHeaders(origin);
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { status: "ok" }, origin);
    return;
  }

  // Register endpoint
  if (url.pathname === "/register" && req.method === "POST") {
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress;

    const body = await readBody(req);
    const displayName = body?.displayName;

    try {
      const result = await registerGuest(displayName, origin, clientIp);
      json(res, result.status, result.body, origin);
    } catch (err) {
      console.error("Registration error:", err);
      json(res, 500, { error: "Internal server error" }, origin);
    }
    return;
  }

  json(res, 404, { error: "Not found" }, origin);
});

server.listen(PORT, () => {
  console.log(`Registration proxy listening on port ${PORT}`);
  console.log(`Synapse URL: ${SYNAPSE_URL}`);
  console.log(
    `Allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "*"}`,
  );
});
