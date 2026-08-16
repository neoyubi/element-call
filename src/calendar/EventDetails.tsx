import {
  type ChangeEvent,
  type FC,
  type FormEvent,
  type FormEventHandler,
  useCallback,
  useId,
  useState,
} from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Button, Text } from "@vector-im/compound-web";
import {
  CopyIcon,
  VideoCallIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import { Link } from "react-router-dom";
import { logger } from "matrix-js-sdk/lib/logger";

import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
import {
  cancelMeeting,
  rescheduleMeeting,
  type ScheduledMeeting,
} from "../home/useScheduledMeetings";
import { formatDate, formatTime, parseStart } from "../home/dateFormat";
import { formatDay, formatTimeOfDay } from "./dates";
import styles from "./EventDetails.module.css";

interface Props {
  meeting: ScheduledMeeting;
  client: MatrixClient;
  /** Whether this user may move or cancel the meeting. */
  canModify: boolean;
  /** Called once the meeting has been moved or cancelled. */
  onDone: () => void;
}

/**
 * Everything known about one meeting, and what can be done with it. Rendered
 * inside a modal, which is a drawer on a touchscreen.
 */
export const EventDetails: FC<Props> = ({
  meeting,
  client,
  canModify,
  onDone,
}) => {
  const { t, i18n } = useTranslation();
  const durationOptions =
    Config.get().calendar?.duration_options ??
    CALENDAR_DEFAULTS.duration_options;

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(0);
  const dateId = useId();
  const timeId = useId();
  const durationId = useId();

  const onEdit = useCallback((): void => {
    setError(undefined);
    setConfirming(false);
    setDate(formatDate(meeting.scheduledStart));
    setTime(formatTime(meeting.scheduledStart));
    setDuration(
      Math.round((meeting.scheduledEnd - meeting.scheduledStart) / 60000),
    );
    setEditing(true);
  }, [meeting]);

  const onSave: FormEventHandler<HTMLFormElement> = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const start = parseStart(date, time);
      if (start === undefined) {
        setError(t("schedule_meeting.error_required"));
        return;
      }
      if (start <= Date.now()) {
        setError(t("schedule_meeting.error_past_date"));
        return;
      }
      setError(undefined);
      setBusy(true);
      rescheduleMeeting(client, meeting.room.roomId, {
        scheduled_start: start,
        scheduled_end: start + duration * 60000,
        timezone: meeting.timezone,
      })
        .then(onDone)
        .catch((err: unknown) => {
          logger.error("Failed to reschedule meeting", err);
          setError(t("meetings.update_failed"));
        })
        .finally(() => setBusy(false));
    },
    [client, date, time, duration, meeting, onDone, t],
  );

  const onCancelMeeting = useCallback((): void => {
    setBusy(true);
    cancelMeeting(client, meeting.room)
      .then(onDone)
      .catch((err: unknown) => {
        logger.error("Failed to cancel meeting", err);
        setError(t("meetings.update_failed"));
        setBusy(false);
      });
  }, [client, meeting.room, onDone, t]);

  const onCopyLink = useCallback((): void => {
    navigator.clipboard.writeText(meeting.meetLink).catch((err: unknown) => {
      logger.warn("Failed to copy meeting link", err);
    });
  }, [meeting.meetLink]);

  const viewerTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const joinPath = joinRoute(meeting.meetLink);

  return (
    <div className={styles.details}>
      <div className={styles.summary}>
        <Text size="lg" weight="semibold">
          {meeting.roomName}
        </Text>
        <Text size="md" className={styles.when}>
          {formatDay(i18n.language, new Date(meeting.scheduledStart))}
          {" · "}
          {formatTimeOfDay(i18n.language, meeting.scheduledStart)}
          {" – "}
          {formatTimeOfDay(i18n.language, meeting.scheduledEnd)}
        </Text>
        {meeting.timezone !== viewerTimezone && (
          <Text size="sm" className={styles.note}>
            {t("calendar.scheduled_in_zone", { timezone: meeting.timezone })}
          </Text>
        )}
        {meeting.organizerName !== "" && (
          <Text size="sm" className={styles.note}>
            {t("calendar.organized_by", { name: meeting.organizerName })}
          </Text>
        )}
      </div>

      <div className={styles.actions}>
        {joinPath !== undefined && (
          <Button as={Link} to={joinPath} size="sm" Icon={VideoCallIcon}>
            {t("calendar.join")}
          </Button>
        )}
        {meeting.meetLink !== "" && (
          <Button
            kind="secondary"
            size="sm"
            Icon={CopyIcon}
            onClick={onCopyLink}
          >
            {t("calendar.copy_join_link")}
          </Button>
        )}
      </div>

      {canModify && !editing && !confirming && (
        <div className={styles.actions}>
          <Button kind="secondary" size="sm" onClick={onEdit}>
            {t("calendar.reschedule")}
          </Button>
          <Button
            kind="secondary"
            size="sm"
            destructive
            onClick={() => setConfirming(true)}
          >
            {t("calendar.cancel_meeting")}
          </Button>
        </div>
      )}

      {canModify && editing && (
        <form className={styles.form} onSubmit={onSave}>
          <div className={styles.fields}>
            <label className={styles.field} htmlFor={dateId}>
              <Text size="sm" className={styles.note}>
                {t("schedule_meeting.date")}
              </Text>
              <input
                id={dateId}
                type="date"
                className={styles.input}
                value={date}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setDate(e.target.value)
                }
              />
            </label>
            <label className={styles.field} htmlFor={timeId}>
              <Text size="sm" className={styles.note}>
                {t("schedule_meeting.time")}
              </Text>
              <input
                id={timeId}
                type="time"
                className={styles.input}
                value={time}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setTime(e.target.value)
                }
              />
            </label>
            <label className={styles.field} htmlFor={durationId}>
              <Text size="sm" className={styles.note}>
                {t("schedule_meeting.duration")}
              </Text>
              <select
                id={durationId}
                className={styles.input}
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
            </label>
          </div>
          <div className={styles.actions}>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? t("meetings.saving") : t("meetings.save")}
            </Button>
            <Button
              type="button"
              kind="secondary"
              size="sm"
              onClick={() => setEditing(false)}
            >
              {t("meetings.cancel")}
            </Button>
          </div>
        </form>
      )}

      {canModify && confirming && (
        <div className={styles.confirm}>
          <Text size="sm">{t("calendar.cancel_confirm")}</Text>
          <div className={styles.actions}>
            <Button
              size="sm"
              destructive
              disabled={busy}
              onClick={onCancelMeeting}
            >
              {t("calendar.cancel_meeting")}
            </Button>
            <Button
              kind="secondary"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              {t("calendar.keep_meeting")}
            </Button>
          </div>
        </div>
      )}

      {error !== undefined && (
        <Text size="sm" className={styles.error} role="alert">
          {error}
        </Text>
      )}
    </div>
  );
};

/**
 * The join link as an in-app route, so joining does not reload the whole app.
 * The link is never rebuilt from parts: it carries the room's own key.
 */
function joinRoute(meetLink: string): string | undefined {
  try {
    const url = new URL(meetLink);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}
