import test from "node:test";
import assert from "node:assert/strict";

import { buildMessage, buildRescheduleMessage } from "./mail-templates.mjs";

const LINK =
  "https://call.example.com/meet-abc?meetingStart=123&password=secret";

// Branding is read once at module load, so a case that needs different
// branding imports a fresh copy of the module under a unique specifier.
let variant = 0;
async function withEnv(env, run) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    variant += 1;
    await run(await import(`./mail-templates.mjs?variant=${variant}`));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const reminder = (over = {}) =>
  buildMessage({
    prospectName: "Sam",
    startMs: Date.UTC(2026, 0, 15, 9, 0),
    tzid: "UTC",
    minutes: 30,
    meetLink: LINK,
    lang: "en",
    ...over,
  });

test("reminder", async (t) => {
  await t.test("carries the subject, heading and start time", () => {
    const { subject, html } = reminder();
    assert.match(subject, /starts in 30 minutes/);
    assert.match(html, /Your appointment starts soon/);
    assert.match(html, /15 January 2026/);
  });

  await t.test("offers the link as a button and as readable text", () => {
    const { html } = reminder();
    assert.match(html, /Join the appointment/);
    // The button's href, then the fallback link's href and its visible text,
    // so the address is readable to anyone whose client drops the button.
    assert.equal(html.split("meetingStart=123").length - 1, 3);
  });

  await t.test("greets by name, and stays grammatical without one", () => {
    assert.match(reminder().html, /Hi Sam,/);
    assert.match(reminder({ prospectName: "" }).html, /Hi,/);
  });

  await t.test("renders Dutch and German", () => {
    assert.match(reminder({ lang: "nl" }).subject, /begint over 30 minuten/);
    assert.match(reminder({ lang: "nl" }).html, /Deelnemen aan de afspraak/);
    assert.match(reminder({ lang: "de" }).subject, /beginnt in 30 Minuten/);
    assert.match(reminder({ lang: "de" }).html, /Am Termin teilnehmen/);
  });

  await t.test("the plain-text part carries the same facts", () => {
    const { text } = reminder();
    assert.match(text, /Hi Sam,/);
    assert.match(text, /Start: /);
    // The link must stay literal in text: escaping it would break copy-paste.
    assert.ok(text.includes(LINK));
  });
});

test("reschedule", async (t) => {
  const moved = (over = {}) =>
    buildRescheduleMessage({
      prospectName: "Sam",
      previousStartMs: Date.UTC(2026, 0, 15, 9, 0),
      startMs: Date.UTC(2026, 0, 16, 14, 0),
      tzid: "UTC",
      meetLink: LINK,
      lang: "en",
      ...over,
    });

  await t.test("shows the old time before the new one", () => {
    const { html } = moved();
    assert.ok(html.indexOf("Old time") < html.indexOf("New time"));
    assert.match(html, /15 January 2026/);
    assert.match(html, /16 January 2026/);
  });

  await t.test("translates both labels", () => {
    assert.match(moved({ lang: "nl" }).html, /Oude tijd/);
    assert.match(moved({ lang: "nl" }).html, /Nieuwe tijd/);
    assert.match(moved({ lang: "de" }).html, /Alter Zeitpunkt/);
    assert.match(moved({ lang: "de" }).html, /Neuer Zeitpunkt/);
  });

  await t.test("the plain-text part lists both times", () => {
    const { text } = moved();
    assert.match(text, /Old time: /);
    assert.match(text, /New time: /);
  });
});

test("a name is escaped rather than rendered as markup", () => {
  const { html } = reminder({ prospectName: "<script>alert(1)</script>" });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("branding", async (t) => {
  await t.test("is absent by default, and the mail still reads", async () => {
    await withEnv(
      {
        MAIL_BRAND_NAME: undefined,
        MAIL_BRAND_LOGO_URL: undefined,
        MAIL_FOOTER_TEXT: undefined,
        MAIL_BRAND_COLOR: undefined,
      },
      ({ buildMessage: build }) => {
        const { html } = build({
          startMs: 0,
          minutes: 30,
          meetLink: LINK,
          lang: "en",
        });
        assert.ok(!html.includes("<img"));
        assert.ok(!html.includes("border-top"));
        assert.match(html, /Join the appointment/);
      },
    );
  });

  await t.test("shows the name, colour and footer when set", async () => {
    await withEnv(
      {
        MAIL_BRAND_NAME: "Example Clinic",
        MAIL_BRAND_COLOR: "#123456",
        MAIL_FOOTER_TEXT: "Example Clinic, Somewhere",
      },
      ({ buildMessage: build }) => {
        const { html } = build({
          startMs: 0,
          minutes: 30,
          meetLink: LINK,
          lang: "en",
        });
        assert.match(html, /Example Clinic/);
        assert.match(html, /#123456/);
        assert.match(html, /Example Clinic, Somewhere/);
      },
    );
  });

  await t.test("prefers a logo over the name when both are set", async () => {
    await withEnv(
      {
        MAIL_BRAND_NAME: "Example Clinic",
        MAIL_BRAND_LOGO_URL: "https://cdn.example.com/logo.png",
      },
      ({ buildMessage: build }) => {
        const { html } = build({
          startMs: 0,
          minutes: 30,
          meetLink: LINK,
          lang: "en",
        });
        assert.match(html, /<img src="https:\/\/cdn\.example\.com\/logo\.png"/);
        // The name survives as the image's alt text.
        assert.match(html, /alt="Example Clinic"/);
      },
    );
  });

  await t.test("refuses a colour that is not a colour", async () => {
    await withEnv(
      { MAIL_BRAND_COLOR: 'red;"><script>' },
      ({ buildMessage: build }) => {
        const { html } = build({
          startMs: 0,
          minutes: 30,
          meetLink: LINK,
          lang: "en",
        });
        assert.ok(!html.includes("<script>"));
        assert.match(html, /#2c7a7b/);
      },
    );
  });

  await t.test("refuses a logo URL that is not http(s)", async () => {
    await withEnv(
      {
        MAIL_BRAND_LOGO_URL: "javascript:alert(1)",
        MAIL_BRAND_NAME: "Example Clinic",
      },
      ({ buildMessage: build }) => {
        const { html } = build({
          startMs: 0,
          minutes: 30,
          meetLink: LINK,
          lang: "en",
        });
        assert.ok(!html.includes("javascript:"));
        assert.ok(!html.includes("<img"));
        assert.match(html, /Example Clinic/);
      },
    );
  });
});
