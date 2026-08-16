import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

const SYNAPSE_URL = "https://synapse.example.com";
const CALDAV_BASE =
  "https://caldav.example.com/dav/calendar@example.com/Calendar/personal";
const CALL_BASE_URL = "https://call.example.com";
const ROOM_ID = "!room:example.com";
const STATE_PATH = "/state/io.element.call.scheduled_meeting/";

process.env.SYNAPSE_URL = SYNAPSE_URL;
process.env.BOT_ACCESS_TOKEN = "bot-access-token";
process.env.SERVER_NAME = "example.com";
process.env.ELEMENT_CALL_BASE_URL = CALL_BASE_URL;
process.env.ADMIN_API_KEY = "static-service-key";
process.env.CALDAV_URL_BASE = CALDAV_BASE;
process.env.CALDAV_USER = "calendar@example.com";
process.env.CALDAV_PASSWORD = "s3cret-app-password";

const {
  createMeetingRoom,
  deleteMeetingRoom,
  getCorsHeaders,
  ICS_AFFECTING_FIELDS,
  updateMeetingRoom,
} = await import("./server.mjs");

const START = Date.UTC(2026, 8, 1, 12, 0, 0);
const END = Date.UTC(2026, 8, 1, 12, 30, 0);
const MEET_LINK = `${CALL_BASE_URL}/demo-b-1?meetingStart=${START}&roomId=%21room%3Aexample.com&password=Zm9vYmFy`;

const storedMeeting = (overrides = {}) => ({
  booking_id: "b-1",
  scheduled_start: START,
  scheduled_end: END,
  organizer_name: "Alex Organizer",
  prospect_name: "Sam Prospect",
  organizer_email: "organizer@example.com",
  prospect_email: "guest@example.com",
  practice_type: "solo",
  timezone: "Europe/Berlin",
  sequence: 4,
  reminder_minutes: 30,
  meet_link: MEET_LINK,
  key_material: "ABCD",
  reminder_sent: 1111,
  reschedule_previous_start: 2222,
  reschedule_notified: 3333,
  ...overrides,
});

const realFetch = globalThis.fetch;
let calls;
let synapse;
let caldavStatus;

// One recorder for both back ends: everything under the CalDAV collection is a
// calendar write, everything else is a Synapse call.
function install() {
  calls = [];
  caldavStatus = 204;
  synapse = {};
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (url.startsWith(CALDAV_BASE)) {
      calls.push({ target: "caldav", method, url, ics: options.body });
      return { status: caldavStatus, headers: new Headers() };
    }
    const path = url.slice(SYNAPSE_URL.length);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ target: "synapse", method, path, body });
    const scripted = synapse[`${method} ${routeKey(path)}`] ?? {
      status: 200,
      data: {},
    };
    return { status: scripted.status, json: async () => scripted.data ?? {} };
  };
}

// Collapse the room id out of a Synapse path so tests can script by route.
function routeKey(path) {
  return path
    .replace(/\/rooms\/[^/]+/, "/rooms/:id")
    .replace(/\/join\/[^/]+/, "/join/:id");
}

const synapseCalls = (method, suffix) =>
  calls.filter(
    (call) =>
      call.target === "synapse" &&
      call.method === method &&
      call.path.endsWith(suffix),
  );

const caldavCalls = () => calls.filter((call) => call.target === "caldav");
const statePut = () => synapseCalls("PUT", STATE_PATH).at(-1)?.body;

function scriptState(meeting) {
  synapse[`GET /_matrix/client/v3/rooms/:id${STATE_PATH}`] = meeting
    ? { status: 200, data: meeting }
    : { status: 404, data: { errcode: "M_NOT_FOUND" } };
}

