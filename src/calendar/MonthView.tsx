import {
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@vector-im/compound-web";
import classNames from "classnames";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { useBehavior } from "../useBehavior";
import { EventChip } from "./EventChip";
import { now$ } from "./now";
import {
  addDays,
  firstDayOfWeek,
  formatDay,
  formatDayOfMonth,
  formatMonth,
  isSameDay,
  monthGridDays,
  startOfDay,
  startOfWeek,
  toDateParam,
  visibleEvents,
  weekdayNames,
} from "./dates";
import styles from "./MonthView.module.css";

interface Props {
  /** Any day in the month to show. */
  focusedDate: Date;
  meetings: readonly ScheduledMeeting[];
  /** Dense layout for the home card: a marker per day instead of chips. */
  compact?: boolean;
  selectedDate?: Date | null;
  /** Activating a day cell. */
  onSelectDay: (date: Date) => void;
  onSelectMeeting?: (meeting: ScheduledMeeting) => void;
  /** Arrow keys reaching a day outside the month currently shown. */
  onFocusDate?: (date: Date) => void;
}

/** How many chips fit in a day cell before the rest are summarised. */
const MAX_CHIPS_PER_DAY = 3;

/**
 * A month of day cells, at two densities: the full page grid with event chips,
 * and the compact grid on the home card with a marker per busy day.
 *
 * Keyboard handling follows the grid pattern: one cell is in the tab order at
 * a time, arrows move between cells, and Enter opens the day.
 */
export const MonthView: FC<Props> = ({
  focusedDate,
  meetings,
  compact,
  selectedDate,
  onSelectDay,
  onSelectMeeting,
  onFocusDate,
}) => {
  const { t, i18n } = useTranslation();
  const now = useBehavior(now$);
  const firstDay = firstDayOfWeek(i18n.language);
  const days = useMemo(
    () => monthGridDays(focusedDate, firstDay),
    [focusedDate, firstDay],
  );
  const headers = useMemo(
    () => ({
      short: weekdayNames(i18n.language, firstDay, "short"),
      long: weekdayNames(i18n.language, firstDay, "long"),
    }),
    [i18n.language, firstDay],
  );

  const events = useMemo(
    () =>
      visibleEvents(meetings, days[0], addDays(days[days.length - 1], 1), now),
    [meetings, days, now],
  );
  const eventsByDay = useMemo(() => {
    const grouped: ScheduledMeeting[][] = days.map(() => []);
    for (const event of events) grouped[event.dayIndex].push(event.meeting);
    return grouped;
  }, [events, days]);

  // The cell that holds the tab stop. It follows the focused date, except
  // while the arrow keys are walking the grid.
  const [activeTime, setActiveTime] = useState(() =>
    startOfDay(focusedDate).getTime(),
  );
  const [syncedTime, setSyncedTime] = useState(focusedDate.getTime());
  if (syncedTime !== focusedDate.getTime()) {
    setSyncedTime(focusedDate.getTime());
    setActiveTime(startOfDay(focusedDate).getTime());
  }

  const gridRef = useRef<HTMLDivElement>(null);
  const takeFocus = useRef(false);
  useEffect(() => {
    if (!takeFocus.current) return;
    takeFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(
        `[data-date="${toDateParam(new Date(activeTime))}"]`,
      )
      ?.focus();
  }, [activeTime]);

  const moveTo = useCallback(
    (target: Date): void => {
      takeFocus.current = true;
      if (days.some((day) => isSameDay(day, target)))
        setActiveTime(target.getTime());
      else onFocusDate?.(target);
    },
    [days, onFocusDate],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, day: Date): void => {
      switch (e.key) {
        case "ArrowLeft":
          moveTo(addDays(day, -1));
          break;
        case "ArrowRight":
          moveTo(addDays(day, 1));
          break;
        case "ArrowUp":
          moveTo(addDays(day, -7));
          break;
        case "ArrowDown":
          moveTo(addDays(day, 7));
          break;
        case "Home":
          moveTo(startOfWeek(day, firstDay));
          break;
        case "End":
          moveTo(addDays(startOfWeek(day, firstDay), 6));
          break;
        case "PageUp":
          moveTo(new Date(day.getFullYear(), day.getMonth() - 1, 1));
          break;
        case "PageDown":
          moveTo(new Date(day.getFullYear(), day.getMonth() + 1, 1));
          break;
        case "Enter":
        case " ":
          onSelectDay(day);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [moveTo, firstDay, onSelectDay],
  );

  const month = focusedDate.getMonth();
  const today = new Date(now);

  return (
    <div
      className={classNames(styles.grid, { [styles.compact]: compact })}
      role="grid"
      aria-label={formatMonth(i18n.language, focusedDate)}
      ref={gridRef}
    >
      <div className={styles.weekdays} role="row">
        {headers.short.map((name, i) => (
          <span key={name} className={styles.weekday} role="columnheader">
            <abbr title={headers.long[i]}>{name}</abbr>
          </span>
        ))}
      </div>
      {Array.from({ length: days.length / 7 }, (_, week) => (
        <div key={week} className={styles.week} role="row">
          {days.slice(week * 7, week * 7 + 7).map((day, i) => {
            const dayMeetings = eventsByDay[week * 7 + i];
            return (
              <div
                key={day.getTime()}
                role="gridcell"
                data-date={toDateParam(day)}
                aria-label={formatDay(i18n.language, day)}
                aria-selected={
                  selectedDate == null
                    ? undefined
                    : isSameDay(day, selectedDate)
                }
                tabIndex={day.getTime() === activeTime ? 0 : -1}
                className={classNames(styles.day, {
                  [styles.today]: isSameDay(day, today),
                  [styles.otherMonth]: day.getMonth() !== month,
                  [styles.selected]:
                    selectedDate != null && isSameDay(day, selectedDate),
                })}
                onClick={() => onSelectDay(day)}
                onKeyDown={(e) => onKeyDown(e, day)}
              >
                <span className={styles.dayNumber}>
                  {formatDayOfMonth(i18n.language, day)}
                </span>
                {compact && dayMeetings.length > 0 && (
                  <span className={styles.marker} />
                )}
                {!compact &&
                  onSelectMeeting &&
                  dayMeetings
                    .slice(0, MAX_CHIPS_PER_DAY)
                    .map((meeting) => (
                      <EventChip
                        key={meeting.room.roomId}
                        meeting={meeting}
                        tabIndex={-1}
                        onSelect={onSelectMeeting}
                      />
                    ))}
                {!compact && dayMeetings.length > MAX_CHIPS_PER_DAY && (
                  <Text size="xs" className={styles.more}>
                    {t("calendar.more_meetings", {
                      count: dayMeetings.length - MAX_CHIPS_PER_DAY,
                    })}
                  </Text>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};
