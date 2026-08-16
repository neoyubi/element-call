import nodemailer from "nodemailer";

import { buildMessage, buildRescheduleMessage } from "./mail-templates.mjs";

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
