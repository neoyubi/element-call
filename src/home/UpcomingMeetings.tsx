import { type FC, useState, useMemo, useCallback, type MouseEvent } from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Text, IconButton } from "@vector-im/compound-web";
import { DeleteIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import { Link } from "react-router-dom";
import { logger } from "matrix-js-sdk/lib/logger";

import { useScheduledMeetings, type ScheduledMeeting } from "./useScheduledMeetings";
import { useSetting, showMeetingsCalendar } from "../settings/settings";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";
import { getRelativeRoomUrl } from "../utils/matrix";
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

  if (startDate.getDate() === tomorrow.getDate() &&
    startDate.getMonth() === tomorrow.getMonth()) {
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

interface MeetingTileProps {
  meeting: ScheduledMeeting;
  client: MatrixClient;
}

const MeetingTile: FC<MeetingTileProps> = ({ meeting, client }) => {
  const { t } = useTranslation();
  const roomEncryptionSystem = useRoomEncryptionSystem(meeting.room.roomId);
  const { text, urgent } = formatRelativeTime(meeting.scheduledStart, t);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onDeleteClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setConfirming(true);
    },
    [],
  );

  const onConfirmDelete = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setDeleting(true);
      const room = meeting.room;
      const myUserId = client.getUserId()!;
      const members = room.getJoinedMembers();
      const kickAll = members
        .filter((m) => m.userId !== myUserId)
        .map((m) =>
          client.kick(room.roomId, m.userId).catch((err: unknown) => {
            logger.error(`Failed to kick ${m.userId}`, err);
          }),
        );
      void Promise.all(kickAll)
        .then(async () => {
          await client.leave(room.roomId);
          logger.info(`Deleted meeting room ${room.roomId}`);
        })
        .catch((err: unknown) => {
          logger.error("Failed to delete meeting room", err);
          setDeleting(false);
          setConfirming(false);
        });
    },
    [meeting.room, client],
  );

  const onCancelDelete = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setConfirming(false);
    },
    [],
  );

  if (deleting) return null;

  return (
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
      {confirming ? (
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
        <IconButton
          size="24px"
          onClick={onDeleteClick}
          aria-label={t("meetings.delete_meeting")}
          className={styles.deleteButton}
        >
          <DeleteIcon width={16} height={16} />
        </IconButton>
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
  const meetings = useScheduledMeetings(client);
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
                <MeetingTile key={meeting.room.roomId} meeting={meeting} client={client} />
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
