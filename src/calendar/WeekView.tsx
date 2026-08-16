import {
  type CSSProperties,
  type FC,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { IconButton, Text } from "@vector-im/compound-web";
import { PlusIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
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
  /** Whether this user may open the scheduling form from a free slot. */
  canSchedule: boolean;
  onSelectDay: (date: Date) => void;
  onSelectMeeting: (meeting: ScheduledMeeting) => void;
  onSelectSlot: (start: Date) => void;
}

/**
 * A time grid: hours down the side, one column per day, meetings drawn to
 * scale and split into columns where they overlap.
 */
export const WeekView: FC<Props> = ({
  days,
  focusedDate,
  meetings,
  canSchedule,
  onSelectDay,
  onSelectMeeting,
  onSelectSlot,
}) => {
  const { t, i18n } = useTranslation();
  const now = useBehavior(now$);
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const hours = workingHours();
  // Clicking inside an hour picks a start time to the nearest meeting length
  // on offer, so the granularity follows whatever a deployment offers.
  const slotMinutes = Math.min(
    ...(Config.get().calendar?.duration_options ??
      CALENDAR_DEFAULTS.duration_options),
  );

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
  // the whole 24 hours stay scrollable. The day headings stay put, so the
  // offset is measured against one day's rows rather than the whole grid.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const dayStart = hours.start;
  useEffect(() => {
    const scroller = scrollerRef.current;
    const column = columnRef.current;
    if (scroller === null || column === null) return;
    scroller.scrollTop = (column.clientHeight * dayStart) / 24;
  }, [dayStart]);

  const onSlotClick = useCallback(
    (day: Date, hour: number, e: MouseEvent<HTMLButtonElement>): void => {
      const box = e.currentTarget.getBoundingClientRect();
      // Keyboard activation reports no coordinates, which lands on the hour.
      const offset = box.height > 0 ? (e.clientY - box.top) / box.height : 0;
      const minute =
        Math.floor(Math.min(Math.max(offset, 0), 1) * (60 / slotMinutes)) *
        slotMinutes;
      onSelectSlot(
        new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          hour,
          minute,
        ),
      );
    },
    [onSelectSlot, slotMinutes],
  );

  const today = new Date(now);
  const nowMinute = today.getHours() * 60 + today.getMinutes();

  return (
    <div
      className={styles.week}
      ref={scrollerRef}
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
            {canSchedule && (
              <IconButton
                size="var(--cpd-space-11x)"
                aria-label={t("calendar.schedule_on", {
                  date: formatDay(i18n.language, day),
                })}
                onClick={() =>
                  onSelectSlot(
                    new Date(
                      day.getFullYear(),
                      day.getMonth(),
                      day.getDate(),
                      hours.start,
                    ),
                  )
                }
              >
                <PlusIcon />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      <div className={styles.grid}>
        <div className={styles.gutter} aria-hidden>
          {HOURS.map((hour) => (
            <span key={hour} className={styles.hourLabel}>
              {formatHour(i18n.language, hour)}
            </span>
          ))}
        </div>
        {columns.map((day, dayIndex) => (
          <div
            key={day.getTime()}
            className={styles.column}
            ref={dayIndex === 0 ? columnRef : undefined}
          >
            {HOURS.map((hour) => (
              <div
                key={hour}
                className={classNames(styles.slot, {
                  [styles.offHours]: hour < hours.start || hour >= hours.end,
                })}
              >
                {canSchedule && (
                  <button
                    type="button"
                    className={styles.slotButton}
                    // Twenty-four tab stops per day would bury every other
                    // control, so the button in the day header is the keyboard
                    // route to the same form.
                    tabIndex={-1}
                    aria-label={t("calendar.schedule_at", {
                      date: formatDay(i18n.language, day),
                      time: formatHour(i18n.language, hour),
                    })}
                    onClick={(e) => onSlotClick(day, hour, e)}
                  />
                )}
              </div>
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
