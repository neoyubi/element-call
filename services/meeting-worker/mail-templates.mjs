// Presentation for the mail this service sends. Kept apart from mailer.mjs so
// it carries no dependency: the transport needs nodemailer, rendering a message
// needs nothing, and the tests for it run on plain node like every other suite
// in services/.

// Zone used to render times when a meeting carries none of its own.
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "UTC";

// Presentation of the HTML mail. Every deployment gets its own identity here
// without touching source: a name in the header, an accent for the heading and
// the join button, a logo, and a footer line for whatever the sender is
// obliged to say. All optional — unset means that part is simply not rendered,
// and the mail still reads correctly as an unbranded message.
const MAIL_BRAND_NAME = process.env.MAIL_BRAND_NAME || "";
const MAIL_BRAND_LOGO_URL = process.env.MAIL_BRAND_LOGO_URL || "";
const MAIL_FOOTER_TEXT = process.env.MAIL_FOOTER_TEXT || "";

// These two land inside a style attribute and a src attribute, so a malformed
// value would be markup rather than configuration. Anything that is not
// recognisably a colour or an http(s) URL is dropped in favour of the default.
const BRAND_COLOR_DEFAULT = "#2c7a7b";
const MAIL_BRAND_COLOR = /^#[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(
  process.env.MAIL_BRAND_COLOR || "",
)
  ? process.env.MAIL_BRAND_COLOR
  : BRAND_COLOR_DEFAULT;
const BRAND_LOGO = /^https?:\/\/[^\s"']+$/i.test(MAIL_BRAND_LOGO_URL)
  ? MAIL_BRAND_LOGO_URL
  : "";

// Format a start instant in the meeting's IANA timezone for human display.
function formatStart(startMs, tzid, lang) {
  const locale = lang === "nl" ? "nl-NL" : lang === "de" ? "de-DE" : "en-GB";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: tzid || DEFAULT_TIMEZONE,
    }).format(new Date(startMs));
  } catch {
    // Invalid tzid → fall back to UTC rather than throwing.
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(startMs));
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mail clients are a decade behind browsers: no external stylesheets, no flex
// or grid, and Outlook renders through Word. So the layout is nested tables
// with inline styles, which is the one thing every client agrees on.
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const INK = "#1f2328";
const MUTED = "#5f6368";
const RULE = "#e4e6eb";

function renderBrandHeader() {
  if (BRAND_LOGO) {
    return `<img src="${escapeHtml(BRAND_LOGO)}" alt="${escapeHtml(MAIL_BRAND_NAME)}" height="32" style="height:32px;display:block;border:0;">`;
  }
  if (MAIL_BRAND_NAME) {
    return `<span style="font-size:15px;font-weight:600;color:${MAIL_BRAND_COLOR};letter-spacing:.01em;">${escapeHtml(MAIL_BRAND_NAME)}</span>`;
  }
  return "";
}

// One label/value pair per row: the times are the thing a reader is actually
// scanning for, so they get their own block rather than sitting mid-sentence.
function renderRows(rows) {
  return rows
    .map(
      ({ label, value }) => `
            <tr>
              <td style="padding:0 0 4px;font-size:12px;line-height:16px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(label)}</td>
            </tr>
            <tr>
              <td style="padding:0 0 16px;font-size:16px;line-height:22px;color:${INK};font-weight:600;">${escapeHtml(value)}</td>
            </tr>`,
    )
    .join("");
}

