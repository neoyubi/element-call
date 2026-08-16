import {
  type FC,
  type FormEvent,
  type FormEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Button, Heading, Text } from "@vector-im/compound-web";
import { logger } from "matrix-js-sdk/lib/logger";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import CheckCircleSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/check-circle-solid";
import CheckIcon from "@vector-im/compound-design-tokens/assets/web/icons/check";

import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
import { InputField } from "../input/Input";
import { DateField, TimeField } from "../input/DateTimeInput";
import { scheduleAdvancedOpen, useSetting } from "../settings/settings";
import { parseStart } from "./dateFormat";
import styles from "./ScheduleMeetingForm.module.css";

interface Props {
  client: MatrixClient;
  /** Prefill for the date field, as a "YYYY-MM-DD" value. */
  initialDate?: string;
  /** Prefill for the time field, as an "HH:MM" value. */
  initialTime?: string;
  /** Meeting length to preselect, in minutes. */
  initialDurationMinutes?: number;
  /** Renders a dismiss action, and drops the card's own surface. */
  onDone?: () => void;
}

// Mirrors the HTML5 email input semantics: a non-empty local part, an "@",
// and a dotted domain. Good enough for client-side guarding; the server is
// the source of truth.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// How long the copy button reports success before returning to its label.
const COPIED_MS = 2000;

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

// "Europe/Amsterdam" reads as "Amsterdam". The full identifier stays available
// as the element's title, and in the override control.
function shortTimezone(timezone: string): string {
  return timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
}

type FieldName = "name" | "email" | "date" | "time" | "organizer";
type Errors = Partial<Record<FieldName, string>>;

