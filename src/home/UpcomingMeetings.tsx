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
  DeleteIcon,
  EditIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import { Link } from "react-router-dom";
import { logger } from "matrix-js-sdk/lib/logger";

import {
  useScheduledMeetings,
  type ScheduledMeeting,
} from "./useScheduledMeetings";
import { useSetting, showMeetingsCalendar } from "../settings/settings";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";
import { getRelativeRoomUrl } from "../utils/matrix";
import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
import { useCanSchedule } from "./useCanSchedule";
import { parseStart, formatDate, formatTime } from "./dateFormat";
import { MiniCalendar } from "./MiniCalendar";
import styles from "./UpcomingMeetings.module.css";

interface UpcomingMeetingsProps {
  client: MatrixClient;
}

function formatRelativeTime(
  scheduledStart: number,
  t: (key: string, options?: Record<string, string>) => string,
): { text: string; urgent: boolean } {
  const now = Date.now();
  const diff = scheduledStart - now;

  if (diff <= 0) {
    return { text: t("meetings.in_progress"), urgent: true };
  }

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);

  if (minutes < 60) {
    return {
      text: t("meetings.starts_in", { time: `${minutes}m` }),
      urgent: true,
    };
  }

  const startDate = new Date(scheduledStart);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = startDate.toLocaleTimeString("default", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (hours < 24 && startDate.getDate() === today.getDate()) {
    return {
      text: t("meetings.today_at", { time: timeStr }),
      urgent: false,
    };
  }

  if (
    startDate.getDate() === tomorrow.getDate() &&
    startDate.getMonth() === tomorrow.getMonth()
  ) {
    return {
      text: t("meetings.tomorrow_at", { time: timeStr }),
      urgent: false,
    };
  }

  const dateStr = startDate.toLocaleDateString("default", {
    month: "short",
    day: "numeric",
  });
  return {
    text: t("meetings.date_at", { date: dateStr, time: timeStr }),
    urgent: false,
  };
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
  const { t } = useTranslation();
  const calendar = Config.get().calendar;
  const durationOptions =
    calendar?.duration_options ?? CALENDAR_DEFAULTS.duration_options;
  const defaultDuration =
    calendar?.default_duration_minutes ??
    CALENDAR_DEFAULTS.default_duration_minutes;
  const roomEncryptionSystem = useRoomEncryptionSystem(meeting.room.roomId);
  const { text, urgent } = formatRelativeTime(meeting.scheduledStart, t);
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
      const room = meeting.room;
      const adminApiUrl = Config.get().admin_api_url;

      // Preferred path: cancel through the admin API, which emits the
      // calendar cancellation and purges the room server-side.
      async function deleteViaAdminApi(url: string): Promise<void> {
        const token = client.getAccessToken();
        if (!token) throw new Error("Missing access token");
        const response = await fetch(
          `${url}/api/admin/rooms/${encodeURIComponent(room.roomId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!response.ok)
          throw new Error(`Cancellation failed (${response.status})`);
        logger.info(`Cancelled meeting room ${room.roomId}`);
      }

      // Fallback when no admin API is configured: kick everyone and leave.
      async function deleteViaMatrix(): Promise<void> {
        const myUserId = client.getUserId()!;
        const members = room.getJoinedMembers();
        const kickAll = members
          .filter((m) => m.userId !== myUserId)
          .map(async (m) => {
            try {
              await client.kick(room.roomId, m.userId);
            } catch (err) {
              logger.error(`Failed to kick ${m.userId}`, err);
            }
          });
        await Promise.all(kickAll);
        await client.leave(room.roomId);
        logger.info(`Deleted meeting room ${room.roomId}`);
      }

      void (
        adminApiUrl ? deleteViaAdminApi(adminApiUrl) : deleteViaMatrix()
      ).catch((err: unknown) => {
        logger.error("Failed to delete meeting room", err);
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
        setEditError(t("schedule_meeting.error_date"));
        return;
      }
      if (start <= Date.now()) {
        setEditError(t("schedule_meeting.error_past_date"));
        return;
      }
      setEditError(undefined);

      const body = {
        scheduled_start: start,
        scheduled_end: start + duration * 60000,
        timezone: meeting.timezone,
      };
      const roomId = meeting.room.roomId;

      async function save(): Promise<void> {
        setSaving(true);
        const adminApiUrl = Config.get().admin_api_url;
        if (!adminApiUrl) throw new Error("Scheduling is not configured");
        const token = client.getAccessToken();
        if (!token) throw new Error("Missing access token");

        const response = await fetch(
          `${adminApiUrl}/api/admin/rooms/${encodeURIComponent(roomId)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          },
        );
        if (response.status !== 200)
          throw new Error(`Update failed (${response.status})`);
        // The tile refreshes itself when the updated state event syncs down.
        setEditing(false);
      }

      save()
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
              type="text"
              className={styles.editInput}
              aria-label={t("schedule_meeting.date")}
              placeholder={t("schedule_meeting.date_format")}
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

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export const UpcomingMeetings: FC<UpcomingMeetingsProps> = ({ client }) => {
  const { t } = useTranslation();
  const { meetings } = useScheduledMeetings(client);
  const canSchedule = useCanSchedule(client);
  const [showCalendar, setShowCalendar] = useSetting(showMeetingsCalendar);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState<Date>(() => new Date());

  const toggleCalendar = useCallback(() => {
    setShowCalendar(!showCalendar);
  }, [showCalendar, setShowCalendar]);

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
            <MiniCalendar
              meetings={meetings}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              viewMonth={viewMonth}
              onChangeMonth={setViewMonth}
            />
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
