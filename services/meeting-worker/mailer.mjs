import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
// SMTP_SECURE=1/true → implicit TLS (port 465). Otherwise STARTTLS on 587.
const SMTP_SECURE = /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || "");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_FROM = process.env.SMTP_FROM;

// Zone used to render times when a meeting carries none of its own.
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "UTC";

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
  const locale =
    lang === "nl" ? "nl-NL" : lang === "de" ? "de-DE" : "en-GB";
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

function buildMessage({ prospectName, startMs, tzid, minutes, meetLink, lang }) {
  const when = formatStart(startMs, tzid, lang);
  const name = prospectName ? String(prospectName).trim() : "";

  if (lang === "nl") {
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

  if (lang === "de") {
    const greeting = name ? `Guten Tag ${name},` : "Guten Tag,";
    const subject = `Erinnerung: Ihr Termin beginnt in ${minutes} Minuten`;
    const text = [
      greeting,
      "",
      "Sie haben einen geplanten Termin.",
      `Beginn: ${when}`,
      "",
      "Nehmen Sie über diesen Link teil:",
      meetLink,
      "",
    ].join("\n");
    const html = [
      `<p>${escapeHtml(greeting)}</p>`,
      "<p>Sie haben einen geplanten Termin.</p>",
      `<p>Beginn: ${escapeHtml(when)}</p>`,
      `<p>Nehmen Sie über diesen Link teil:<br><a href="${escapeHtml(meetLink)}">${escapeHtml(meetLink)}</a></p>`,
    ].join("\n");
    return { subject, text, html };
  }

  // English (default).
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

function buildRescheduleMessage({
  prospectName,
  previousStartMs,
  startMs,
  tzid,
  meetLink,
  lang,
}) {
  const oldWhen = formatStart(previousStartMs, tzid, lang);
  const newWhen = formatStart(startMs, tzid, lang);
  const name = prospectName ? String(prospectName).trim() : "";

  if (lang === "nl") {
    const greeting = name ? `Beste ${name},` : "Beste,";
    const subject = "Je afspraak is verplaatst";
    const text = [
      greeting,
      "",
      "Je afspraak is verplaatst naar een nieuw tijdstip.",
      `Oude tijd: ${oldWhen}`,
      `Nieuwe tijd: ${newWhen}`,
      "",
      "Deelnemen via deze link:",
      meetLink,
      "",
    ].join("\n");
    const html = [
      `<p>${escapeHtml(greeting)}</p>`,
      "<p>Je afspraak is verplaatst naar een nieuw tijdstip.</p>",
      `<p>Oude tijd: ${escapeHtml(oldWhen)}<br>Nieuwe tijd: ${escapeHtml(newWhen)}</p>`,
      `<p>Deelnemen via deze link:<br><a href="${escapeHtml(meetLink)}">${escapeHtml(meetLink)}</a></p>`,
    ].join("\n");
    return { subject, text, html };
  }

  if (lang === "de") {
    const greeting = name ? `Guten Tag ${name},` : "Guten Tag,";
    const subject = "Ihr Termin wurde verschoben";
    const text = [
      greeting,
      "",
      "Ihr Termin wurde auf einen neuen Zeitpunkt verschoben.",
      `Alter Zeitpunkt: ${oldWhen}`,
      `Neuer Zeitpunkt: ${newWhen}`,
      "",
      "Nehmen Sie über diesen Link teil:",
      meetLink,
      "",
    ].join("\n");
    const html = [
      `<p>${escapeHtml(greeting)}</p>`,
      "<p>Ihr Termin wurde auf einen neuen Zeitpunkt verschoben.</p>",
      `<p>Alter Zeitpunkt: ${escapeHtml(oldWhen)}<br>Neuer Zeitpunkt: ${escapeHtml(newWhen)}</p>`,
      `<p>Nehmen Sie über diesen Link teil:<br><a href="${escapeHtml(meetLink)}">${escapeHtml(meetLink)}</a></p>`,
    ].join("\n");
    return { subject, text, html };
  }

  // English (default).
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = "Your appointment has been moved";
  const text = [
    greeting,
    "",
    "Your appointment has been moved to a new time.",
    `Old time: ${oldWhen}`,
    `New time: ${newWhen}`,
    "",
    "Join via this link:",
    meetLink,
    "",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Your appointment has been moved to a new time.</p>",
    `<p>Old time: ${escapeHtml(oldWhen)}<br>New time: ${escapeHtml(newWhen)}</p>`,
    `<p>Join via this link:<br><a href="${escapeHtml(meetLink)}">${escapeHtml(meetLink)}</a></p>`,
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

// Send a reschedule notice ("your appointment moved from X to Y"). `to` may
// be a string or an array of recipients. Throws on SMTP failure so the caller
// can leave reschedule_notified unset and retry.
export async function sendReschedule({
  to,
  prospectName,
  previousStartMs,
  startMs,
  tzid,
  meetLink,
  lang,
}) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((addr) => (addr ? String(addr).trim() : ""))
    .filter(Boolean);

  if (recipients.length === 0) {
    throw new Error("sendReschedule: no recipients");
  }

  const { subject, text, html } = buildRescheduleMessage({
    prospectName,
    previousStartMs,
    startMs,
    tzid,
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