interface SuccessResult {
  meetLink: string;
  email: string;
  start: number;
  durationMinutes: number;
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
  onDone,
}) => {
  const { t, i18n } = useTranslation();
  const calendar = Config.get().calendar;
  const durationOptions =
    calendar?.duration_options ?? CALENDAR_DEFAULTS.duration_options;
  const reminderOptions =
    calendar?.reminder_options ?? CALENDAR_DEFAULTS.reminder_options;

  const [inviteeName, setInviteeName] = useState("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  // True when the organizer email was derived from the logged-in account's
  // email threepid, in which case it is shown rather than asked for.
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

  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>(
    {},
  );
  const [submitError, setSubmitError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SuccessResult>();
  const [copied, setCopied] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useSetting(scheduleAdvancedOpen);

  const nameId = useId();
  const emailId = useId();
  const dateId = useId();
  const timeId = useId();
  const organizerId = useId();
  const whenLabelId = useId();
  const advancedId = useId();
  const successTitleRef = useRef<HTMLHeadingElement>(null);

  const fieldIds: Record<FieldName, string> = useMemo(
    () => ({
      name: nameId,
      email: emailId,
      date: dateId,
      time: timeId,
      organizer: organizerId,
    }),
    [nameId, emailId, dateId, timeId, organizerId],
  );

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

  // Put the keyboard where the work is. Inside a dialog this is unambiguous;
  // the form is never rendered anywhere it would steal focus from a page.
  useEffect(() => {
    if (result === undefined) return;
    successTitleRef.current?.focus();
  }, [result]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return (): void => clearTimeout(timer);
  }, [copied]);

  const validateField = useCallback(
    (field: FieldName): string | undefined => {
      switch (field) {
        case "name": {
          const name = inviteeName.trim();
          if (name.length < 1 || name.length > 100)
            return t("schedule_meeting.error_name");
          return undefined;
        }
        case "email":
          if (!inviteeEmail.trim())
            return t("schedule_meeting.error_email_missing");
          if (!EMAIL_REGEX.test(inviteeEmail.trim()))
            return t("schedule_meeting.error_email_invalid");
          return undefined;
        case "organizer":
          if (organizerEmail.trim() && !EMAIL_REGEX.test(organizerEmail.trim()))
            return t("schedule_meeting.error_email_invalid");
          return undefined;
        case "date": {
          if (!date) return t("schedule_meeting.error_date");
          // The year is inferred forwards, so a complete date is never behind
          // us; only a same-day time can be, and that is the time field's.
          return undefined;
        }
        case "time":
          if (!time) return t("schedule_meeting.error_time");
          if (date) {
            const start = parseStart(date, time);
            if (start === undefined) return t("schedule_meeting.error_time");
            if (start <= Date.now())
              return t("schedule_meeting.error_past_date");
          }
          return undefined;
      }
    },
    [inviteeName, inviteeEmail, organizerEmail, date, time, t],
  );

  // Validate on blur once a field has been used, and thereafter on every
  // change while it is showing an error, so a correction clears immediately.
  const revalidate = useCallback(
    (field: FieldName): void => {
      setErrors((current) => {
        if (!touched[field] && current[field] === undefined) return current;
        const message = validateField(field);
        if (current[field] === message) return current;
        const next = { ...current };
        if (message === undefined) delete next[field];
        else next[field] = message;
        return next;
      });
    },
    [touched, validateField],
  );

  useEffect(() => {
    revalidate("name");
  }, [inviteeName, revalidate]);
  useEffect(() => {
    revalidate("email");
  }, [inviteeEmail, revalidate]);
  useEffect(() => {
    revalidate("date");
  }, [date, revalidate]);
  useEffect(() => {
    revalidate("time");
  }, [time, revalidate]);
  useEffect(() => {
    revalidate("organizer");
  }, [organizerEmail, revalidate]);

  const onFieldBlur = useCallback((field: FieldName): void => {
    setTouched((current) =>
      current[field] === true ? current : { ...current, [field]: true },
    );
  }, []);

  const reset = useCallback((): void => {
    setInviteeName("");
    setInviteeEmail("");
    if (!organizerEmailDerived) setOrganizerEmail("");
    setDate("");
    setTime("");
    setErrors({});
    setTouched({});
    setDuration(
      calendar?.default_duration_minutes ??
        CALENDAR_DEFAULTS.default_duration_minutes,
    );
    setReminder(
      calendar?.default_reminder_minutes ??
        CALENDAR_DEFAULTS.default_reminder_minutes,
    );
  }, [organizerEmailDerived, calendar]);

  const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      setSubmitError(undefined);

      const fields: FieldName[] = [
        "name",
        "email",
        "date",
        "time",
        "organizer",
      ];
      const found: Errors = {};
      for (const field of fields) {
        const message = validateField(field);
        if (message !== undefined) found[field] = message;
      }
      setTouched(Object.fromEntries(fields.map((f) => [f, true])));
      setErrors(found);

      const firstInvalid = fields.find((field) => found[field] !== undefined);
      if (firstInvalid !== undefined) {
        document.getElementById(fieldIds[firstInvalid])?.focus();
        return;
      }

      const start = parseStart(date, time);
      if (start === undefined) return; // guarded above; defensive
      // Bound here rather than read inside submit(): a hoisted function
      // declaration does not carry the narrowing above into its body.
      const startMs: number = start;
      const end = startMs + duration * 60000;
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
        scheduled_start: startMs,
        scheduled_end: end,
        organizer_name: organizerName,
        organizer_user_id: organizerUserId,
        organizer_email: organizerEmail.trim() || undefined,
        prospect_name: name,
        prospect_email: inviteeEmail.trim(),
        timezone,
        reminder_minutes: reminder,
      };

      if (!navigator.onLine) {
        setSubmitError(t("schedule_meeting.error_offline"));
        return;
      }

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
        setResult({
          meetLink: json.meet_link ?? "",
          email: body.prospect_email,
          start: startMs,
          durationMinutes: duration,
        });
        reset();
      }

      submit()
        .catch((err: unknown) => {
          // The cause belongs in the log, not in front of someone who cannot
          // act on "Missing access token".
          logger.error("Failed to schedule meeting", err);
          setSubmitError(t("schedule_meeting.error_submit"));
        })
        .finally(() => setSubmitting(false));
    },
    [
      validateField,
      fieldIds,
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
      t,
    ],
  );

  const onCopyLink = useCallback((): void => {
    if (!result?.meetLink) return;
    navigator.clipboard
      .writeText(result.meetLink)
      .then(() => setCopied(true))
      .catch((err: unknown) => {
        logger.warn("Failed to copy meeting link", err);
      });
  }, [result]);

  // "45 min", "1 h" — the shape a chip can carry without wrapping.
  const shortLength = useCallback(
    (minutes: number): string =>
      minutes >= 60 && minutes % 60 === 0
        ? t("schedule_meeting.hours_short", { count: minutes / 60 })
        : t("schedule_meeting.minutes_short", { count: minutes }),
    [t],
  );

  const chipGroup = (
    name: string,
    legend: string,
    options: number[],
    value: number,
    onChange: (value: number) => void,
    labelFor: (minutes: number) => string,
    describedBy?: string,
  ): ReactNode => (
    <fieldset className={styles.chips} aria-describedby={describedBy}>
      <legend className={styles.chipsLegend}>{legend}</legend>
      {options.map((option) => {
        const id = `${name}-${option}`;
        return (
          <span key={option}>
            <input
              className={styles.chipInput}
              type="radio"
              id={id}
              name={name}
              checked={value === option}
              disabled={submitting}
              onChange={() => onChange(option)}
            />
            <label className={styles.chip} htmlFor={id}>
              {labelFor(option)}
              <span className={styles.offscreen}>
                {" "}
                {t("schedule_meeting.minutes", { count: option })}
              </span>
            </label>
          </span>
        );
      })}
    </fieldset>
  );

  if (result !== undefined) {
    const when = new Date(result.start);
    return (
      <div className={styles.wrapper}>
        <div
          className={
            onDone ? `${styles.container} ${styles.bare}` : styles.container
          }
        >
          <div className={styles.success} role="status">
            <Heading
              as="h3"
              size="sm"
              weight="semibold"
              className={styles.successTitle}
              tabIndex={-1}
              ref={successTitleRef}
            >
              <CheckCircleSolidIcon className={styles.successIcon} />
              {t("schedule_meeting.success_title")}
            </Heading>
            <Text size="sm">
              {t("schedule_meeting.success_detail", { email: result.email })}
            </Text>
            <Text size="sm" weight="medium">
              {t("schedule_meeting.success_when", {
                date: when.toLocaleDateString(i18n.language),
                time: when.toLocaleTimeString(i18n.language, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle:
                    (calendar?.time_display_24h ??
                    CALENDAR_DEFAULTS.time_display_24h)
                      ? "h23"
                      : undefined,
                }),
                duration: shortLength(result.durationMinutes),
              })}
            </Text>
            {result.meetLink && (
              <div className={styles.group}>
                <span className={styles.groupLabel}>
                  {t("schedule_meeting.link_label")}
                </span>
                <div className={styles.linkRow}>
                  <Text
                    size="sm"
                    className={styles.link}
                    title={result.meetLink}
                  >
                    {result.meetLink}
                  </Text>
                  <Button
                    kind="secondary"
                    size="sm"
                    onClick={onCopyLink}
                    Icon={copied ? CheckIcon : undefined}
                  >
                    {copied
                      ? t("schedule_meeting.copied")
                      : t("schedule_meeting.copy_link")}
                  </Button>
                </div>
              </div>
            )}
            <div className={styles.successActions}>
              <Button
                kind="secondary"
                onClick={() => {
                  setResult(undefined);
                  setCopied(false);
                }}
              >
                {t("schedule_meeting.schedule_another")}
              </Button>
              {onDone && (
                <Button onClick={onDone}>{t("schedule_meeting.done")}</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div
        className={
          onDone ? `${styles.container} ${styles.bare}` : styles.container
        }
      >
        <Heading size="sm" weight="semibold" className={styles.title}>
          {t("schedule_meeting.title")}
        </Heading>
        <form
          className={styles.form}
          onSubmit={onSubmit}
          aria-busy={submitting}
        >
          <InputField
            id={nameId}
            name="inviteeName"
            type="text"
            required
            label={t("schedule_meeting.name_label")}
            placeholder={t("schedule_meeting.name_label")}
            value={inviteeName}
            disabled={submitting}
            description={errors.name}
            onChange={(e) => setInviteeName(e.target.value)}
            onBlur={() => onFieldBlur("name")}
          />

          <div className={styles.group}>
            <InputField
              id={emailId}
              name="inviteeEmail"
              type="email"
              required
              label={t("schedule_meeting.email_label")}
              placeholder={t("schedule_meeting.email_label")}
              value={inviteeEmail}
              disabled={submitting}
              description={errors.email}
              onChange={(e) => setInviteeEmail(e.target.value)}
              onBlur={() => onFieldBlur("email")}
            />
            {errors.email === undefined && (
              <p className={styles.help}>{t("schedule_meeting.email_help")}</p>
            )}
          </div>

          <div className={styles.group}>
            <span className={styles.groupLabel} id={whenLabelId}>
              {t("schedule_meeting.when_label")}
            </span>
            <div
              className={styles.when}
              role="group"
              aria-labelledby={whenLabelId}
            >
              <DateField
                id={dateId}
                value={date}
                onChange={setDate}
                onBlur={() => onFieldBlur("date")}
                error={errors.date}
                disabled={submitting}
              />
              <TimeField
                id={timeId}
                value={time}
                onChange={setTime}
                onBlur={() => onFieldBlur("time")}
                error={errors.time}
                disabled={submitting}
              />
            </div>
          </div>

          {chipGroup(
            "duration",
            t("schedule_meeting.length_label"),
            durationOptions,
            duration,
            setDuration,
            shortLength,
          )}

          <p className={styles.context}>
            {t("schedule_meeting.context_timezone", {
              timezone: shortTimezone(timezone),
            })}
            {organizerEmail &&
              ` ${t("schedule_meeting.context_organizer", { email: organizerEmail })}`}
          </p>

          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <ChevronDownIcon
              width={16}
              height={16}
              className={
                advancedOpen
                  ? `${styles.disclosureIcon} ${styles.disclosureIconOpen}`
                  : styles.disclosureIcon
              }
            />
            {advancedOpen
              ? t("schedule_meeting.fewer_options")
              : t("schedule_meeting.more_options")}
          </button>

          {/* Mounted only while open, so nothing is hidden but still
          focusable; aria-expanded already carries the state. */}
          {advancedOpen && (
            <div id={advancedId} className={styles.advanced}>
              <div className={styles.group}>
                {chipGroup(
                  "reminder",
                  t("schedule_meeting.reminder"),
                  [0, ...reminderOptions],
                  reminder,
                  setReminder,
                  (minutes) =>
                    minutes === 0
                      ? t("schedule_meeting.reminder_none")
                      : shortLength(minutes),
                )}
                <p className={styles.help}>
                  {t("schedule_meeting.reminder_help")}
                </p>
              </div>

              <div className={styles.group}>
                <label className={styles.groupLabel} htmlFor="scheduleTimezone">
                  {t("schedule_meeting.timezone")}
                </label>
                {/* Native rather than a menu component: a list this long is
                only usable with the type-ahead a native select gives free, and
                on a phone it opens the system wheel. */}
                <select
                  id="scheduleTimezone"
                  className={styles.select}
                  value={timezone}
                  disabled={submitting}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {timezoneOptions.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
                <p className={styles.help}>
                  {t("schedule_meeting.timezone_help")}
                </p>
              </div>

              {!organizerEmailDerived && (
                <div className={styles.group}>
                  <InputField
                    id={organizerId}
                    name="organizerEmail"
                    type="email"
                    label={t("schedule_meeting.organizer_label")}
                    placeholder={t("schedule_meeting.organizer_label")}
                    value={organizerEmail}
                    disabled={submitting}
                    description={errors.organizer}
                    onChange={(e) => setOrganizerEmail(e.target.value)}
                    onBlur={() => onFieldBlur("organizer")}
                  />
                  <p className={styles.help}>
                    {t("schedule_meeting.organizer_help")}
                  </p>
                </div>
              )}
            </div>
          )}

          {submitError !== undefined && (
            <p className={styles.error} role="alert">
              {submitError}
            </p>
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