beforeEach(install);
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("cross-origin headers", () => {
  // Every route this service answers has to be listed, or a browser refuses
  // the request at preflight while curl succeeds, which hides the defect.
  test("every method the service answers is advertised", () => {
    const advertised = getCorsHeaders()
      ["Access-Control-Allow-Methods"].split(",")
      .map((method) => method.trim());

    assert.deepEqual(advertised.sort(), [
      "DELETE",
      "GET",
      "OPTIONS",
      "POST",
      "PUT",
    ]);
  });

  test("an origin is echoed only when it is on the allow list", () => {
    assert.equal(
      "Access-Control-Allow-Origin" in
        getCorsHeaders("https://call.example.com"),
      false,
    );
  });
});

describe("updateMeetingRoom merges request over stored state", () => {
  test("a moved start bumps the sequence and re-arms both notices", async () => {
    scriptState(storedMeeting());

    const result = await updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
      scheduled_end: END + 3600000,
      timezone: "Europe/Berlin",
    });

    assert.deepEqual(result, {
      status: 200,
      body: { success: true, room_id: ROOM_ID },
    });
    const written = statePut();
    assert.equal(written.sequence, 5);
    assert.equal(written.scheduled_start, START + 3600000);
    assert.equal(written.key_material, "ABCD");
    // The reminder must fire again for the new time, and the worker must send
    // the "moved" notice, so both stamps are cleared and the old start kept.
    assert.equal("reminder_sent" in written, false);
    assert.equal("reschedule_notified" in written, false);
    assert.equal(written.reschedule_previous_start, START);
    assert.equal(caldavCalls().length, 1);
    assert.equal(caldavCalls()[0].method, "PUT");
    assert.match(caldavCalls()[0].ics, /^SEQUENCE:5$/m);
  });

  test("only the countdown parameter of the join link is refreshed", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    const before = new URL(MEET_LINK);
    const after = new URL(statePut().meet_link);
    assert.equal(
      after.origin + after.pathname,
      before.origin + before.pathname,
    );
    assert.equal(
      after.searchParams.get("password"),
      before.searchParams.get("password"),
    );
    assert.equal(
      after.searchParams.get("roomId"),
      before.searchParams.get("roomId"),
    );
    assert.equal(
      after.searchParams.get("meetingStart"),
      String(START + 3600000),
    );
    // The alias in the path is the salt of the key derivation behind the
    // password, so an update must never recompute it from current settings.
    assert.equal(after.pathname, "/demo-b-1");
  });

  test("an unchanged start carries both notification stamps forward", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, { room_name: "Follow-up" });

    const written = statePut();
    assert.equal(written.reminder_sent, 1111);
    assert.equal(written.reschedule_previous_start, 2222);
    assert.equal(written.reschedule_notified, 3333);
    assert.equal(written.meet_link, MEET_LINK);
    assert.equal(written.key_material, "ABCD");
  });

  test("an empty body round-trips every stored field", async () => {
    const stored = storedMeeting();
    scriptState(stored);

    await updateMeetingRoom(ROOM_ID, {});

    const written = statePut();
    for (const key of Object.keys(stored)) {
      if (key === "sequence") continue;
      assert.deepEqual(written[key], stored[key], `field ${key} changed`);
    }
  });

  test("a first-ever start records no previous start", async () => {
    scriptState(storedMeeting({ scheduled_start: undefined }));

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START });

    assert.equal("reschedule_previous_start" in statePut(), false);
  });

  test("a room with no stored meeting state does not fail", async () => {
    scriptState(null);

    const result = await updateMeetingRoom(ROOM_ID, { scheduled_start: START });

    assert.equal(result.status, 200);
    assert.equal(statePut().key_material, undefined);
  });

  test("an unparseable stored join link is carried through untouched", async () => {
    scriptState(storedMeeting({ meet_link: "not a url" }));

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    assert.equal(statePut().meet_link, "not a url");
  });

  test("a retention-blanked join link stays absent rather than empty", async () => {
    scriptState(storedMeeting({ meet_link: "" }));

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    assert.equal("meet_link" in statePut(), false);
  });

  test("a rejected state write is reported and writes no calendar resource", async () => {
    scriptState(storedMeeting());
    synapse[`PUT /_matrix/client/v3/rooms/:id${STATE_PATH}`] = {
      status: 403,
      data: { error: "You don't have permission", errcode: "M_FORBIDDEN" },
    };

    const result = await updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
    });

    assert.equal(result.status, 403);
    assert.equal(caldavCalls().length, 0);
  });

  test("reminder_minutes falls back to the stored value, then to the default", async () => {
    scriptState(storedMeeting({ reminder_minutes: 45 }));
    await updateMeetingRoom(ROOM_ID, {});
    assert.equal(statePut().reminder_minutes, 45);

    install();
    scriptState(storedMeeting({ reminder_minutes: undefined }));
    await updateMeetingRoom(ROOM_ID, {});
    assert.equal(statePut().reminder_minutes, 30);

    install();
    scriptState(storedMeeting());
    await updateMeetingRoom(ROOM_ID, { reminder_minutes: 0 });
    assert.equal(statePut().reminder_minutes, 0);
  });
});

