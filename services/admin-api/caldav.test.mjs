import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { CalDavError, deleteEvent, isConfigured, putEvent } from "./caldav.mjs";

const BASE =
  "https://caldav.example.com/dav/calendar@example.com/Calendar/personal";
const USER = "calendar@example.com";
const PASSWORD = "s3cret-app-password";
const UID = "booking-1@example.com";
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

const realFetch = globalThis.fetch;
let calls;

// Replace the global fetch with a recorder returning a scripted response.
function respondWith(response) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (response instanceof Error) throw response;
    return { status: response, headers: new Headers() };
  };
}

beforeEach(() => {
  calls = [];
  process.env.CALDAV_URL_BASE = BASE;
  process.env.CALDAV_USER = USER;
  process.env.CALDAV_PASSWORD = PASSWORD;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CALDAV_URL_BASE;
  delete process.env.CALDAV_USER;
  delete process.env.CALDAV_PASSWORD;
});

describe("resource URLs", () => {
  const cases = [
    {
      name: "percent-encodes the at sign in a UID",
      base: BASE,
      uid: "booking-1@example.com",
      expected: `${BASE}/booking-1%40example.com.ics`,
    },
    {
      name: "percent-encodes a slash so the UID cannot escape the collection",
      base: BASE,
      uid: "booking-a/b@example.com",
      expected: `${BASE}/booking-a%2Fb%40example.com.ics`,
    },
    {
      name: "strips a trailing slash from the collection URL",
      base: `${BASE}/`,
      uid: UID,
      expected: `${BASE}/booking-1%40example.com.ics`,
    },
  ];

  for (const { name, base, uid, expected } of cases) {
    test(name, async () => {
      process.env.CALDAV_URL_BASE = base;
      respondWith(204);

      await putEvent({ uid, ics: ICS });

      assert.equal(calls[0].url, expected);
    });
  }
});

describe("putEvent", () => {
  test("sends the calendar object with Basic auth and the iCalendar media type", async () => {
    respondWith(201);

    await putEvent({ uid: UID, ics: ICS });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.equal(
      calls[0].headers["Content-Type"],
      "text/calendar; charset=utf-8",
    );
    assert.equal(
      calls[0].headers.Authorization,
      `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
    );
    assert.equal(calls[0].body, ICS);
  });

  for (const status of [200, 201, 204]) {
    test(`treats ${status} as success`, async () => {
      respondWith(status);

      await putEvent({ uid: UID, ics: ICS });
    });
  }

  for (const status of [403, 409, 412, 415, 500]) {
    test(`raises a CalDavError carrying status ${status}`, async () => {
      respondWith(status);

      await assert.rejects(putEvent({ uid: UID, ics: ICS }), (err) => {
        assert.ok(err instanceof CalDavError);
        assert.equal(err.status, status);
        return true;
      });
    });
  }

  // A regression here would put the shared mailbox password in the log of every
  // deployment with a misconfigured calendar.
  test("no failure message quotes the URL, the user or the password", async () => {
    for (const response of [
      500,
      Object.assign(new Error("connect ECONNREFUSED"), { name: "AbortError" }),
      new Error(`failed to reach ${BASE} as ${USER}:${PASSWORD}`),
    ]) {
      respondWith(response);
      await assert.rejects(putEvent({ uid: UID, ics: ICS }), (err) => {
        for (const secret of [BASE, USER, PASSWORD]) {
          assert.ok(!err.message.includes(secret), err.message);
        }
        return true;
      });
    }
  });

  test("an aborted request is reported as a timeout with no status", async () => {
    respondWith(Object.assign(new Error("aborted"), { name: "AbortError" }));

    await assert.rejects(putEvent({ uid: UID, ics: ICS }), {
      name: "CalDavError",
      message: "CalDAV request timed out",
      status: 0,
    });
  });

  test("any other transport failure is reported without detail", async () => {
    respondWith(new Error("getaddrinfo ENOTFOUND"));

    await assert.rejects(putEvent({ uid: UID, ics: ICS }), {
      name: "CalDavError",
      message: "CalDAV request failed",
      status: 0,
    });
  });
});

describe("deleteEvent", () => {
  test("sends a DELETE with Basic auth and no body", async () => {
    respondWith(204);

    await deleteEvent({ uid: UID });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].body, undefined);
  });

  for (const status of [200, 204, 404]) {
    test(`treats ${status} as success`, async () => {
      respondWith(status);

      await deleteEvent({ uid: UID });
    });
  }

  test("raises a CalDavError on any other status", async () => {
    respondWith(403);

    await assert.rejects(deleteEvent({ uid: UID }), {
      name: "CalDavError",
      status: 403,
    });
  });
});

describe("configuration", () => {
  for (const missing of ["CALDAV_URL_BASE", "CALDAV_USER", "CALDAV_PASSWORD"]) {
    test(`is unconfigured without ${missing}`, async () => {
      delete process.env[missing];
      respondWith(204);

      assert.equal(isConfigured(), false);
      await assert.rejects(putEvent({ uid: UID, ics: ICS }), {
        message: "CalDAV is not configured",
      });
      await assert.rejects(deleteEvent({ uid: UID }), {
        message: "CalDAV is not configured",
      });
      assert.equal(calls.length, 0);
    });
  }

  test("is configured when all three values are present", () => {
    assert.equal(isConfigured(), true);
  });
});

// admin-api is the authoritative writer and its conflict policy is "last write
// wins", so no conditional or scheduling request header is sent. This fence is
// what makes adding one a deliberate decision.
describe("request headers (deliberate fence)", () => {
  test("fence: no conditional or scheduling headers accompany a write", async () => {
    respondWith(204);

    await putEvent({ uid: UID, ics: ICS });
    await deleteEvent({ uid: UID });

    for (const call of calls) {
      for (const header of Object.keys(call.headers)) {
        assert.ok(
          !/^(if-match|if-none-match|prefer|schedule-)/i.test(header),
          `unexpected ${header} header`,
        );
      }
    }
  });
});
