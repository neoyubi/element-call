import { after, before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

// PRODID is read from the environment when the module first loads.
process.env.SERVER_NAME = "example.com";
const { buildVEvent } = await import("./ics.mjs");

// DTSTAMP is the build instant, so the clock is frozen for the whole file.
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const DTSTAMP = "20260102T030405Z";

const START = Date.UTC(2026, 8, 1, 12, 0, 0);
const END = Date.UTC(2026, 8, 1, 12, 30, 0);

function baseEvent(overrides = {}) {
  return {
    uid: "booking-1@example.com",
    sequence: 3,
    startMs: START,
    endMs: END,
    summary: "Appointment",
    description: "Join: https://call.example.com/m",
    location: "https://call.example.com/m",
    organizer: { email: "calendar@example.com", name: "Reception" },
    attendees: [
      { email: "organizer@example.com", name: "Alex Organizer" },
      { email: "guest@example.com", name: "Sam Guest" },
    ],
    ...overrides,
  };
}

// RFC 5545 3.1: a continuation is CRLF followed by a single space or tab.
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, "");
}

function logicalLines(ics) {
  return unfold(ics).split("\r\n").filter(Boolean);
}

before(() => mock.timers.enable({ apis: ["Date"], now: NOW }));
after(() => mock.timers.reset());