// A calendar write asserts NEEDS-ACTION on every attendee, and a raised
// sequence tells clients to supersede what they hold, so an edit no calendar
// can see must produce neither.
describe("the calendar is rewritten only when it would differ", () => {
  const unchanged = [
    ["an empty body", {}],
    ["a reminder lead time", { reminder_minutes: 15 }],
    ["a timezone", { timezone: "Pacific/Auckland" }],
    ["a room name", { room_name: "Follow-up" }],
    ["a practice type", { practice_type: "group" }],
    ["a value equal to the stored one", { prospect_name: "Sam Prospect" }],
  ];

  for (const [name, body] of unchanged) {
    test(`${name} bumps nothing and writes no calendar resource`, async () => {
      scriptState(storedMeeting());

      await updateMeetingRoom(ROOM_ID, body);

      const written = statePut();
      assert.equal(written.sequence, 4);
      assert.equal(caldavCalls().length, 0);
      // The preserved fields are untouched by the gate.
      assert.equal(written.key_material, "ABCD");
      assert.equal(written.reminder_sent, 1111);
      assert.equal(written.reschedule_previous_start, 2222);
      assert.equal(written.reschedule_notified, 3333);
    });
  }

  const changed = [
    ["scheduled_start", { scheduled_start: START + 3600000 }],
    ["scheduled_end", { scheduled_end: END + 3600000 }],
    ["organizer_name", { organizer_name: "Alexandra Organizer" }],
    ["prospect_name", { prospect_name: "Samira Prospect" }],
    ["organizer_email", { organizer_email: "alex@example.com" }],
    ["prospect_email", { prospect_email: "sam@example.com" }],
  ];

  for (const [field, body] of changed) {
    test(`a changed ${field} bumps once and writes once`, async () => {
      scriptState(storedMeeting());

      await updateMeetingRoom(ROOM_ID, body);

      assert.equal(statePut().sequence, 5);
      assert.deepEqual(
        caldavCalls().map((call) => call.method),
        ["PUT"],
      );
      assert.match(caldavCalls()[0].ics, /^SEQUENCE:5$/m);
      assert.equal(statePut().key_material, "ABCD");
    });
  }

  test("the join link is in the set, because it is written into the event", () => {
    assert.deepEqual(ICS_AFFECTING_FIELDS, [
      "scheduled_start",
      "scheduled_end",
      "organizer_name",
      "prospect_name",
      "organizer_email",
      "prospect_email",
      "meet_link",
    ]);
  });

  // A reschedule always moves the start, so the chain that depends on the
  // raised sequence reaching attendees is never caught by the gate.
  test("a reschedule always bumps and always rewrites", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
      scheduled_end: END + 3600000,
      timezone: "Europe/Berlin",
    });

    const written = statePut();
    assert.equal(written.sequence, 5);
    assert.equal(written.reschedule_previous_start, START);
    assert.equal("reschedule_notified" in written, false);
    assert.equal("reminder_sent" in written, false);
    assert.equal(caldavCalls().length, 1);
  });

  test("a meeting with no stored sequence starts at one", async () => {
    scriptState(storedMeeting({ sequence: undefined }));

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    assert.equal(statePut().sequence, 1);
  });
});

