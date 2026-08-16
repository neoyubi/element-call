import { type FC, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Text } from "@vector-im/compound-web";
import { Link } from "react-router-dom";
import VideoCallIcon from "@vector-im/compound-design-tokens/assets/web/icons/video-call";

import { Config } from "../config/Config";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";
import { getRelativeRoomUrl } from "../utils/matrix";
import { formatRelativeStart } from "../calendar/dates";
import { now$ } from "../calendar/now";
import { useBehavior } from "../useBehavior";
import { type ScheduledMeeting } from "./useScheduledMeetings";
import styles from "./NextUp.module.css";

// How early the join affordance is emphasised, when the deployment has not
// said otherwise.
const DEFAULT_EARLY_JOIN_MINUTES = 5;

interface Props {
  meetings: ScheduledMeeting[];
  loading: boolean;
}

/**
 * The one meeting worth looking at right now.
 *
 * This renders even with nothing scheduled: an empty page teaches nobody what
 * the page is for, and holding the space is what makes scheduling the obvious
 * next move.
 */
export const NextUp: FC<Props> = ({ meetings, loading }) => {
  const { t } = useTranslation();
  const now = useBehavior(now$);

  // The list keeps a meeting for an hour after it starts, so the first entry
  // may already be over; take the first one that has not ended.
  const meeting = meetings.find((m) => now < m.scheduledEnd) ?? meetings[0];

  if (loading) return <Skeleton />;
  if (meeting === undefined)
    return (
      <Section>
        <div className={styles.empty}>
          <Text size="md">{t("home.nothing_scheduled")}</Text>
          <Text size="sm" className={styles.emptyDetail}>
            {t("home.nothing_scheduled_detail")}
          </Text>
        </div>
      </Section>
    );

  return <Card meeting={meeting} now={now} />;
};

const Section: FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  return (
    <section className={styles.section} aria-label={t("home.next_up")}>
      <Text as="h2" size="sm" weight="semibold" className={styles.heading}>
        {t("home.next_up")}
      </Text>
      {children}
    </section>
  );
};

const Skeleton: FC = () => (
  <Section>
    <div className={styles.skeleton} />
  </Section>
);

const Card: FC<{ meeting: ScheduledMeeting; now: number }> = ({
  meeting,
  now,
}) => {
  const { t, i18n } = useTranslation();
  const roomEncryptionSystem = useRoomEncryptionSystem(meeting.room.roomId);

  const earlyJoinMs =
    (Config.get().branding?.early_join_minutes ?? DEFAULT_EARLY_JOIN_MINUTES) *
    60000;
  const ended = now >= meeting.scheduledEnd;
  const joinable = meeting.scheduledStart - now <= earlyJoinMs;

  const relative = formatRelativeStart(
    i18n.language,
    t,
    meeting.scheduledStart,
    now,
  );
  const minutes = Math.round(
    (meeting.scheduledEnd - meeting.scheduledStart) / 60000,
  );
  const length =
    minutes >= 60 && minutes % 60 === 0
      ? t("schedule_meeting.hours_short", { count: minutes / 60 })
      : t("schedule_meeting.minutes_short", { count: minutes });
  const when = `${ended ? t("meetings.ended") : relative.text} · ${length}`;
  const urgent = !ended && relative.urgent;

  // Say once, and only once, that the meeting has become joinable. A relative
  // time that re-announces itself every minute is hostile.
  const announced = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (ended || !joinable || announced.current) return;
    announced.current = true;
    setAnnouncement(t("meetings.starting_now", { name: meeting.roomName }));
  }, [ended, joinable, meeting.roomName, t]);

  return (
    <Section>
      <div className={styles.card}>
        <div className={styles.details}>
          <Text size="md" weight="semibold" className={styles.name}>
            {meeting.roomName}
          </Text>
          <Text
            size="sm"
            className={urgent ? styles.urgent : styles.when}
            data-urgent={urgent || undefined}
          >
            {when}
          </Text>
        </div>
        {/* Present whatever the clock says: someone who needs the room early
        must be able to open it. Only the emphasis changes. */}
        <Button
          as={Link}
          to={getRelativeRoomUrl(
            meeting.room.roomId,
            roomEncryptionSystem,
            meeting.room.name,
          )}
          kind={joinable && !ended ? "primary" : "secondary"}
          size="sm"
          Icon={VideoCallIcon}
        >
          {t("meetings.join")}
        </Button>
      </div>
      <span role="status" aria-live="polite" className={styles.offscreen}>
        {announcement}
      </span>
    </Section>
  );
};
