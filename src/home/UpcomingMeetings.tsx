import {
  type FC,
  useState,
  useMemo,
  useCallback,
  type MouseEvent,
  type ChangeEvent,
  type FormEvent,
  type FormEventHandler,
} from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Text, IconButton } from "@vector-im/compound-web";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DeleteIcon,
  EditIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import { Link } from "react-router-dom";
import { logger } from "matrix-js-sdk/lib/logger";

import {
  cancelMeeting,
  rescheduleMeeting,
  useScheduledMeetings,
  type ScheduledMeeting,
} from "./useScheduledMeetings";
import { useSetting, showMeetingsCalendar } from "../settings/settings";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";
import { getRelativeRoomUrl } from "../utils/matrix";
import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
import { formatMonth, formatRelativeStart, isSameDay } from "../calendar/dates";
import { MonthView } from "../calendar/MonthView";
import { now$ } from "../calendar/now";
import { useBehavior } from "../useBehavior";
import { useCanSchedule } from "./useCanSchedule";
import { parseStart, formatDate, formatTime } from "./dateFormat";
import styles from "./UpcomingMeetings.module.css";

interface UpcomingMeetingsProps {
  client: MatrixClient;
}

// Initial value for the duration select: the meeting's stored duration when
// it matches one of the offered options, else the configured default.
function initialDuration(
  meeting: ScheduledMeeting,
  options: readonly number[],
  fallback: number,
): number {
  const minutes = Math.round(
    (meeting.scheduledEnd - meeting.scheduledStart) / 60000,
  );
  return options.includes(minutes) ? minutes : fallback;
}

interface MeetingTileProps {
  meeting: ScheduledMeeting;
  client: MatrixClient;
  canModify: boolean;
}