describe("deleteMeetingRoom", () => {
  test("purges the room after clearing the calendar", async () => {
    scriptState(storedMeeting());

    const result = await deleteMeetingRoom(ROOM_ID);

    assert.deepEqual(result, {
      status: 200,
      body: { success: true, room_id: ROOM_ID, method: "purge" },
    });
    const purge = calls.findIndex(
      (call) => call.target === "synapse" && call.method === "DELETE",
    );
    assert.ok(purge > calls.findIndex((call) => call.target === "caldav"));
  });

  test("a room with no meeting state is still purged", async () => {
    scriptState(null);

    const result = await deleteMeetingRoom(ROOM_ID);

    assert.equal(result.status, 200);
    assert.equal(caldavCalls().length, 0);
  });

  test("a purge the bot may not perform falls back to kick, close, leave", async () => {
    scriptState(storedMeeting());
    synapse["DELETE /_synapse/admin/v1/rooms/:id"] = { status: 403, data: {} };
    synapse["GET /_matrix/client/v3/rooms/:id/joined_members"] = {
      status: 200,
      data: {
        joined: { "@guest:example.com": {}, "@call-bot:example.com": {} },
      },
    };

    const result = await deleteMeetingRoom(ROOM_ID);

    assert.equal(result.body.method, "graceful");
    const order = calls
      .filter((call) => call.target === "synapse" && call.method !== "GET")
      .map((call) => call.path.replace(/\/$/, "").split("/").pop());
    assert.deepEqual(order.slice(-3), ["kick", "m.room.join_rules", "leave"]);
    // The bot must not kick itself before it can close the room.
    assert.equal(
      synapseCalls("POST", "/kick").at(0).body.user_id,
      "@guest:example.com",
    );
  });

  // The removal is the whole cancellation: the server inspects the stored
  // attendees on DELETE and sends the iTIP CANCEL itself. A revision written
  // first would reach the attendees as an update to a meeting being cancelled.
  test("the cancellation is a single removal, with nothing written first", async () => {
    scriptState(storedMeeting());

    await deleteMeetingRoom(ROOM_ID);

    assert.deepEqual(
      caldavCalls().map((call) => call.method),
      ["DELETE"],
    );
    assert.equal(
      caldavCalls()[0].url,
      `${CALDAV_BASE}/booking-b-1%40example.com.ics`,
    );
  });
});

