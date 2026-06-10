import {
  type FC,
  type FormEvent,
  type FormEventHandler,
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Button, Heading, Text } from "@vector-im/compound-web";
import { logger } from "matrix-js-sdk/lib/logger";

import { Config } from "../config/Config";
import { FieldRow, InputField, ErrorMessage } from "../input/Input";
import styles from "./ScheduleMeetingForm.module.css";

interface Props {
  client: MatrixClient;
}

const DURATION_OPTIONS = [15, 30, 45, 60] as const;
const REMINDER_OPTIONS = [15, 30, 60, 120] as const;
const DEFAULT_DURATION = 30;
const DEFAULT_REMINDER = 30;
const DEFAULT_TIMEZONE = "Europe/Amsterdam";
// Mirrors the HTML5 email input semantics: a non-empty local part, an "@",
// and a dotted domain. Good enough for client-side guarding; the server is
// the source of truth.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function defaultTimezone(): string {
  try {
    return (
      new Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE
    );
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

// Date entered as "dd.mm.YYYY".
const DATE_REGEX = /^(\d{2})\.(\d{2})\.(\d{4})$/;

// Parse "dd.mm.YYYY" + "HH:MM" into an epoch-ms instant in local time.
// Returns undefined when the input is malformed or not a real calendar date
// (e.g. "40.13.2026" or a day that rolled over into the next month).
function parseStart(dateStr: string, timeStr: string): number | undefined {
  const match = DATE_REGEX.exec(dateStr.trim());
  if (!match || !timeStr) return undefined;
  const [, dd, mm, yyyy] = match;
  const ms = new Date(`${yyyy}-${mm}-${dd}T${timeStr}`).getTime();
  if (Number.isNaN(ms)) return undefined;
  const parsed = new Date(ms);
  if (parsed.getMonth() + 1 !== Number(mm) || parsed.getDate() !== Number(dd))
    return undefined;
  return ms;
}

// Full IANA zone list where the runtime supports it, else a small fallback.
// The current/local zone is always present and is the default selection.
function timezoneOptions(): string[] {
  const local = defaultTimezone();
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  let zones: string[] = [];
  try {
    if (typeof intl.supportedValuesOf === "function")
      zones = intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  if (zones.length === 0)
    zones = [
      local,
      "UTC",
      "Europe/Amsterdam",
      "Europe/London",
      "America/New_York",
    ];
  return zones.includes(local) ? zones : [local, ...zones];
}

const TIMEZONE_OPTIONS = timezoneOptions();

interface SuccessResult {
  meetLink: string;
}

export const ScheduleMeetingForm: FC<Props> = ({ client }) => {
  const { t } = useTranslation();

  const [inviteeName, setInviteeName] = useState("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  // True when the organizer email was derived from the logged-in account's
  // email threepid; the field is then locked to the account identity.
  const [organizerEmailDerived, setOrganizerEmailDerived] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);
  const [timezone, setTimezone] = useState<string>(defaultTimezone);
  const [reminder, setReminder] = useState<number>(DEFAULT_REMINDER);

  const [fieldError, setFieldError] = useState<string>();
  const [submitError, setSubmitError] = useState<Error>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SuccessResult>();

  useEffect(() => {
    client
      .getThreePids()
      .then(({ threepids }) => {
        const email = threepids.find((p) => p.medium === "email")?.address;
        if (email) {
          setOrganizerEmail(email);
          setOrganizerEmailDerived(true);
        }
      })
      .catch((err) => {
        logger.warn("Could not read account email for organizer field", err);
      });
  }, [client]);

  const durationId = useId();
  const reminderId = useId();
  const timezoneId = useId();

  const reset = useCallback((): void => {
    setInviteeName("");
    setInviteeEmail("");
    if (!organizerEmailDerived) setOrganizerEmail("");
    setDate("");
    setTime("");
    setDuration(DEFAULT_DURATION);
    setReminder(DEFAULT_REMINDER);
  }, [organizerEmailDerived]);

  const validate = useCallback((): string | undefined => {
    const name = inviteeName.trim();
    if (name.length < 1 || name.length > 100)
      return t("schedule_meeting.error_required");
    if (!inviteeEmail.trim()) return t("schedule_meeting.error_required");
    if (!EMAIL_REGEX.test(inviteeEmail.trim()))
      return t("schedule_meeting.error_email");
    if (organizerEmail.trim() && !EMAIL_REGEX.test(organizerEmail.trim()))
      return t("schedule_meeting.error_email");
    if (!date || !time) return t("schedule_meeting.error_required");
    const start = parseStart(date, time);
    if (start === undefined) return t("schedule_meeting.error_date");
    if (start <= Date.now()) return t("schedule_meeting.error_past_date");
    return undefined;
  }, [inviteeName, inviteeEmail, organizerEmail, date, time, t]);

  const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      setSubmitError(undefined);
      setResult(undefined);

      const error = validate();
      if (error) {
        setFieldError(error);
        return;
      }
      setFieldError(undefined);

      const start = parseStart(date, time);
      if (start === undefined) return; // guarded by validate(); defensive
      const end = start + duration * 60000;
      const name = inviteeName.trim();

      const organizerUserId = client.getUserId() ?? undefined;
      // Prefer the organizer's display name over the raw Matrix ID, which
      // would otherwise surface as the calendar invite's CN and in the
      // upcoming-meetings list.
      const organizerName =
        (organizerUserId && client.getUser(organizerUserId)?.displayName) ||
        undefined;

      const body = {
        booking_id: crypto.randomUUID(),
        room_name: name,
        scheduled_start: start,
        scheduled_end: end,
        organizer_name: organizerName,
        organizer_user_id: organizerUserId,
        organizer_email: organizerEmail.trim() || undefined,
        prospect_name: name,
        prospect_email: inviteeEmail.trim(),
        timezone,
        reminder_minutes: reminder,
      };

      async function submit(): Promise<void> {
        setSubmitting(true);
        const adminApiUrl = Config.get().admin_api_url;
        if (!adminApiUrl) throw new Error("Scheduling is not configured");
        const token = client.getAccessToken();
        if (!token) throw new Error("Missing access token");

        const response = await fetch(`${adminApiUrl}/api/admin/rooms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });

        if (response.status !== 201)
          throw new Error(`Scheduling failed (${response.status})`);

        const json = (await response.json()) as { meet_link?: string };
        setResult({ meetLink: json.meet_link ?? "" });
        reset();
      }

      submit()
        .catch((err: unknown) => {
          logger.error("Failed to schedule meeting", err);
          setSubmitError(
            err instanceof Error ? err : new Error("Scheduling failed"),
          );
        })
        .finally(() => setSubmitting(false));
    },
    [
      validate,
      date,
      time,
      duration,
      inviteeName,
      inviteeEmail,
      organizerEmail,
      timezone,
      reminder,
      client,
      reset,
    ],
  );

  const onCopyLink = useCallback((): void => {
    if (result?.meetLink)
      navigator.clipboard.writeText(result.meetLink).catch((err: unknown) => {
        logger.warn("Failed to copy meeting link", err);
      });
  }, [result]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        <Heading size="sm" weight="semibold" className={styles.title}>
          {t("schedule_meeting.title")}
        </Heading>
        <form className={styles.form} onSubmit={onSubmit}>
          <FieldRow>
            <InputField
              id="inviteeName"
              name="inviteeName"
              type="text"
              label={t("schedule_meeting.invitee_name")}
              placeholder={t("schedule_meeting.invitee_name")}
              required
              autoComplete="off"
              value={inviteeName}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setInviteeName(e.target.value)
              }
            />
          </FieldRow>
          <FieldRow>
            <InputField
              id="inviteeEmail"
              name="inviteeEmail"
              type="email"
              label={t("schedule_meeting.invitee_email")}
              placeholder={t("schedule_meeting.invitee_email")}
              required
              autoComplete="off"
              value={inviteeEmail}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setInviteeEmail(e.target.value)
              }
            />
          </FieldRow>
          <FieldRow>
            <InputField
              id="organizerEmail"
              name="organizerEmail"
              type="email"
              label={t("schedule_meeting.organizer_email")}
              placeholder={t("schedule_meeting.organizer_email")}
              autoComplete="off"
              disabled={organizerEmailDerived}
              value={organizerEmail}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setOrganizerEmail(e.target.value)
              }
            />
          </FieldRow>
          <div className={styles.row}>
            <InputField
              id="meetingDate"
              name="meetingDate"
              type="text"
              label={t("schedule_meeting.date")}
              placeholder={t("schedule_meeting.date_format")}
              required
              autoComplete="off"
              value={date}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setDate(e.target.value)
              }
            />
            <InputField
              id="meetingTime"
              name="meetingTime"
              type="time"
              label={t("schedule_meeting.time")}
              required
              value={time}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setTime(e.target.value)
              }
            />
          </div>
          <div className={styles.row}>
            <div className={styles.selectField}>
              <label htmlFor={durationId}>
                {t("schedule_meeting.duration")}
              </label>
              <select
                id={durationId}
                className={styles.select}
                value={duration}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setDuration(Number(e.target.value))
                }
              >
                {DURATION_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t("schedule_meeting.minutes", { count: minutes })}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.selectField}>
              <label htmlFor={reminderId}>
                {t("schedule_meeting.reminder")}
              </label>
              <select
                id={reminderId}
                className={styles.select}
                value={reminder}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setReminder(Number(e.target.value))
                }
              >
                <option value={0}>{t("schedule_meeting.reminder_none")}</option>
                {REMINDER_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t("schedule_meeting.minutes", { count: minutes })}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.selectField}>
            <label htmlFor={timezoneId}>{t("schedule_meeting.timezone")}</label>
            <select
              id={timezoneId}
              className={styles.select}
              value={timezone}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setTimezone(e.target.value)
              }
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          {fieldError && <p className={styles.error}>{fieldError}</p>}
          {submitError && (
            <FieldRow>
              <ErrorMessage error={submitError} />
            </FieldRow>
          )}
          {result && (
            <div className={styles.success}>
              <Text size="sm" className={styles.successText}>
                {t("schedule_meeting.success")}
              </Text>
              {result.meetLink && (
                <div className={styles.linkRow}>
                  <span className={styles.link}>{result.meetLink}</span>
                  <Button
                    type="button"
                    kind="secondary"
                    size="sm"
                    onClick={onCopyLink}
                  >
                    {t("schedule_meeting.copy_link")}
                  </Button>
                </div>
              )}
            </div>
          )}
          <Button type="submit" size="lg" disabled={submitting}>
            {submitting
              ? t("schedule_meeting.submitting")
              : t("schedule_meeting.submit")}
          </Button>
        </form>
      </div>
    </div>
  );
};
