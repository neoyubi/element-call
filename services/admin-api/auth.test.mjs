import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { authorizeRequest } from "./auth.mjs";

const SYNAPSE_URL = "https://synapse.example.com";
const API_KEY = "static-service-key";
const BOT_TOKEN = "bot-access-token";
const USER_TOKEN = "scheduler-access-token";
const USER_ID = "@scheduler:example.com";
const SCHEDULERS_ROOM_ID = "!schedulers:example.com";

const env = (overrides = {}) => ({
  apiKey: API_KEY,
  synapseUrl: SYNAPSE_URL,
  botAccessToken: BOT_TOKEN,
  schedulersRoomId: SCHEDULERS_ROOM_ID,
  ...overrides,
});

const request = (authorization) => ({
  headers: authorization === undefined ? {} : { authorization },
});

const realFetch = globalThis.fetch;
let calls;

// Route by path: whoami resolves the caller, the member lookup authorizes them.
function synapse({ whoami, member }) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, token: options.headers.Authorization.slice(7) });
    const scripted = url.includes("/account/whoami") ? whoami : member;
    if (scripted instanceof Error) throw scripted;
    return {
      status: scripted.status,
      json: async () => scripted.data ?? {},
    };
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("credential extraction", () => {
  const rejected = [
    ["no Authorization header at all", undefined],
    ["a header that is not a bearer token", `Basic ${API_KEY}`],
    ["a bearer prefix with an empty token", "Bearer    "],
  ];

  for (const [name, header] of rejected) {
    test(`${name} is rejected with 401`, async () => {
      assert.deepEqual(await authorizeRequest(request(header), env()), {
        ok: false,
        status: 401,
        error: "Missing or malformed Authorization header",
      });
    });
  }
});

describe("the static service credential", () => {
  test("the exact key authorizes with service scope and never calls Synapse", async () => {
    synapse({});

    assert.deepEqual(
      await authorizeRequest(request(`Bearer ${API_KEY}`), env()),
      { ok: true, scope: "service" },
    );
    assert.equal(calls.length, 0);
  });

  // timingSafeEqual throws on operands of different lengths, so the length
  // guard in front of it is load-bearing rather than an optimisation.
  for (const [name, token] of [
    ["one byte shorter", API_KEY.slice(0, -1)],
    ["one byte longer", `${API_KEY}x`],
  ]) {
    test(`a key ${name} is refused without throwing`, async () => {
      synapse({ whoami: { status: 401 } });

      const result = await authorizeRequest(
        request(`Bearer ${token}`),
        env({ schedulersRoomId: undefined }),
      );

      assert.deepEqual(result, {
        ok: false,
        status: 401,
        error: "Unauthorized",
      });
    });
  }

  test("no key is configured, so nothing matches the service path", async () => {
    synapse({ whoami: { status: 401 } });

    const result = await authorizeRequest(
      request("Bearer anything"),
      env({ apiKey: undefined, schedulersRoomId: undefined }),
    );

    assert.equal(result.status, 401);
  });
});

describe("the scheduler credential", () => {
  test("a joined member of the schedulers room is authorized", async () => {
    synapse({
      whoami: { status: 200, data: { user_id: USER_ID } },
      member: { status: 200, data: { membership: "join" } },
    });

    assert.deepEqual(
      await authorizeRequest(request(`Bearer ${USER_TOKEN}`), env()),
      { ok: true, scope: "scheduler", userId: USER_ID },
    );
  });

  // Reading membership with the caller's own token would let anyone who can
  // read the room decide their own authorization.
  test("membership is read with the bot token, not the caller's", async () => {
    synapse({
      whoami: { status: 200, data: { user_id: USER_ID } },
      member: { status: 200, data: { membership: "join" } },
    });

    await authorizeRequest(request(`Bearer ${USER_TOKEN}`), env());

    assert.equal(calls.length, 2);
    assert.equal(calls[0].token, USER_TOKEN);
    assert.equal(calls[1].token, BOT_TOKEN);
    assert.ok(calls[1].url.includes(encodeURIComponent(SCHEDULERS_ROOM_ID)));
    assert.ok(calls[1].url.includes(encodeURIComponent(USER_ID)));
  });

  const refusals = [
    ["a user with no membership state", { status: 404 }, 403],
    [
      "an invited but unjoined user",
      { status: 200, data: { membership: "invite" } },
      403,
    ],
    [
      "a user who has left",
      { status: 200, data: { membership: "leave" } },
      403,
    ],
    [
      "an unreadable membership state",
      { status: 500, data: { membership: "join" } },
      503,
    ],
  ];

  for (const [name, member, status] of refusals) {
    test(`${name} gets ${status}`, async () => {
      synapse({ whoami: { status: 200, data: { user_id: USER_ID } }, member });

      const result = await authorizeRequest(
        request(`Bearer ${USER_TOKEN}`),
        env(),
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, status);
    });
  }

  test("an expired token gets 401", async () => {
    synapse({ whoami: { status: 401 } });

    const result = await authorizeRequest(
      request(`Bearer ${USER_TOKEN}`),
      env(),
    );

    assert.deepEqual(result, {
      ok: false,
      status: 401,
      error: "Invalid or expired token",
    });
  });

  test("a homeserver error gets 503, never a pass", async () => {
    synapse({ whoami: { status: 500 } });

    const result = await authorizeRequest(
      request(`Bearer ${USER_TOKEN}`),
      env(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  test("an aborted lookup gets 503, never a pass", async () => {
    synapse({
      whoami: Object.assign(new Error("aborted"), { name: "AbortError" }),
    });

    const result = await authorizeRequest(
      request(`Bearer ${USER_TOKEN}`),
      env(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  test("without a schedulers room only the service key is accepted", async () => {
    synapse({ whoami: { status: 200, data: { user_id: USER_ID } } });

    const result = await authorizeRequest(
      request(`Bearer ${USER_TOKEN}`),
      env({ schedulersRoomId: undefined }),
    );

    assert.deepEqual(result, { ok: false, status: 401, error: "Unauthorized" });
    assert.equal(calls.length, 0);
  });
});
