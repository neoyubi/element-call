import { type FC, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button, Text } from "@vector-im/compound-web";
import {
  CopyIcon,
  VideoCallIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import { Link } from "react-router-dom";
import { logger } from "matrix-js-sdk/lib/logger";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { formatDay, formatTimeOfDay } from "./dates";
import styles from "./EventDetails.module.css";

interface Props {
  meeting: ScheduledMeeting;
}

/**
 * Everything known about one meeting, and what can be done with it. Rendered
 * inside a modal, which is a drawer on a touchscreen.
 */
export const EventDetails: FC<Props> = ({ meeting }) => {
  const { t, i18n } = useTranslation();

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
