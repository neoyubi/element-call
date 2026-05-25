import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
// SMTP_SECURE=1/true → implicit TLS (port 465). Otherwise STARTTLS on 587.
const SMTP_SECURE = /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || "");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_FROM = process.env.SMTP_FROM;

const SMTP_TIMEOUT_MS = 15000;

// Reuse a single pooled transport across reminder sends.
let transport = null;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth:
        SMTP_USER && SMTP_PASSWORD
          ? { user: SMTP_USER, pass: SMTP_PASSWORD }
          : undefined,
      // Hard caps so a stuck mail server can never wedge the worker loop.
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }
  return transport;
}

// Format a start instant in the meeting's IANA timezone for human display.
function formatStart(startMs, tzid, lang) {
  const locale = lang === "en" ? "en-GB" : "nl-NL";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: tzid || "Europe/Amsterdam",
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

function buildMessage({ prospectName, startMs, tzid, minutes, meetLink, lang }) {
  const when = formatStart(startMs, tzid, lang);
  const name = prospectName ? String(prospectName).trim() : "";

  if (lang === "en") {
    const greeting = name ? `Hi ${name},` : "Hi,";
    const subject = `Reminder: your appointment starts in ${minutes} minutes`;
    const text = [
      greeting,
      "",
      "You have a scheduled appointment.",
      `Start: ${when}`,
      "",
      "Join via this link:",
      meetLink,
      "",
    ].join("\n");
    const html = [
      `<p>${escapeHtml(greeting)}</p>`,
      "<p>You have a scheduled appointment.</p>",
      `<p>Start: ${escapeHtml(when)}</p>`,
      `<p>Join via this link:<br><a href="${escapeHtml(meetLink)}">${escapeHtml(meetLink)}</a></p>`,
    ].join("\n");
    return { subject, text, html };
  }

  // Dutch (default).
  const greeting = name ? `Beste ${name},` : "Beste,";
  const subject = `Herinnering: je afspraak begint over ${minutes} minuten`;
  const text = [
    greeting,
    "",
    "Je hebt een afspraak ingepland.",
    `Start: ${when}`,
    "",
    "Deelnemen via deze link:",
    meetLink,
    "",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Je hebt een afspraak ingepland.</p>",
    `<p>Start: ${escapeHtml(when)}</p>`,
    `<p>Deelnemen via deze link:<br><a href="${escapeHtml(meetLink)}">${escapeHtml(meetLink)}</a></p>`,
  ].join("\n");
  return { subject, text, html };
}

// Send a single reminder. `to` may be a string or an array of recipients.
// Throws on SMTP failure so the caller can leave reminder_sent unset and retry.
export async function sendReminder({
  to,
  prospectName,
  startMs,
  tzid,
  minutes,
  meetLink,
  lang,
}) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((addr) => (addr ? String(addr).trim() : ""))
    .filter(Boolean);

  if (recipients.length === 0) {
    throw new Error("sendReminder: no recipients");
  }

  const { subject, text, html } = buildMessage({
    prospectName,
    startMs,
    tzid,
    minutes,
    meetLink,
    lang,
  });

  await getTransport().sendMail({
    from: SMTP_FROM,
    to: recipients,
    subject,
    text,
    html,
  });
}