function renderHtml({
  heading,
  greeting,
  intro,
  rows,
  ctaLabel,
  linkIntro,
  meetLink,
}) {
  const brand = renderBrandHeader();
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${RULE};border-radius:10px;font-family:${FONT_STACK};">
            ${brand ? `<tr><td style="padding:28px 32px 0;">${brand}</td></tr>` : ""}
            <tr>
              <td style="padding:${brand ? "16px" : "28px"} 32px 0;">
                <h1 style="margin:0;font-size:22px;line-height:28px;font-weight:600;color:${INK};">${escapeHtml(heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 0;font-size:15px;line-height:22px;color:${INK};">
                <p style="margin:0 0 8px;">${escapeHtml(greeting)}</p>
                <p style="margin:0;">${escapeHtml(intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${renderRows(rows)}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td bgcolor="${MAIL_BRAND_COLOR}" style="border-radius:6px;">
                      <a href="${escapeHtml(meetLink)}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;font-size:12px;line-height:18px;color:${MUTED};">
                ${escapeHtml(linkIntro)}<br>
                <a href="${escapeHtml(meetLink)}" style="color:${MAIL_BRAND_COLOR};word-break:break-all;">${escapeHtml(meetLink)}</a>
              </td>
            </tr>
            ${
              MAIL_FOOTER_TEXT
                ? `<tr>
              <td style="padding:16px 32px;border-top:1px solid ${RULE};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(MAIL_FOOTER_TEXT)}</td>
            </tr>`
                : ""
            }
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Copy per language. Kept as data so the presentation above is written once:
// three languages times two message types used to be six near-identical blocks
// of markup, which is six places for them to drift apart.
function reminderCopy({ name, when, minutes, lang }) {
  if (lang === "nl") {
    return {
      subject: `Herinnering: je afspraak begint over ${minutes} minuten`,
      heading: "Je afspraak begint binnenkort",
      greeting: name ? `Beste ${name},` : "Beste,",
      intro: "Je hebt een afspraak ingepland.",
      rows: [{ label: "Start", value: when }],
      ctaLabel: "Deelnemen aan de afspraak",
      linkIntro: "Deelnemen via deze link:",
    };
  }
  if (lang === "de") {
    return {
      subject: `Erinnerung: Ihr Termin beginnt in ${minutes} Minuten`,
      heading: "Ihr Termin beginnt in Kürze",
      greeting: name ? `Guten Tag ${name},` : "Guten Tag,",
      intro: "Sie haben einen geplanten Termin.",
      rows: [{ label: "Beginn", value: when }],
      ctaLabel: "Am Termin teilnehmen",
      linkIntro: "Nehmen Sie über diesen Link teil:",
    };
  }
  return {
    subject: `Reminder: your appointment starts in ${minutes} minutes`,
    heading: "Your appointment starts soon",
    greeting: name ? `Hi ${name},` : "Hi,",
    intro: "You have a scheduled appointment.",
    rows: [{ label: "Start", value: when }],
    ctaLabel: "Join the appointment",
    linkIntro: "Join via this link:",
  };
}

function rescheduleCopy({ name, oldWhen, newWhen, lang }) {
  if (lang === "nl") {
    return {
      subject: "Je afspraak is verplaatst",
      heading: "Je afspraak is verplaatst",
      greeting: name ? `Beste ${name},` : "Beste,",
      intro: "Je afspraak is verplaatst naar een nieuw tijdstip.",
      rows: [
        { label: "Oude tijd", value: oldWhen },
        { label: "Nieuwe tijd", value: newWhen },
      ],
      ctaLabel: "Deelnemen aan de afspraak",
      linkIntro: "Deelnemen via deze link:",
    };
  }
  if (lang === "de") {
    return {
      subject: "Ihr Termin wurde verschoben",
      heading: "Ihr Termin wurde verschoben",
      greeting: name ? `Guten Tag ${name},` : "Guten Tag,",
      intro: "Ihr Termin wurde auf einen neuen Zeitpunkt verschoben.",
      rows: [
        { label: "Alter Zeitpunkt", value: oldWhen },
        { label: "Neuer Zeitpunkt", value: newWhen },
      ],
      ctaLabel: "Am Termin teilnehmen",
      linkIntro: "Nehmen Sie über diesen Link teil:",
    };
  }
  return {
    subject: "Your appointment has been moved",
    heading: "Your appointment has been moved",
    greeting: name ? `Hi ${name},` : "Hi,",
    intro: "Your appointment has been moved to a new time.",
    rows: [
      { label: "Old time", value: oldWhen },
      { label: "New time", value: newWhen },
    ],
    ctaLabel: "Join the appointment",
    linkIntro: "Join via this link:",
  };
}

// The plain-text alternative carries the same facts in the same order. It is
// what a text-only client shows and what most spam filters read, so it is not
// a courtesy copy.
function renderText({ greeting, intro, rows, linkIntro }, meetLink) {
  return [
    greeting,
    "",
    intro,
    ...rows.map(({ label, value }) => `${label}: ${value}`),
    "",
    linkIntro,
    meetLink,
    "",
  ].join("\n");
}

function build(copy, meetLink) {
  return {
    subject: copy.subject,
    text: renderText(copy, meetLink),
    html: renderHtml({ ...copy, meetLink }),
  };
}

export function buildMessage({
  prospectName,
  startMs,
  tzid,
  minutes,
  meetLink,
  lang,
}) {
  const copy = reminderCopy({
    name: prospectName ? String(prospectName).trim() : "",
    when: formatStart(startMs, tzid, lang),
    minutes,
    lang,
  });
  return build(copy, meetLink);
}

export function buildRescheduleMessage({
  prospectName,
  previousStartMs,
  startMs,
  tzid,
  meetLink,
  lang,
}) {
  const copy = rescheduleCopy({
    name: prospectName ? String(prospectName).trim() : "",
    oldWhen: formatStart(previousStartMs, tzid, lang),
    newWhen: formatStart(startMs, tzid, lang),
    lang,
  });
  return build(copy, meetLink);
}
