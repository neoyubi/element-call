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
    organizerEmail: "calendar@example.com",
    attendeeEmails: ["organizer@example.com", "guest@example.com"],
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
        "ORGANIZER;CN=calendar@example.com:mailto:calendar@example.com",
        "ATTENDEE;CN=organizer@example.com;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=N",
        " EEDS-ACTION:mailto:organizer@example.com",
        "ATTENDEE;CN=guest@example.com;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS",
        " -ACTION:mailto:guest@example.com",
        "STATUS:CONFIRMED",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT10M",
        "DESCRIPTION:Appointment",
        "END:VALARM",
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
          organizerEmail: "",
          attendeeEmails: ["", null, undefined],
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
        organizerEmail: "calendar\r\n@example.com",
        attendeeEmails: ["guest\r\n@example.com"],
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

// These pin behaviour the CalDAV interoperability work is expected to change.
// Each one is a deliberate fence: when the corresponding fix lands, the
// assertion below is rewritten in the same commit rather than quietly passing.
describe("known gaps (deliberate fences)", () => {
  const ics = () => buildVEvent(baseEvent());

  test("fence: CN parameters are TEXT-escaped rather than quoted", () => {
    const lines = logicalLines(
      buildVEvent(baseEvent({ organizerEmail: "a,b@example.com" })),
    );

    assert.ok(
      lines.some((line) => line.startsWith("ORGANIZER;CN=a\\,b@example.com:")),
    );
  });

  test("fence: CN parameters carry the address, not a display name", () => {
    const lines = logicalLines(ics());

    assert.ok(
      lines.includes(
        "ORGANIZER;CN=calendar@example.com:mailto:calendar@example.com",
      ),
    );
  });

  test("fence: the alarm is unconditional and has no UID", () => {
    const lines = logicalLines(ics());

    assert.ok(lines.includes("TRIGGER:-PT10M"));
    const alarm = lines.slice(
      lines.indexOf("BEGIN:VALARM"),
      lines.indexOf("END:VALARM"),
    );
    assert.ok(!alarm.some((line) => line.startsWith("UID:")));
  });

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
