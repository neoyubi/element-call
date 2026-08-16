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

const { createMeetingRoom, deleteMeetingRoom, updateMeetingRoom } =
  await import("./server.mjs");

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

// The sequence bump and the calendar write are unconditional today: even an
// edit no calendar can see rewrites the resource, which resets every
// attendee's participation status. These fences change with that behaviour.
describe("calendar writes (deliberate fences)", () => {
  test("fence: a reminder-only edit still bumps the sequence and rewrites", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, { reminder_minutes: 15 });

    assert.equal(statePut().sequence, 5);
    assert.equal(caldavCalls().length, 1);
  });

  test("fence: an empty body still bumps the sequence and rewrites", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, {});

    assert.equal(statePut().sequence, 5);
    assert.equal(caldavCalls().length, 1);
  });

  test("fence: the event title comes from the request, not from a template", async () => {
    scriptState(storedMeeting());

    await updateMeetingRoom(ROOM_ID, {
      scheduled_start: START + 3600000,
      room_name: "Sam Prospect",
    });

    assert.match(caldavCalls()[0].ics, /^SUMMARY:Sam Prospect$/m);
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

  test("fence: the room alias localpart carries the demonstration prefix", async () => {
    const result = await createMeetingRoom(request);

    assert.equal(result.body.room_alias, "#demo-b-1:example.com");
    assert.equal(
      synapseCalls("POST", "/createRoom").at(0).body.room_alias_name,
      "demo-b-1",
    );
  });

  test("fence: the timezone falls back to a fixed European zone", async () => {
    await createMeetingRoom(request);

    assert.equal(statePut().timezone, "Europe/Amsterdam");
  });
});