// Configuration is read once when the module loads, so each case imports its
// own instance of the service.
async function withEnv(overrides, fixture) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import(`./server.mjs?${fixture}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("organizer identity", () => {
  const organizerLine = () =>
    caldavCalls()[0]
      .ics.split("\r\n")
      .find((line) => line.startsWith("ORGANIZER"));

  test("defaults to the CalDAV login when that login is an address", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    assert.equal(organizerLine(), "ORGANIZER:mailto:calendar@example.com");
  });

  test("a configured address is used in place of the login", async () => {
    const service = await withEnv(
      { CALDAV_ORGANIZER_EMAIL: "bookings@example.com" },
      "organizer-address",
    );
    scriptState(storedMeeting());

    await service.updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
    });

    assert.equal(organizerLine(), "ORGANIZER:mailto:bookings@example.com");
  });

  test("a configured name becomes the display name", async () => {
    const service = await withEnv(
      { CALDAV_ORGANIZER_NAME: "Example Practice" },
      "organizer-name",
    );
    scriptState(storedMeeting());

    await service.updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
    });

    assert.equal(
      organizerLine(),
      "ORGANIZER;CN=Example Practice:mailto:calendar@example.com",
    );
  });

  // mailto:jdoe is not an address, and emitting it breaks scheduling outright,
  // so a login that is not an address means no organizer at all.
  test("a login that is not an address omits the organizer", async () => {
    const service = await withEnv(
      { CALDAV_USER: "jdoe", CALDAV_ORGANIZER_EMAIL: undefined },
      "organizer-login-not-an-address",
    );
    scriptState(storedMeeting());

    await service.updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
    });

    assert.equal(organizerLine(), undefined);
  });
});

describe("calendar failures", () => {
  const realConsole = { warn: console.warn };
  let logged;

  beforeEach(() => {
    logged = [];
    console.warn = (...args) => logged.push(args.join(" "));
  });

  afterEach(() => {
    Object.assign(console, realConsole);
  });

  // A permanent rejection will never succeed on retry, so the operator has to
  // be able to tell it apart from a server that was briefly unavailable.
  test("a rejected write is reported as permanent and names the cause", async () => {
    scriptState(storedMeeting());
    caldavStatus = 415;

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    const line = logged.find((entry) => entry.startsWith("Calendar"));
    assert.match(line, /status 415/);
    assert.match(line, /permanent/);
  });

  test("a server error is reported as transient", async () => {
    scriptState(storedMeeting());
    caldavStatus = 503;

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    assert.match(
      logged.find((entry) => entry.startsWith("Calendar")),
      /transient/,
    );
  });

  test("a failed removal never stops the room being purged", async () => {
    scriptState(storedMeeting());
    caldavStatus = 500;

    const result = await deleteMeetingRoom(ROOM_ID);

    assert.equal(result.status, 200);
    assert.match(
      logged.find((entry) => entry.startsWith("Calendar")),
      /^Calendar cancel failed/,
    );
  });

  test("no failure line quotes an address, a name or the join link", async () => {
    scriptState(storedMeeting());
    caldavStatus = 500;

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    for (const line of logged) {
      for (const value of [
        "Alex Organizer",
        "Sam Prospect",
        "organizer@example.com",
        "guest@example.com",
        "calendar@example.com",
        "s3cret-app-password",
        MEET_LINK,
      ]) {
        assert.ok(!line.includes(value), line);
      }
    }
  });
});

describe("what the calendar shows", () => {
  // Property lines are folded at 75 octets, so they are joined back up before
  // the value is read.
  const property = (name) =>
    caldavCalls()[0]
      .ics.replace(/\r\n[ \t]/g, "")
      .match(new RegExp(`^${name}:(.*)$`, "m"))[1];
  const summary = () => property("SUMMARY");
  const description = () => property("DESCRIPTION");

  // The title is also the subject line of every invitation mail, so the
  // default must not put a person's name into a notification preview on every
  // device the collection reaches.
  test("the default title names no one and the body carries the link", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, { scheduled_start: START + 3600000 });

    assert.equal(summary(), "Appointment");
    assert.equal(description(), `Join: ${statePut().meet_link}`);
  });

  test("a room name in the request does not become the title", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
      room_name: "Sam Prospect",
    });

    assert.equal(summary(), "Appointment");
  });

  test("a template renders the meeting fields it names", async () => {
    const service = await withEnv(
      {
        MEETING_SUMMARY_TEMPLATE: "Consultation with {{prospect_name}}",
        MEETING_DESCRIPTION_TEMPLATE: "{{organizer_name}} — {{meet_link}}",
      },
      "templates",
    );
    scriptState(storedMeeting());

    await service.updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
    });

    assert.equal(summary(), "Consultation with Sam Prospect");
    assert.match(description(), /^Alex Organizer — https:/);
  });

  test("a placeholder with no value renders empty", async () => {
    const service = await withEnv(
      { MEETING_SUMMARY_TEMPLATE: "{{prospect_name}} {{nonsense}}" },
      "templates-empty",
    );
    scriptState(storedMeeting({ prospect_name: "" }));

    await service.updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
    });

    assert.equal(summary(), "");
  });

  // A cancellation is a resource removal, so there is no document to title.
  // The booking identifier can no longer end up as an event title anywhere.
  test("a cancellation writes no title at all", async () => {
    scriptState(storedMeeting());

    await deleteMeetingRoom(ROOM_ID);

    assert.ok(caldavCalls().every((call) => call.ics === undefined));
  });
});

describe("createMeetingRoom", () => {
  const request = {
    booking_id: "b-1",
    room_name: "Consultation",
    scheduled_start: START,
    scheduled_end: END,
    organizer_name: "Alex Organizer",
    prospect_name: "Sam Prospect",
    organizer_email: "organizer@example.com",
    prospect_email: "guest@example.com",
  };

  beforeEach(() => {
    synapse["POST /_matrix/client/v3/createRoom"] = {
      status: 200,
      data: { room_id: ROOM_ID },
    };
  });

  test("returns the join link and persists it alongside the key material", async () => {
    const result = await createMeetingRoom(request);

    assert.equal(result.status, 201);
    assert.equal(result.body.room_id, ROOM_ID);
    assert.equal(result.body.key_material.length, 4);
    const link = new URL(result.body.meet_link);
    assert.equal(link.searchParams.get("meetingStart"), String(START));
    assert.equal(link.searchParams.get("roomId"), ROOM_ID);
    assert.equal(link.searchParams.get("password").length, 43);
    assert.equal(statePut().meet_link, result.body.meet_link);
    assert.equal(statePut().key_material, result.body.key_material);
    assert.equal(statePut().sequence, 0);
  });

  test("rejects a request missing a required field", async () => {
    const result = await createMeetingRoom({
      ...request,
      scheduled_end: undefined,
    });

    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
  });

  test("knock access and the power level overrides are set at creation", async () => {
    await createMeetingRoom(request);

    const created = synapseCalls("POST", "/createRoom").at(0).body;
    assert.deepEqual(
      created.initial_state.find((event) => event.type === "m.room.join_rules")
        .content,
      { join_rule: "knock" },
    );
    assert.equal(created.power_level_content_override.invite, 100);
    assert.equal(created.power_level_content_override.users_default, 0);
    assert.equal(created.power_level_content_override.events_default, 0);
  });

  test("a rejected calendar write never fails the room creation", async () => {
    caldavStatus = 415;

    const result = await createMeetingRoom(request);

    assert.equal(result.status, 201);
    assert.equal(caldavCalls().length, 1);
  });

  test("a room created without CalDAV configured writes no calendar resource", async () => {
    const base = process.env.CALDAV_URL_BASE;
    delete process.env.CALDAV_URL_BASE;
    try {
      const result = await createMeetingRoom(request);

      assert.equal(result.status, 201);
      assert.equal(caldavCalls().length, 0);
    } finally {
      process.env.CALDAV_URL_BASE = base;
    }
  });

  test("the room alias localpart is prefixed and configurable", async () => {
    const result = await createMeetingRoom(request);
    assert.equal(result.body.room_alias, "#meet-b-1:example.com");

    const service = await withEnv({ ROOM_ALIAS_PREFIX: "appt-" }, "alias");
    install();
    synapse["POST /_matrix/client/v3/createRoom"] = {
      status: 200,
      data: { room_id: ROOM_ID },
    };

    const renamed = await service.createMeetingRoom(request);

    assert.equal(renamed.body.room_alias, "#appt-b-1:example.com");
    assert.equal(
      synapseCalls("POST", "/createRoom").at(0).body.room_alias_name,
      "appt-b-1",
    );
  });

  test("the timezone defaults to UTC and is configurable", async () => {
    await createMeetingRoom(request);
    assert.equal(statePut().timezone, "UTC");

    const service = await withEnv(
      { DEFAULT_TIMEZONE: "Europe/Berlin" },
      "timezone",
    );
    install();
    synapse["POST /_matrix/client/v3/createRoom"] = {
      status: 200,
      data: { room_id: ROOM_ID },
    };

    await service.createMeetingRoom(request);

    assert.equal(statePut().timezone, "Europe/Berlin");
  });
});
