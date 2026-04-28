import { type FC, useMemo, useCallback } from "react";
import { Text, IconButton } from "@vector-im/compound-web";
import classNames from "classnames";

import { type ScheduledMeeting } from "./useScheduledMeetings";
import styles from "./MiniCalendar.module.css";

interface MiniCalendarProps {
  meetings: ScheduledMeeting[];
  selectedDate: Date | null;
  onSelectDate: (date: Date | null) => void;
  viewMonth: Date;
  onChangeMonth: (date: Date) => void;
}

const WEEK_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getMonthDays(
  year: number,
  month: number,
): { date: Date; currentMonth: boolean }[] {
  const result: { date: Date; currentMonth: boolean }[] = [];
  const firstDay = new Date(year, month, 1);
  // Monday = 0, Sunday = 6
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  // Fill leading days from previous month
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    result.push({ date: d, currentMonth: false });
  }

  // Current month days
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let i = 1; i <= daysInMonth; i++) {
    result.push({ date: new Date(year, month, i), currentMonth: true });
  }

  // Fill trailing days to complete grid (up to 42 = 6 rows)
  const remaining = 42 - result.length;
  for (let i = 1; i <= remaining; i++) {
    result.push({ date: new Date(year, month + 1, i), currentMonth: false });
  }

  // Trim to 5 rows if possible (35 cells)
  if (result.length > 35 && !result[35].currentMonth) {
    result.splice(35);
  }

  return result;
}

export const MiniCalendar: FC<MiniCalendarProps> = ({
  meetings,
  selectedDate,
  onSelectDate,
  viewMonth,
  onChangeMonth,
}) => {
  const today = useMemo(() => new Date(), []);
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();

  const days = useMemo(() => getMonthDays(year, month), [year, month]);

  // Set of day strings (YYYY-MM-DD) that have meetings
  const meetingDays = useMemo(() => {
    const daySet = new Set<string>();
    for (const m of meetings) {
      const d = new Date(m.scheduledStart);
      daySet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
    return daySet;
  }, [meetings]);

  const prevMonth = useCallback(() => {
    onChangeMonth(new Date(year, month - 1, 1));
  }, [year, month, onChangeMonth]);

  const nextMonth = useCallback(() => {
    onChangeMonth(new Date(year, month + 1, 1));
  }, [year, month, onChangeMonth]);

  const onDayClick = useCallback(
    (date: Date) => {
      if (selectedDate && isSameDay(selectedDate, date)) {
        onSelectDate(null); // Toggle off
      } else {
        onSelectDate(date);
      }
    },
    [selectedDate, onSelectDate],
  );

  const monthName = viewMonth.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className={styles.calendar}>
      <div className={styles.header}>
        <Text size="sm" weight="semibold" className={styles.headerTitle}>
          {monthName}
        </Text>
        <div className={styles.navButtons}>
          <IconButton size="24px" onClick={prevMonth} aria-label="Previous month">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </IconButton>
          <IconButton size="24px" onClick={nextMonth} aria-label="Next month">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 12l4-4-4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </IconButton>
        </div>
      </div>
      <div className={styles.weekDays}>
        {WEEK_DAYS.map((d) => (
          <span key={d} className={styles.weekDay}>
            {d}
          </span>
        ))}
      </div>
      <div className={styles.days}>
        {days.map(({ date, currentMonth }, i) => {
          const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
          const isToday = isSameDay(date, today);
          const isSelected = selectedDate !== null && isSameDay(date, selectedDate);
          const hasMeeting = meetingDays.has(dayKey);

          return (
            <button
              key={i}
              type="button"
              className={classNames(styles.day, {
                [styles.today]: isToday,
                [styles.selected]: isSelected,
                [styles.hasMeeting]: hasMeeting,
                [styles.otherMonth]: !currentMonth,
              })}
              onClick={() => onDayClick(date)}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
};
