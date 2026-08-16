import {
  type CSSProperties,
  type FC,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { IconButton, Text } from "@vector-im/compound-web";
import {
  PlusIcon,
  TimeIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
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
  atMinute,
  dragRange,
  formatDay,
  formatDayOfMonth,
  formatHour,
  formatLength,
  formatTimeOfDay,
  isSameDay,
  slotSelection,
  snappedMinute,
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

/**
 * How far the pointer must travel before a press counts as a drag, in pixels.
 * Below this a click is just a click, so a slightly unsteady hand still books
 * a meeting of the usual length rather than one slot's worth.
 */
const DRAG_THRESHOLD = 4;

interface WeekCSSProperties extends CSSProperties {
  "--calendar-day-count": number;
}

/** The block drawn under the pointer while a drag is in progress. */
interface DragPreview {
  dayIndex: number;
  startMinute: number;
  endMinute: number;
  /**
   * The column's height when it was last measured. The block is sized and
   * placed in pixels from this rather than in percentages, so that moving it
   * is a transform and resizing it touches nothing but itself.
   */
  columnHeight: number;
}

/** The live state of a press, kept off React so a move costs no render. */
interface Gesture {
  pointerId: number;
  column: HTMLDivElement;
  dayIndex: number;
  /** Minutes from midnight at the top of the slot the press landed in. */
  anchorMinute: number;
  originY: number;
  clientY: number;
  dragging: boolean;
  /** Whether a redraw is already waiting for the next frame. */
  queued: boolean;
  /** The frame to call off if the gesture ends before it arrives. */
  frame: number | null;
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
  /**
   * A time to schedule at, and how long the user asked for by dragging. No
   * length means they picked a moment rather than a span, and the form's own
   * default should stand.
   */
  onSelectSlot: (start: Date, durationMinutes?: number) => void;
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
  // Picking a time inside an hour, by clicking or by dragging, lands on the
  // nearest meeting length on offer, so the granularity follows whatever a
  // deployment offers rather than a number chosen here.
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
      const minute = snappedMinute(
        (hour + Math.min(Math.max(offset, 0), 1)) / 24,
        slotMinutes,
        "floor",
      );
      onSelectSlot(atMinute(day, minute));
    },
    [onSelectSlot, slotMinutes],
  );

  // Dragging down a column draws a meeting of the length being dragged. The
  // press cannot be handled by the slot it started in, because a drag leaves
  // that slot almost immediately; the column owns the gesture and measures
  // against its own box, which spans the whole day.
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  // A drag ends with a click on whatever slot it finished over, which would
  // open the form a second time on the wrong length.
  const swallowClick = useRef(false);

  const measure = useCallback(
    (gesture: Gesture): DragPreview | null => {
      // Read the box every frame rather than caching it at the press: the
      // grid is a scroller and can move under a pointer that is still down.
      const box = gesture.column.getBoundingClientRect();
      if (box.height <= 0) return null;
      const edge = snappedMinute(
        (gesture.clientY - box.top) / box.height,
        slotMinutes,
        "nearest",
      );
      const { startMinute, endMinute } = dragRange(
        gesture.anchorMinute,
        edge,
        slotMinutes,
      );
      return {
        dayIndex: gesture.dayIndex,
        startMinute,
        endMinute,
        columnHeight: box.height,
      };
    },
    [slotMinutes],
  );

  const endGesture = useCallback((): void => {
    const gesture = gestureRef.current;
    if (gesture === null) return;
    gestureRef.current = null;
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    if (gesture.column.hasPointerCapture?.(gesture.pointerId))
      gesture.column.releasePointerCapture(gesture.pointerId);
    setPreview(null);
  }, []);

  const onPointerDown = useCallback(
    (dayIndex: number, e: PointerEvent<HTMLDivElement>): void => {
      swallowClick.current = false;
      if (!canSchedule || e.button !== 0) return;
      // Touch is left alone. The grid scrolls vertically under a finger, and
      // a drag gesture can only have that movement by taking scrolling away
      // from every phone. On touch a tap still opens the form.
      if (e.pointerType === "touch") return;
      // Only empty time starts a drag. The meetings drawn on top of it are
      // buttons of their own, and dragging one is deliberately not a gesture.
      // The mark is read straight off the target rather than through an
      // `instanceof`, which is false in the widget: that runs in an iframe,
      // with element constructors of its own.
      const target = e.target as Partial<HTMLElement>;
      if (target.dataset?.slot === undefined) return;
      const column = e.currentTarget;
      const box = column.getBoundingClientRect();
      if (box.height <= 0) return;
      gestureRef.current = {
        pointerId: e.pointerId,
        column,
        dayIndex,
        anchorMinute: snappedMinute(
          (e.clientY - box.top) / box.height,
          slotMinutes,
          "floor",
        ),
        originY: e.clientY,
        clientY: e.clientY,
        dragging: false,
        queued: false,
        frame: null,
      };
      column.setPointerCapture?.(e.pointerId);
    },
    [canSchedule, slotMinutes],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      const gesture = gestureRef.current;
      if (gesture === null || e.pointerId !== gesture.pointerId) return;
      gesture.clientY = e.clientY;
      if (!gesture.dragging) {
        if (Math.abs(e.clientY - gesture.originY) < DRAG_THRESHOLD) return;
        gesture.dragging = true;
      }
      // Pointer moves arrive far faster than the grid can usefully be
      // redrawn, so at most one redraw is queued per frame. The flag is
      // raised before the frame is asked for rather than after it is handed
      // back, so that the two cannot land out of order.
      if (gesture.queued) return;
      gesture.queued = true;
      gesture.frame = requestAnimationFrame(() => {
        gesture.queued = false;
        if (gestureRef.current === gesture) setPreview(measure(gesture));
      });
    },
    [measure],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      const gesture = gestureRef.current;
      if (gesture === null || e.pointerId !== gesture.pointerId) return;
      gesture.clientY = e.clientY;
      // Measured here rather than read back from the preview, so that the
      // release lands where the pointer is and not where the last frame was.
      const final = gesture.dragging ? measure(gesture) : null;
      endGesture();
      // A press that never moved is left to the slot button underneath, which
      // opens the form at that time on its usual length.
      if (final === null) return;
      swallowClick.current = true;
      const { start, durationMinutes } = slotSelection(
        columns[final.dayIndex],
        final.startMinute,
        final.endMinute,
      );
      onSelectSlot(start, durationMinutes);
    },
    [measure, endGesture, columns, onSelectSlot],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      const gesture = gestureRef.current;
      if (gesture === null || e.pointerId !== gesture.pointerId) return;
      swallowClick.current = true;
      endGesture();
    },
    [endGesture],
  );

  const onClickCapture = useCallback((e: MouseEvent<HTMLDivElement>): void => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  // Escape abandons a drag, the way it backs out of anything else that has
  // taken over the pointer.
  const dragging = preview !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      swallowClick.current = true;
      endGesture();
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => window.removeEventListener("keydown", onKeyDown);
  }, [dragging, endGesture]);

  // A drag interrupted by the grid itself going away leaves a frame owing.
  useEffect(
    () => (): void => {
      const gesture = gestureRef.current;
      if (gesture?.frame != null) cancelAnimationFrame(gesture.frame);
    },
    [],
  );

  // The label reports elapsed time, which is what the form will schedule, and
  // on the day the clocks go forward that is less than the rows it covers.
  const previewSelection = useMemo(
    () =>
      preview === null
        ? null
        : slotSelection(
            columns[preview.dayIndex],
            preview.startMinute,
            preview.endMinute,
          ),
    [preview, columns],
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
      <div className={classNames(styles.grid, { [styles.dragging]: dragging })}>
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
            onPointerDown={(e) => onPointerDown(dayIndex, e)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onClickCapture={onClickCapture}
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
                    // Marks the empty time a drag may start on, so that the
                    // meetings drawn over it can be told apart by their
                    // absence of it rather than by a generated class name.
                    data-slot=""
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
            {preview !== null &&
              previewSelection !== null &&
              preview.dayIndex === dayIndex && (
                <div
                  className={styles.dragBlock}
                  style={{
                    transform: `translateY(${pixels(preview.startMinute, preview.columnHeight)}px)`,
                    blockSize: `${pixels(preview.endMinute - preview.startMinute, preview.columnHeight)}px`,
                  }}
                  aria-hidden
                >
                  <span className={styles.dragLabel}>
                    <TimeIcon className={styles.dragIcon} />
                    {t("calendar.drag_summary", {
                      time: formatTimeOfDay(
                        i18n.language,
                        previewSelection.start,
                      ),
                      length: formatLength(t, previewSelection.durationMinutes),
                    })}
                  </span>
                </div>
              )}
          </div>
        ))}
      </div>
    </div>
  );
};

function percent(minutes: number): string {
  return `${(minutes / MINUTES_PER_DAY) * 100}%`;
}

function pixels(minutes: number, columnHeight: number): number {
  return (minutes / MINUTES_PER_DAY) * columnHeight;
}
