import { type FC, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Heading, Text } from "@vector-im/compound-web";
import { ChevronRightIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { useBehavior } from "../useBehavior";
import { now$ } from "./now";
import {
  addDays,
  formatDay,
  formatRelativeStart,
  formatTimeOfDay,
  visibleEvents,
} from "./dates";
import styles from "./AgendaView.module.css";

interface Props {
  meetings: readonly ScheduledMeeting[];
  /** Local midnight of the first day shown. */
  rangeStart: Date;
  /** Local midnight after the last day shown. */
  rangeEnd: Date;
  onSelectMeeting: (meeting: ScheduledMeeting) => void;
}

/**
 * The meetings of a period as a day-grouped list.
 *
 * This is the primary view on a phone and the linear reading of every other
 * view, so every action the grids offer has to be reachable from here.
 */
export const AgendaView: FC<Props> = ({
  meetings,
  rangeStart,
  rangeEnd,
  onSelectMeeting,
}) => {
  const { t, i18n } = useTranslation();
  const now = useBehavior(now$);

  const days = useMemo(() => {
    const events = visibleEvents(meetings, rangeStart, rangeEnd, now);
    const grouped = new Map<number, typeof events>();
    for (const event of events) {
      const day = grouped.get(event.dayIndex);
      if (day === undefined) grouped.set(event.dayIndex, [event]);
      else day.push(event);
    }
    return [...grouped.entries()].sort(([a], [b]) => a - b);
  }, [meetings, rangeStart, rangeEnd, now]);

  if (days.length === 0)
    return (
      <Text size="md" className={styles.empty}>
        {t("calendar.no_meetings")}
      </Text>
    );

  return (
    <div className={styles.agenda}>
      {days.map(([dayIndex, events]) => (
        <section key={dayIndex} className={styles.day}>
          <Heading as="h2" size="sm" weight="semibold" className={styles.date}>
            {formatDay(i18n.language, addDays(rangeStart, dayIndex))}
          </Heading>
          <ul className={styles.meetings}>
            {events.map((event) => {
              const { text, urgent } = formatRelativeStart(
                i18n.language,
                t,
                event.meeting.scheduledStart,
                now,
              );
              return (
                <li key={event.meeting.room.roomId}>
                  <button
                    type="button"
                    className={styles.meeting}
                    onClick={() => onSelectMeeting(event.meeting)}
                  >
                    <span className={styles.time}>
                      {formatTimeOfDay(
                        i18n.language,
                        event.meeting.scheduledStart,
                      )}
                      <Text size="xs" className={styles.until}>
                        {formatTimeOfDay(
                          i18n.language,
                          event.meeting.scheduledEnd,
                        )}
                      </Text>
                    </span>
                    <span className={styles.details}>
                      <Text size="md" weight="semibold">
                        {event.meeting.roomName}
                      </Text>
                      <Text
                        size="sm"
                        className={classNames(styles.relative, {
                          [styles.urgent]: urgent,
                        })}
                      >
                        {text}
                      </Text>
                    </span>
                    <ChevronRightIcon className={styles.chevron} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
};