const MeetingTile: FC<MeetingTileProps> = ({ meeting, client, canModify }) => {
  const { t, i18n } = useTranslation();
  const calendar = Config.get().calendar;
  const durationOptions =
    calendar?.duration_options ?? CALENDAR_DEFAULTS.duration_options;
  const defaultDuration =
    calendar?.default_duration_minutes ??
    CALENDAR_DEFAULTS.default_duration_minutes;
  const roomEncryptionSystem = useRoomEncryptionSystem(meeting.room.roomId);
  const now = useBehavior(now$);
  const { text, urgent } = formatRelativeStart(
    i18n.language,
    t,
    meeting.scheduledStart,
    now,
  );
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState<number>(defaultDuration);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string>();

  const onDeleteClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setConfirming(true);
    setEditing(false);
  }, []);

  const onConfirmDelete = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setDeleting(true);
      cancelMeeting(client, meeting.room).catch((err: unknown) => {
        logger.error("Failed to cancel meeting", err);
        setDeleting(false);
        setConfirming(false);
      });
    },
    [meeting.room, client],
  );

  const onCancelDelete = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setConfirming(false);
  }, []);

  const onEditClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setConfirming(false);
      setEditError(undefined);
      setDate(formatDate(meeting.scheduledStart));
      setTime(formatTime(meeting.scheduledStart));
      setDuration(initialDuration(meeting, durationOptions, defaultDuration));
      setEditing(true);
    },
    [meeting, durationOptions, defaultDuration],
  );

  const onCancelEdit = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditing(false);
    setEditError(undefined);
  }, []);

  const onSaveEdit: FormEventHandler<HTMLFormElement> = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const start = parseStart(date, time);
      if (start === undefined) {
        setEditError(t("schedule_meeting.error_required"));
        return;
      }
      if (start <= Date.now()) {
        setEditError(t("schedule_meeting.error_past_date"));
        return;
      }
      setEditError(undefined);

      setSaving(true);
      rescheduleMeeting(client, meeting.room.roomId, {
        scheduled_start: start,
        scheduled_end: start + duration * 60000,
        timezone: meeting.timezone,
      })
        // The tile refreshes itself when the updated state event syncs down.
        .then(() => setEditing(false))
        .catch((err: unknown) => {
          logger.error("Failed to reschedule meeting", err);
          setEditError(t("meetings.update_failed"));
        })
        .finally(() => setSaving(false));
    },
    [date, time, duration, meeting.timezone, meeting.room.roomId, client, t],
  );

  if (deleting) return null;

  return (
    <div className={styles.meetingItem}>
      <div className={styles.meetingTile}>
        <Link
          to={getRelativeRoomUrl(
            meeting.room.roomId,
            roomEncryptionSystem,
            meeting.room.name,
          )}
          className={styles.meetingLink}
        >
          <div className={styles.meetingInfo}>
            <Text size="sm" weight="semibold" className={styles.meetingName}>
              {meeting.roomName}
            </Text>
            <Text
              size="xs"
              className={urgent ? styles.meetingTimeUrgent : styles.meetingTime}
            >
              {text}
            </Text>
          </div>
        </Link>
        {canModify &&
          (confirming ? (
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmYes}
                onClick={onConfirmDelete}
                type="button"
              >
                {t("meetings.delete")}
              </button>
              <button
                className={styles.confirmNo}
                onClick={onCancelDelete}
                type="button"
              >
                {t("meetings.cancel")}
              </button>
            </div>
          ) : (
            <>
              <IconButton
                size="24px"
                onClick={onEditClick}
                aria-label={t("meetings.edit_meeting")}
                className={styles.editButton}
              >
                <EditIcon width={16} height={16} />
              </IconButton>
              <IconButton
                size="24px"
                onClick={onDeleteClick}
                aria-label={t("meetings.delete_meeting")}
                className={styles.deleteButton}
              >
                <DeleteIcon width={16} height={16} />
              </IconButton>
            </>
          ))}
      </div>
      {canModify && editing && (
        <form className={styles.editRow} onSubmit={onSaveEdit}>
          <div className={styles.editFields}>
            <input
              type="date"
              className={styles.editInput}
              aria-label={t("schedule_meeting.date")}
              value={date}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setDate(e.target.value)
              }
            />
            <input
              type="time"
              className={styles.editInput}
              aria-label={t("schedule_meeting.time")}
              value={time}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setTime(e.target.value)
              }
            />
            <select
              className={styles.editSelect}
              aria-label={t("schedule_meeting.duration")}
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
          {editError && <p className={styles.editError}>{editError}</p>}
          <div className={styles.editActions}>
            <button className={styles.editSave} type="submit" disabled={saving}>
              {saving ? t("meetings.saving") : t("meetings.save")}
            </button>
            <button
              className={styles.confirmNo}
              onClick={onCancelEdit}
              type="button"
            >
              {t("meetings.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export const UpcomingMeetings: FC<UpcomingMeetingsProps> = ({ client }) => {
  const { t, i18n } = useTranslation();
  const { meetings } = useScheduledMeetings(client);
  const canSchedule = useCanSchedule(client);
  const [showCalendar, setShowCalendar] = useSetting(showMeetingsCalendar);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState<Date>(() => new Date());

  const toggleCalendar = useCallback(() => {
    setShowCalendar(!showCalendar);
  }, [showCalendar, setShowCalendar]);

  const onSelectDay = useCallback((date: Date): void => {
    setSelectedDate((current) =>
      current !== null && isSameDay(current, date) ? null : date,
    );
  }, []);

  const stepMonth = useCallback((months: number): void => {
    setViewMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + months, 1),
    );
  }, []);

  const filteredMeetings = useMemo(() => {
    if (!selectedDate) return meetings;
    return meetings.filter((m) =>
      isSameDay(new Date(m.scheduledStart), selectedDate),
    );
  }, [meetings, selectedDate]);

  if (meetings.length === 0) return null;

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        <div className={styles.header}>
          <Text size="sm" weight="semibold" className={styles.headerTitle}>
            {t("meetings.upcoming")}
          </Text>
          <IconButton
            size="24px"
            onClick={toggleCalendar}
            aria-label={
              showCalendar
                ? t("meetings.hide_calendar")
                : t("meetings.show_calendar")
            }
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              {showCalendar ? (
                <path
                  d="M2.5 5.5L8 11l5.5-5.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M2.5 10.5L8 5l5.5 5.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </IconButton>
        </div>
        {showCalendar ? (
          <>
            <div className={styles.calendar}>
              <div className={styles.monthHeader}>
                <Text size="sm" weight="semibold">
                  {formatMonth(i18n.language, viewMonth)}
                </Text>
                <div className={styles.monthNav}>
                  <IconButton
                    size="var(--cpd-space-11x)"
                    aria-label={t("calendar.previous")}
                    onClick={() => stepMonth(-1)}
                  >
                    <ChevronLeftIcon />
                  </IconButton>
                  <IconButton
                    size="var(--cpd-space-11x)"
                    aria-label={t("calendar.next")}
                    onClick={() => stepMonth(1)}
                  >
                    <ChevronRightIcon />
                  </IconButton>
                </div>
              </div>
              <MonthView
                compact
                focusedDate={viewMonth}
                meetings={meetings}
                selectedDate={selectedDate}
                onSelectDay={onSelectDay}
                onFocusDate={(date) =>
                  setViewMonth(new Date(date.getFullYear(), date.getMonth(), 1))
                }
              />
            </div>
            <div className={styles.meetingsList}>
              {filteredMeetings.map((meeting) => (
                <MeetingTile
                  key={meeting.room.roomId}
                  meeting={meeting}
                  client={client}
                  canModify={canSchedule}
                />
              ))}
            </div>
          </>
        ) : (
          <Text
            size="sm"
            className={styles.collapsedText}
            onClick={toggleCalendar}
          >
            {t("meetings.count", { count: meetings.length })}
          </Text>
        )}
      </div>
    </div>
  );
};