describe("buildVEvent golden documents", () => {
  test("a REQUEST renders every property in order, CRLF terminated", () => {
    const ics = buildVEvent(baseEvent());

    assert.equal(
      ics,
      [
        "BEGIN:VCALENDAR",
        "PRODID:-//example.com//Element Call//EN",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        "UID:booking-1@example.com",
        "SEQUENCE:3",
        `DTSTAMP:${DTSTAMP}`,
        "DTSTART:20260901T120000Z",
        "DTEND:20260901T123000Z",
        "SUMMARY:Appointment",
        "DESCRIPTION:Join: https://call.example.com/m",
        "LOCATION:https://call.example.com/m",
        "URL:https://call.example.com/m",
        "ORGANIZER;CN=Reception:mailto:calendar@example.com",
        "ATTENDEE;CN=Alex Organizer;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-AC",
        " TION:mailto:organizer@example.com",
        "ATTENDEE;CN=Sam Guest;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:",
        " mailto:guest@example.com",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  // RFC 4791 section 4.1: a calendar object resource MUST NOT carry METHOD.
  // The server derives the iTIP message from the operation instead, and the
  // stricter implementations reject the whole resource when it is present.
  test("no METHOD property is written to the collection", () => {
    assert.ok(!/^METHOD:/m.test(unfold(buildVEvent(baseEvent()))));
  });

  test("a reschedule keeps the UID and carries the higher SEQUENCE", () => {
    const first = logicalLines(buildVEvent(baseEvent({ sequence: 0 })));
    const second = logicalLines(
      buildVEvent(
        baseEvent({
          sequence: 1,
          startMs: START + 3600000,
          endMs: END + 3600000,
        }),
      ),
    );

    assert.equal(
      first.find((line) => line.startsWith("UID:")),
      second.find((line) => line.startsWith("UID:")),
    );
    assert.equal(
      first.find((line) => line.startsWith("SEQUENCE:")),
      "SEQUENCE:0",
    );
    assert.equal(
      second.find((line) => line.startsWith("SEQUENCE:")),
      "SEQUENCE:1",
    );
    assert.equal(
      second.find((line) => line.startsWith("DTSTART")),
      "DTSTART:20260901T130000Z",
    );
  });

  test("optional inputs are omitted rather than emitted empty", () => {
    const lines = logicalLines(
      buildVEvent(
        baseEvent({
          description: "",
          location: "",
          organizer: { email: "" },
          attendees: [{ email: "" }, null, undefined],
        }),
      ),
    );

    for (const property of [
      "DESCRIPTION:",
      "LOCATION:",
      "URL:",
      "ORGANIZER",
      "ATTENDEE",
    ]) {
      assert.ok(
        !lines.some(
          (line) =>
            line.startsWith(property) &&
            !line.startsWith("DESCRIPTION:Appointment"),
        ),
        `expected no ${property} line, got ${JSON.stringify(lines)}`,
      );
    }
  });
});

describe("text escaping and injection guards", () => {
  test("TEXT specials are escaped, backslash first", () => {
    const ics = buildVEvent(
      baseEvent({ summary: "a\\b;c,d\ne", description: "", location: "" }),
    );

    assert.ok(logicalLines(ics).includes("SUMMARY:a\\\\b\\;c\\,d\\ne"));
  });

  test("CR and LF in any caller-supplied value never reach the output", () => {
    const ics = buildVEvent(
      baseEvent({
        uid: "booking\r\n-2@example.com",
        summary: "one\r\ntwo",
        location: "https://call.example.com/\r\nm",
        organizer: { email: "calendar\r\n@example.com", name: "Rec\r\neption" },
        attendees: [{ email: "guest\r\n@example.com", name: "Sam\r\nGuest" }],
      }),
    );

    for (const line of ics.split("\r\n")) {
      assert.ok(
        !/[\r\n]/.test(line),
        `raw line break in ${JSON.stringify(line)}`,
      );
    }
    assert.ok(logicalLines(ics).includes("UID:booking-2@example.com"));
  });
});

describe("line folding", () => {
  const longSummary = "s".repeat(300);

  test("every physical line is at most 75 octets", () => {
    const ics = buildVEvent(baseEvent({ summary: longSummary }));

    for (const line of ics.split("\r\n")) {
      assert.ok(
        Buffer.from(line, "utf8").length <= 75,
        `${Buffer.from(line, "utf8").length} octets: ${line}`,
      );
    }
  });

  test("continuations begin with exactly one space and unfold losslessly", () => {
    const ics = buildVEvent(baseEvent({ summary: longSummary }));
    const continuations = ics
      .split("\r\n")
      .filter((line) => line.startsWith(" "));

    assert.ok(continuations.length > 0);
    for (const line of continuations) {
      assert.ok(!line.startsWith("  "));
    }
    assert.ok(logicalLines(ics).includes(`SUMMARY:${longSummary}`));
  });

  test("a multi-byte character straddling the fold point is not split", () => {
    // "SUMMARY:" is 8 octets, so 66 filler characters put the two-octet "u"
    // with diaeresis across the 75th octet boundary.
    const summary = `${"s".repeat(66)}ü${"s".repeat(20)}`;
    const ics = buildVEvent(baseEvent({ summary }));

    assert.ok(!ics.includes("�"));
    assert.ok(ics.split("\r\n").includes(`SUMMARY:${"s".repeat(66)}`));
    assert.ok(logicalLines(ics).includes(`SUMMARY:${summary}`));
  });
});

describe("date-time rendering", () => {
  test("start and end are UTC instants", () => {
    const lines = logicalLines(buildVEvent(baseEvent()));

    assert.ok(lines.includes("DTSTART:20260901T120000Z"));
    assert.ok(lines.includes("DTEND:20260901T123000Z"));
  });

  // A TZID parameter obliges the writer to ship a matching VTIMEZONE
  // component (RFC 4791 section 4.1). The times here are absolute instants,
  // so the UTC form says the same thing and every client renders it in the
  // reader's own zone.
  test("no zone parameter and no zone component are written", () => {
    const document = unfold(buildVEvent(baseEvent()));

    assert.ok(!document.includes("TZID="));
    assert.ok(!document.includes("BEGIN:VTIMEZONE"));
  });

  test("DTSTAMP is always a UTC instant", () => {
    const lines = logicalLines(buildVEvent(baseEvent()));

    assert.ok(lines.includes(`DTSTAMP:${DTSTAMP}`));
  });
});

describe("the optional alarm", () => {
  test("no alarm is written by default", () => {
    assert.ok(!buildVEvent(baseEvent()).includes("BEGIN:VALARM"));
  });

  test("a configured lead time writes a display alarm", async () => {
    process.env.ICS_ALARM_MINUTES = "15";
    try {
      const { buildVEvent: withAlarm } = await import("./ics.mjs?alarm");
      const lines = logicalLines(withAlarm(baseEvent()));

      assert.deepEqual(
        lines.slice(
          lines.indexOf("BEGIN:VALARM"),
          lines.indexOf("END:VALARM") + 1,
        ),
        [
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          "TRIGGER:-PT15M",
          "DESCRIPTION:Appointment",
          "END:VALARM",
        ],
      );
    } finally {
      delete process.env.ICS_ALARM_MINUTES;
    }
  });

  test("a lead time of zero writes no alarm", async () => {
    process.env.ICS_ALARM_MINUTES = "0";
    try {
      const { buildVEvent: noAlarm } = await import("./ics.mjs?alarm-zero");

      assert.ok(!noAlarm(baseEvent()).includes("BEGIN:VALARM"));
    } finally {
      delete process.env.ICS_ALARM_MINUTES;
    }
  });
});

describe("calendar user parameters", () => {
  // RFC 5545 section 3.1.1: only a quoted-string may contain these characters,
  // and the TEXT backslash escapes are not defined for parameter values.
  const names = [
    ["Doe, Jane", 'CN="Doe, Jane"'],
    ["Jane Doe", "CN=Jane Doe"],
    ["Dr; Doe", 'CN="Dr; Doe"'],
    ["urn:x", 'CN="urn:x"'],
    ['Jane "JD" Doe', "CN=Jane JD Doe"],
  ];

  for (const [name, expected] of names) {
    test(`${JSON.stringify(name)} renders as ${expected}`, () => {
      const lines = logicalLines(
        buildVEvent(baseEvent({ organizer: { email: "c@example.com", name } })),
      );

      assert.ok(
        lines.some((line) => line.startsWith(`ORGANIZER;${expected}:`)),
        JSON.stringify(lines.filter((line) => line.startsWith("ORGANIZER"))),
      );
    });
  }

  test("a name is never TEXT-escaped", () => {
    const lines = logicalLines(
      buildVEvent(
        baseEvent({ organizer: { email: "c@example.com", name: "Doe, Jane" } }),
      ),
    );

    assert.ok(!lines.some((line) => line.includes("\\,")));
  });

  test("an unknown name leaves the parameter out entirely", () => {
    const lines = logicalLines(
      buildVEvent(
        baseEvent({
          organizer: { email: "c@example.com", name: "" },
          attendees: [{ email: "guest@example.com" }],
        }),
      ),
    );

    assert.ok(lines.includes("ORGANIZER:mailto:c@example.com"));
    assert.ok(
      lines.some(
        (line) => line.startsWith("ATTENDEE;RSVP=") && !line.includes("CN="),
      ),
    );
  });

  test("names reach the calendar, addresses stay in the mailto value", () => {
    const document = unfold(buildVEvent(baseEvent()));

    assert.ok(document.includes("CN=Alex Organizer;RSVP=TRUE"));
    assert.ok(document.includes("CN=Sam Guest;RSVP=TRUE"));
    assert.ok(!document.includes("CN=organizer@example.com"));
  });
});

// These pin behaviour the CalDAV interoperability work is expected to change.
// Each one is a deliberate fence: when the corresponding fix lands, the
// assertion below is rewritten in the same commit rather than quietly passing.
describe("known gaps (deliberate fences)", () => {
  const ics = () => buildVEvent(baseEvent());

  test("fence: no CREATED, LAST-MODIFIED, TRANSP or CLASS", () => {
    const lines = logicalLines(ics());

    for (const property of ["CREATED", "LAST-MODIFIED", "TRANSP", "CLASS"]) {
      assert.ok(!lines.some((line) => line.startsWith(`${property}:`)));
    }
  });

  test("fence: ORGANIZER has no SENT-BY or SCHEDULE-AGENT, ATTENDEE no CUTYPE", () => {
    const document = unfold(ics());

    assert.ok(!document.includes("SENT-BY="));
    assert.ok(!document.includes("SCHEDULE-AGENT="));
    assert.ok(!document.includes("CUTYPE="));
  });

  test("no recurrence properties are ever emitted", () => {
    const document = unfold(ics());

    for (const property of ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"]) {
      assert.ok(!document.includes(property));
    }
  });
});
