import { type CSSProperties, type FC, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@vector-im/compound-web";
import classNames from "classnames";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { useMediaQuery } from "../useMediaQuery";
import { useBehavior } from "../useBehavior";
import { EventChip } from "./EventChip";
import { now$ } from "./now";
import {
  MINUTES_PER_DAY,
  addDays,
  formatDay,
  formatDayOfMonth,
  formatHour,
  isSameDay,
  startOfDay,
  visibleEvents,
  weekdayNames,
  workingHours,
} from "./dates";
import styles from "./WeekView.module.css";

/**
 * Below this width the grid shows a single day. Seven columns of time in
 * roughly 320px is not a layout problem, it is an unreadable one.
 */
export const NARROW_VIEWPORT = "(max-width: 699px)";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface WeekCSSProperties extends CSSProperties {
  "--calendar-day-count": number;
}

interface Props {
  /** The days to lay out side by side. One day gives the day view. */
  days: readonly Date[];
  /** The day a narrow viewport falls back to. */
  focusedDate: Date;
  meetings: readonly ScheduledMeeting[];
  onSelectDay: (date: Date) => void;
  onSelectMeeting: (meeting: ScheduledMeeting) => void;
}

/**
 * A time grid: hours down the side, one column per day, meetings drawn to
 * scale and split into columns where they overlap.
 */
export const WeekView: FC<Props> = ({
  days,
  focusedDate,
  meetings,
  onSelectDay,
  onSelectMeeting,
}) => {
  const { i18n } = useTranslation();
  const now = useBehavior(now$);
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const hours = workingHours();

  const columns = useMemo(
    () => (narrow ? [startOfDay(focusedDate)] : days.map(startOfDay)),
    [narrow, days, focusedDate],
  );
  const events = useMemo(
    () =>
      visibleEvents(
        meetings,
        columns[0],
        addDays(columns[columns.length - 1], 1),
        now,
      ),
    [meetings, columns, now],
  );
  const weekdays = useMemo(
    () => weekdayNames(i18n.language, columns[0].getDay(), "short"),
    [i18n.language, columns],
  );

  // Open on the working day rather than on midnight, without hiding anything:
  // the whole 24 hours stay scrollable.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dayStart = hours.start;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.scrollTop = (scroller.scrollHeight * dayStart) / 24;
  }, [dayStart]);

  const today = new Date(now);
  const nowMinute = today.getHours() * 60 + today.getMinutes();

  return (
    <div
      className={styles.week}
      style={{ "--calendar-day-count": columns.length } as WeekCSSProperties}
    >
      <div className={styles.headers}>
        <span className={styles.gutterSpacer} />
        {columns.map((day, i) => (
          <div key={day.getTime()} className={styles.header}>
            <button
              type="button"
              className={classNames(styles.headerDay, {
                [styles.headerToday]: isSameDay(day, today),
              })}
              aria-label={formatDay(i18n.language, day)}
              onClick={() => onSelectDay(day)}
            >
              <Text size="xs" className={styles.headerWeekday}>
                {weekdays[i]}
              </Text>
              <Text size="md" weight="semibold">
                {formatDayOfMonth(i18n.language, day)}
              </Text>
            </button>
          </div>
        ))}
      </div>
      <div className={styles.scroller} ref={scrollerRef}>
        <div className={styles.gutter} aria-hidden>
          {HOURS.map((hour) => (
            <span key={hour} className={styles.hourLabel}>
              {formatHour(i18n.language, hour)}
            </span>
          ))}
        </div>
        {columns.map((day, dayIndex) => (
          <div key={day.getTime()} className={styles.column}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className={classNames(styles.slot, {
                  [styles.offHours]: hour < hours.start || hour >= hours.end,
                })}
              />
            ))}
            {isSameDay(day, today) && (
              <div
                className={styles.nowLine}
                style={{ insetBlockStart: percent(nowMinute) }}
                aria-hidden
              />
            )}
            {events
              .filter((event) => event.dayIndex === dayIndex)
              .map((event) => (
                <EventChip
                  key={event.meeting.room.roomId}
                  meeting={event.meeting}
                  block
                  inProgress={event.inProgress}
                  onSelect={onSelectMeeting}
                  style={{
                    insetBlockStart: percent(event.startMinute),
                    blockSize: percent(event.endMinute - event.startMinute),
                    insetInlineStart: `${(event.column / event.columnCount) * 100}%`,
                    inlineSize: `${(1 / event.columnCount) * 100}%`,
                  }}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
};

function percent(minutes: number): string {
  return `${(minutes / MINUTES_PER_DAY) * 100}%`;
}
