import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const SYNAPSE_URL = "https://synapse.example.com";
const CALDAV_BASE =
  "https://caldav.example.com/dav/calendar@example.com/Calendar/personal";
const ROOM_ID = "!room:example.com";
const STATE_TYPE = "io.element.call.scheduled_meeting";

// Distinctive values so a log line that leaks one of them is unmistakable.
const PROSPECT_EMAIL = "prospect-fixture@example.invalid";
const ORGANIZER_EMAIL = "organizer-fixture@example.invalid";
const PROSPECT_NAME = "Prospect Fixture";
const ORGANIZER_NAME = "Organizer Fixture";
const MEET_LINK = `https://call.example.com/meet-fixture?password=fixturepassword`;
const PERSONAL_DATA = [
  PROSPECT_EMAIL,
  ORGANIZER_EMAIL,
  PROSPECT_NAME,
  ORGANIZER_NAME,
  MEET_LINK,
  "fixturepassword",
];

// ESM has no monkeypatching, and node:test's module mocking still sits behind a
// runtime flag, so the mail transport is swapped through a loader hook. The
// stub is evaluated in this realm, so it records onto the same globalThis.
const MAILER_STUB = `
export async function sendReminder(message) {
  globalThis.__mail.push({ kind: "reminder", ...message });
  if (globalThis.__mailFail.reminder) throw globalThis.__mailFail.reminder;
}
export async function sendReschedule(message) {
  globalThis.__mail.push({ kind: "reschedule", ...message });
  if (globalThis.__mailFail.reschedule) throw globalThis.__mailFail.reschedule;
}
`;

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const STUB = ${JSON.stringify(MAILER_STUB)};
      export async function resolve(specifier, context, next) {
        if (specifier.endsWith("mailer.mjs")) {
          return { url: "stub:mailer", shortCircuit: true, format: "module" };
        }
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        if (url === "stub:mailer") {
          return { format: "module", shortCircuit: true, source: STUB };
        }
        return next(url, context);
      }
    `),
);

process.env.SYNAPSE_URL = SYNAPSE_URL;
process.env.BOT_ACCESS_TOKEN = "bot-access-token";
process.env.SERVER_NAME = "example.com";
process.env.CALDAV_URL_BASE = CALDAV_BASE;
process.env.CALDAV_USER = "calendar@example.com";
process.env.CALDAV_PASSWORD = "s3cret-app-password";

const { PII_FIELDS, processMeetingEmails, processRetention } =
  await import("./worker.mjs");

const MINUTE = 60000;
const DAY = 86400000;

const meeting = (overrides = {}) => ({
  booking_id: "b-1",
  scheduled_start: Date.now() + 10 * MINUTE,
  scheduled_end: Date.now() + 40 * MINUTE,
  organizer_name: ORGANIZER_NAME,
  prospect_name: PROSPECT_NAME,
  organizer_email: ORGANIZER_EMAIL,
  prospect_email: PROSPECT_EMAIL,
  practice_type: "solo",
  timezone: "Europe/Berlin",
  sequence: 4,
  reminder_minutes: 30,
  meet_link: MEET_LINK,
  key_material: "ABCD",
  ...overrides,
});

const realFetch = globalThis.fetch;
const realConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
let calls;
let rooms;
let caldavStatus;
let statePutStatus;
let logged;

function install() {
  calls = [];
  rooms = new Map();
  caldavStatus = 204;
  statePutStatus = 200;
  logged = [];
  globalThis.__mail = [];
  globalThis.__mailFail = {};
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (url.startsWith(CALDAV_BASE)) {
      calls.push({ target: "caldav", method, url, ics: options.body });
      return { status: caldavStatus };
    }
    const path = url.slice(SYNAPSE_URL.length);
    if (path === "/_matrix/client/v3/joined_rooms") {
      return {
        status: 200,
        json: async () => ({ joined_rooms: [...rooms.keys()] }),
      };
    }
    const roomId = decodeURIComponent(path.match(/\/rooms\/([^/]+)\//)[1]);
    if (method === "PUT") {
      const body = JSON.parse(options.body);
      calls.push({ target: "state", method, roomId, body });
      return { status: statePutStatus, json: async () => ({ event_id: "$1" }) };
    }
    const state = rooms.get(roomId);
    return {
      status: state ? 200 : 404,
      json: async () => state ?? { errcode: "M_NOT_FOUND" },
    };
  };
}

// Capture every console channel so the personal-data assertions can inspect
// what a pass would actually print.
function captureLogs() {
  for (const channel of ["log", "warn", "error"]) {
    console[channel] = (...args) => logged.push(args.join(" "));
  }
}

const statePuts = () => calls.filter((call) => call.target === "state");
const caldavCalls = () => calls.filter((call) => call.target === "caldav");
const mail = () => globalThis.__mail;

beforeEach(install);
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

describe("one coalesced pass per room", () => {
  test("a room owing both notices is written exactly once, reschedule first", async () => {
    rooms.set(
      ROOM_ID,
      meeting({ reschedule_previous_start: Date.now() - 2 * DAY }),
    );

    await processMeetingEmails();

    assert.deepEqual(
      mail().map((message) => message.kind),
      ["reschedule", "reminder"],
    );
    assert.equal(statePuts().length, 1);
    const written = statePuts()[0].body;
    assert.ok(written.reschedule_notified > 0);
    assert.ok(written.reminder_sent > 0);
    assert.equal(written.key_material, "ABCD");
    assert.equal(written.sequence, 4);
  });

  test("a second pass over the written state does nothing", async () => {
    rooms.set(
      ROOM_ID,
      meeting({ reschedule_previous_start: Date.now() - 2 * DAY }),
    );
    await processMeetingEmails();
    const written = statePuts()[0].body;

    install();
    rooms.set(ROOM_ID, written);
    await processMeetingEmails();

    assert.equal(mail().length, 0);
    assert.equal(statePuts().length, 0);
  });

  test("a failed send does not discard the stamp of one that succeeded", async () => {
    rooms.set(
      ROOM_ID,
      meeting({ reschedule_previous_start: Date.now() - 2 * DAY }),
    );
    globalThis.__mailFail.reschedule = Object.assign(new Error("rejected"), {
      code: "EENVELOPE",
    });

    await processMeetingEmails();

    assert.equal(statePuts().length, 1);
    const written = statePuts()[0].body;
    assert.equal("reschedule_notified" in written, false);
    assert.ok(written.reminder_sent > 0);
  });

  test("a room with no meeting state is skipped", async () => {
    rooms.set(ROOM_ID, null);

    await processMeetingEmails();

    assert.equal(statePuts().length, 0);
  });

  test("a failed state write is reported without losing the sends", async () => {
    rooms.set(ROOM_ID, meeting());
    statePutStatus = 403;
    captureLogs();

    await processMeetingEmails();

    assert.equal(mail().length, 1);
    assert.ok(logged.some((line) => line.includes("failed to persist")));
  });
});

describe("notification branches", () => {
  test("a meeting that has already ended is stamped without a reschedule mail", async () => {
    rooms.set(
      ROOM_ID,
      meeting({
        scheduled_start: Date.now() - 2 * DAY,
        scheduled_end: Date.now() - DAY,
        reschedule_previous_start: Date.now() - 3 * DAY,
        reminder_minutes: 0,
      }),
    );

    await processMeetingEmails();

    assert.equal(mail().length, 0);
    assert.ok(statePuts()[0].body.reschedule_notified > 0);
  });

  test("a meeting already under way is stamped without a reminder mail", async () => {
    rooms.set(ROOM_ID, meeting({ scheduled_start: Date.now() - MINUTE }));

    await processMeetingEmails();

    assert.equal(mail().length, 0);
    assert.ok(statePuts()[0].body.reminder_sent > 0);
  });

  test("a meeting outside the reminder window is left alone", async () => {
    rooms.set(ROOM_ID, meeting({ scheduled_start: Date.now() + 5 * DAY }));

    await processMeetingEmails();

    assert.equal(mail().length, 0);
    assert.equal(statePuts().length, 0);
  });

  test("a reminder with no recipient is stamped rather than retried forever", async () => {
    rooms.set(ROOM_ID, meeting({ organizer_email: "", prospect_email: "" }));

    await processMeetingEmails();

    assert.equal(mail().length, 0);
    assert.ok(statePuts()[0].body.reminder_sent > 0);
  });

  // Without a link there is nothing worth sending, and the meeting may still
  // gain one, so this branch deliberately leaves the stamp unset. The
  // past-start branch above is what bounds the retry.
  test("a meeting with no join link is neither sent nor stamped", async () => {
    rooms.set(
      ROOM_ID,
      meeting({
        meet_link: "",
        reschedule_previous_start: Date.now() - 2 * DAY,
      }),
    );

    await processMeetingEmails();

    assert.equal(mail().length, 0);
    assert.equal(statePuts().length, 0);
  });

  // MEETING_DRY_RUN gates the reschedule notice and the retention purge, but
  // the reminder branch never consults it, so a dry run still sends real
  // reminder mail. Pinned so the asymmetry is visible rather than assumed away.
  test("fence: a dry run suppresses the reschedule notice but not the reminder", async () => {
    process.env.MEETING_DRY_RUN = "1";
    try {
      const dryRun = await import("./worker.mjs?dry-run");
      rooms.set(
        ROOM_ID,
        meeting({ reschedule_previous_start: Date.now() - 2 * DAY }),
      );

      await dryRun.processMeetingEmails();

      assert.deepEqual(
        mail().map((message) => message.kind),
        ["reminder"],
      );
      assert.equal(statePuts().length, 1);
      assert.equal("reschedule_notified" in statePuts()[0].body, false);
      assert.ok(statePuts()[0].body.reminder_sent > 0);
    } finally {
      delete process.env.MEETING_DRY_RUN;
    }
  });

  test("a dry run of the retention purge writes nothing", async () => {
    process.env.MEETING_DRY_RUN = "1";
    try {
      const dryRun = await import("./worker.mjs?dry-run");
      rooms.set(
        ROOM_ID,
        meeting({
          scheduled_start: Date.now() - 40 * DAY,
          scheduled_end: Date.now() - 40 * DAY + 30 * MINUTE,
        }),
      );

      await dryRun.processRetention();

      assert.equal(statePuts().length, 0);
      assert.equal(caldavCalls().length, 0);
    } finally {
      delete process.env.MEETING_DRY_RUN;
    }
  });
});

describe("retention purge", () => {
  const expired = (overrides = {}) =>
    meeting({
      scheduled_start: Date.now() - 40 * DAY,
      scheduled_end: Date.now() - 40 * DAY + 30 * MINUTE,
      reminder_sent: 1111,
      reschedule_previous_start: 2222,
      reschedule_notified: 3333,
      ...overrides,
    });

  test("the field list is exactly the five that identify a person", () => {
    assert.deepEqual(PII_FIELDS, [
      "organizer_name",
      "prospect_name",
      "organizer_email",
      "prospect_email",
      "meet_link",
    ]);
  });

  test("a meeting inside the retention window is untouched", async () => {
    rooms.set(ROOM_ID, meeting({ scheduled_end: Date.now() - DAY }));

    await processRetention();

    assert.equal(statePuts().length, 0);
    assert.equal(caldavCalls().length, 0);
  });

  test("an expired meeting is blanked and its calendar resource removed", async () => {
    rooms.set(ROOM_ID, expired());

    await processRetention();

    const written = statePuts()[0].body;
    for (const field of PII_FIELDS) {
      assert.equal(written[field], "", `${field} was not blanked`);
    }
    assert.equal(written.key_material, "ABCD");
    assert.equal(written.sequence, 4);
    assert.equal(written.booking_id, "b-1");
    assert.equal(written.reminder_sent, 1111);
    assert.equal(written.reschedule_previous_start, 2222);
    assert.equal(written.reschedule_notified, 3333);
  });

  test("the calendar resource is addressed by the booking UID", async () => {
    rooms.set(ROOM_ID, expired());

    await processRetention();

    assert.equal(
      caldavCalls().at(-1).url,
      `${CALDAV_BASE}/booking-b-1%40example.com.ics`,
    );
    assert.equal(caldavCalls().at(-1).method, "DELETE");
  });

  test("the state is redacted before the calendar is touched", async () => {
    rooms.set(ROOM_ID, expired());

    await processRetention();

    assert.equal(calls[0].target, "state");
    assert.equal(calls.at(-1).target, "caldav");
  });

  test("scheduling is handed to the client before the resource is removed", async () => {
    rooms.set(ROOM_ID, expired());

    await processRetention();

    assert.deepEqual(
      calls.map((call) => `${call.target}:${call.method}`),
      ["state:PUT", "caldav:PUT", "caldav:DELETE"],
    );
    const revision = caldavCalls()[0].ics;
    assert.match(
      revision,
      /^ORGANIZER;SCHEDULE-AGENT=CLIENT:mailto:calendar@example\.com$/m,
    );
    assert.match(revision, /^UID:booking-b-1@example\.com$/m);
    assert.match(revision, /^SEQUENCE:5$/m);
    assert.match(revision, /^SUMMARY:Appointment$/m);
    // Built from the copy taken before redaction, so the attendees the server
    // would otherwise mail a cancellation are still on the resource.
    assert.match(
      revision,
      /^ATTENDEE:mailto:organizer-fixture@example\.invalid$/m,
    );
  });

  test("a resource with no organizer is removed without a revision", async () => {
    process.env.CALDAV_USER = "jdoe";
    try {
      const service = await import("./worker.mjs?no-organizer");
      rooms.set(ROOM_ID, expired());

      await service.processRetention();

      assert.deepEqual(
        caldavCalls().map((call) => call.method),
        ["DELETE"],
      );
    } finally {
      process.env.CALDAV_USER = "calendar@example.com";
    }
  });

  test("an already redacted meeting is not rewritten", async () => {
    rooms.set(
      ROOM_ID,
      expired({
        organizer_name: "",
        prospect_name: "",
        organizer_email: "",
        prospect_email: "",
        meet_link: "",
      }),
    );

    await processRetention();

    assert.equal(statePuts().length, 0);
    assert.equal(caldavCalls().length, 0);
  });

  test("a calendar failure does not stop the redaction", async () => {
    rooms.set(ROOM_ID, expired());
    caldavStatus = 500;
    captureLogs();

    await processRetention();

    assert.equal(statePuts().length, 1);
    assert.equal(statePuts()[0].body.prospect_email, "");
  });

  test("a rejected redaction leaves the calendar resource in place", async () => {
    rooms.set(ROOM_ID, expired());
    statePutStatus = 403;
    captureLogs();

    await processRetention();

    assert.equal(caldavCalls().length, 0);
  });
});

describe("logs carry no personal data", () => {
  // Every branch that can log, driven with the fixture above; none of its
  // names, addresses or join link may appear in any channel.
  const branches = {
    "both notices": { reschedule_previous_start: Date.now() - 2 * DAY },
    "no recipient": { organizer_email: "", prospect_email: "" },
    "no join link": {
      meet_link: "",
      reschedule_previous_start: Date.now() - 2 * DAY,
    },
    "already under way": { scheduled_start: Date.now() - MINUTE },
    "already ended": {
      scheduled_start: Date.now() - 2 * DAY,
      scheduled_end: Date.now() - DAY,
      reschedule_previous_start: Date.now() - 3 * DAY,
    },
  };

  for (const [name, overrides] of Object.entries(branches)) {
    test(`the ${name} branch logs no personal data`, async () => {
      rooms.set(ROOM_ID, meeting(overrides));
      captureLogs();

      await processMeetingEmails();

      assert.ok(logged.length > 0 || statePuts().length > 0);
      assertNoPersonalData();
    });
  }

  test("the retention branch logs no personal data", async () => {
    rooms.set(
      ROOM_ID,
      meeting({
        scheduled_start: Date.now() - 40 * DAY,
        scheduled_end: Date.now() - 40 * DAY + 30 * MINUTE,
      }),
    );
    caldavStatus = 500;
    captureLogs();

    await processRetention();

    assertNoPersonalData();
  });

  // nodemailer surfaces an MTA rejection with the recipient inside the message,
  // so only the code may reach the log.
  test("a rejected send surfaces its code and not the recipient", async () => {
    rooms.set(ROOM_ID, meeting());
    globalThis.__mailFail.reminder = Object.assign(
      new Error(`550 5.1.1 <${PROSPECT_EMAIL}>: recipient rejected`),
      { code: "EENVELOPE" },
    );
    captureLogs();

    await processMeetingEmails();

    assert.ok(logged.some((line) => line.includes("EENVELOPE")));
    assertNoPersonalData();
  });

  function assertNoPersonalData() {
    for (const line of logged) {
      for (const value of PERSONAL_DATA) {
        assert.ok(!line.includes(value), `log line leaked ${value}: ${line}`);
      }
    }
  }
});

describe("state event type", () => {
  test("the configured event type is the one read and written", async () => {
    let requested;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url.includes("/state/")) requested = url;
      return inner(url, options);
    };
    rooms.set(ROOM_ID, meeting({ scheduled_start: Date.now() - MINUTE }));

    await processMeetingEmails();

    assert.ok(requested.endsWith(`/state/${STATE_TYPE}/`));
  });
});
