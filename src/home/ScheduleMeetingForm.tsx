import {
  type FC,
  type FormEvent,
  type FormEventHandler,
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Button, Heading, Text } from "@vector-im/compound-web";
import { logger } from "matrix-js-sdk/lib/logger";

import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
import { FieldRow, InputField, ErrorMessage } from "../input/Input";
import { parseStart } from "./dateFormat";
import styles from "./ScheduleMeetingForm.module.css";

interface Props {
  client: MatrixClient;
  /** Prefill for the date field, as an <input type="date"> value. */
  initialDate?: string;
  /** Prefill for the time field, as an <input type="time"> value. */
  initialTime?: string;
  /** Meeting length to preselect, in minutes. */
  initialDurationMinutes?: number;
}

// Mirrors the HTML5 email input semantics: a non-empty local part, an "@",
// and a dotted domain. Good enough for client-side guarding; the server is
// the source of truth.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every IANA zone the runtime knows about, or just UTC where it knows none.
// Computed once: the list is long and never changes.
const SUPPORTED_TIMEZONES = ((): string[] => {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  try {
    if (typeof intl.supportedValuesOf === "function")
      return intl.supportedValuesOf("timeZone");
  } catch {
    // The runtime knows the function but not the key; fall through.
  }
  return ["UTC"];
})();

// The zone the browser reports, or the configured default where it reports
// none.
function defaultTimezone(): string {
  const configured =
    Config.get().calendar?.default_timezone ??
    CALENDAR_DEFAULTS.default_timezone;
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || configured;
  } catch {
    return configured;
  }
}

interface SuccessResult {
  meetLink: string;
}

/**
 * The prefills are read once, when the form mounts. Opening the form on a
 * different slot remounts it rather than pushing new values into fields
 * someone may already be typing in.
 */
export const ScheduleMeetingForm: FC<Props> = ({
  client,
  initialDate,
  initialTime,
  initialDurationMinutes,
}) => {
  const { t } = useTranslation();
  const calendar = Config.get().calendar;
  const durationOptions =
    calendar?.duration_options ?? CALENDAR_DEFAULTS.duration_options;
  const reminderOptions =
    calendar?.reminder_options ?? CALENDAR_DEFAULTS.reminder_options;

  const [inviteeName, setInviteeName] = useState("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  // True when the organizer email was derived from the logged-in account's
  // email threepid; the field is then locked to the account identity.
  const [organizerEmailDerived, setOrganizerEmailDerived] = useState(false);
  const [date, setDate] = useState(() => initialDate ?? "");
  const [time, setTime] = useState(() => initialTime ?? "");
  const [duration, setDuration] = useState<number>(
    () =>
      initialDurationMinutes ??
      calendar?.default_duration_minutes ??
      CALENDAR_DEFAULTS.default_duration_minutes,
  );
  const [timezone, setTimezone] = useState<string>(defaultTimezone);
  const [reminder, setReminder] = useState<number>(
    () =>
      calendar?.default_reminder_minutes ??
      CALENDAR_DEFAULTS.default_reminder_minutes,
  );

  // The zone list is only rebuilt when the selection moves outside it, which
  // happens at most once, for a zone the runtime does not enumerate.
  const timezoneOptions = useMemo(
    () =>
      SUPPORTED_TIMEZONES.includes(timezone)
        ? SUPPORTED_TIMEZONES
        : [timezone, ...SUPPORTED_TIMEZONES],
    [timezone],
  );

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
    setDuration(
      calendar?.default_duration_minutes ??
        CALENDAR_DEFAULTS.default_duration_minutes,
    );
    setReminder(
      calendar?.default_reminder_minutes ??
        CALENDAR_DEFAULTS.default_reminder_minutes,
    );
  }, [organizerEmailDerived, calendar]);

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
    if (start === undefined) return t("schedule_meeting.error_required");
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
              type="date"
              label={t("schedule_meeting.date")}
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
                {durationOptions.map((minutes) => (
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
                {reminderOptions.map((minutes) => (
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
              {timezoneOptions.map((tz) => (
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
