import { type FC, useCallback, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Text } from "@vector-im/compound-web";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import ChevronRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-right";

import { Modal } from "../Modal";
import { EventDetails } from "../calendar/EventDetails";
import { formatRelativeStart } from "../calendar/dates";
import { now$ } from "../calendar/now";
import { useBehavior } from "../useBehavior";
import { useSetting, homeUpcomingOpen } from "../settings/settings";
import { useCanSchedule } from "./useCanSchedule";
import { type ScheduledMeeting } from "./useScheduledMeetings";
import styles from "./UpcomingMeetings.module.css";

interface Props {
  client: MatrixClient;
  meetings: ScheduledMeeting[];
  /** Already shown on its own; excluded from the list and the count. */
  featured?: ScheduledMeeting;
}

/**
 * The meetings after the next one, behind a count.
 *
 * Rescheduling and cancelling live in the meeting dialog, which the calendar
 * already opens; a tile is a way in rather than a second implementation.
 */
export const UpcomingMeetings: FC<Props> = ({ client, meetings, featured }) => {
  const { t } = useTranslation();
  const canSchedule = useCanSchedule(client);
  const [open, setOpen] = useSetting(homeUpcomingOpen);
  const [selected, setSelected] = useState<ScheduledMeeting | null>(null);

  const rest = meetings.filter((m) => m.bookingId !== featured?.bookingId);

  const onDismiss = useCallback((): void => {
    setSelected(null);
    // The dialog puts focus back on the tile that opened it, which is where it
    // belongs. But that tile is gone once a meeting is cancelled, and focus
    // then falls to the document; catch only that case, after the dialog has
    // had its turn.
    requestAnimationFrame(() => {
      if (
        document.activeElement === null ||
        document.activeElement === document.body
      )
        document.getElementById("home-upcoming-trigger")?.focus();
    });
  }, []);

  if (rest.length === 0) return null;

  return (
    <section className={styles.section}>
      <button
        type="button"
        id="home-upcoming-trigger"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls="home-upcoming"
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon
          width={16}
          height={16}
          className={open ? styles.triggerIconOpen : styles.triggerIcon}
        />
        <Text as="h2" size="sm" weight="semibold">
          {t("meetings.count", { count: rest.length })}
        </Text>
      </button>

      {open && (
        <ul id="home-upcoming" className={styles.list}>
          {rest.map((meeting) => (
            <MeetingTile
              key={meeting.bookingId}
              meeting={meeting}
              onSelect={setSelected}
            />
          ))}
        </ul>
      )}

      <Modal
        title={t("calendar.meeting_details")}
        open={selected !== null}
        onDismiss={onDismiss}
      >
        {selected !== null && (
          <EventDetails
            meeting={selected}
            client={client}
            canModify={canSchedule}
            onDone={onDismiss}
          />
        )}
      </Modal>
    </section>
  );
};

const MeetingTile: FC<{
  meeting: ScheduledMeeting;
  onSelect: (meeting: ScheduledMeeting) => void;
}> = ({ meeting, onSelect }) => {
  const { t, i18n } = useTranslation();
  const now = useBehavior(now$);
  const { text, urgent } = formatRelativeStart(
    i18n.language,
    t,
    meeting.scheduledStart,
    now,
  );

  return (
    <li>
      <button
        type="button"
        className={styles.tile}
        // Read as one thing, rather than a name and a time in sequence.
        aria-label={t("home.meeting_tile_label", {
          name: meeting.roomName,
          time: text,
        })}
        onClick={() => onSelect(meeting)}
      >
        <span className={styles.tileName}>{meeting.roomName}</span>
        <span className={urgent ? styles.tileTimeUrgent : styles.tileTime}>
          {text}
        </span>
        <ChevronRightIcon width={20} height={20} aria-hidden />
      </button>
    </li>
  );
};
