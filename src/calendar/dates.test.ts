import { afterEach, describe, expect, it, vi } from "vitest";
import { type TFunction } from "i18next";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import {
  MINUTES_PER_DAY,
  addDays,
  daysBetween,
  dragRange,
  formatLength,
  fromDateParam,
  isSameDay,
  monthGridDays,
  resolveFirstDayOfWeek,
  slotSelection,
  snappedMinute,
  startOfDay,
  startOfWeek,
  stepDate,
  toDateParam,
  viewRange,
  visibleEvents,
  weekdayNames,
} from "./dates";

// Pinned to a zone with daylight saving so the transition days are real:
// 29 March 2026 is 23 hours long and 25 October 2026 is 25 hours long.
process.env.TZ = "Europe/Berlin";

const MONDAY = 1;
const SUNDAY = 0;

function meeting(
  start: Date,
  end: Date,
  id = "!a:example.org",
): ScheduledMeeting {
  return {
    room: { roomId: id },
    roomName: id,
    bookingId: id,
    scheduledStart: start.getTime(),
    scheduledEnd: end.getTime(),
    organizerName: "",
    prospectName: "",
    practiceType: "solo",
    timezone: "UTC",
    isAdmin: false,
    meetLink: "",
  } as unknown as ScheduledMeeting;
}

/** Replaces Intl.Locale while leaving the rest of Intl alone. */
function withLocaleClass(Locale: unknown): void {
  vi.stubGlobal("Intl", Object.create(Intl, { Locale: { value: Locale } }));
}

afterEach(() => vi.unstubAllGlobals());

describe("month grid", () => {
  it("pads a month that starts on a Sunday back to the previous Monday", () => {
    const days = monthGridDays(new Date(2026, 1, 10), MONDAY);
    expect(days).toHaveLength(35);
    expect(toDateParam(days[0])).toBe("2026-01-26");
    expect(toDateParam(days[34])).toBe("2026-03-01");
  });

  it("starts the same month on the Sunday when the week does", () => {
    const days = monthGridDays(new Date(2026, 1, 10), SUNDAY);
    expect(toDateParam(days[0])).toBe("2026-02-01");
  });

  it("includes the extra day of a leap February", () => {
    const days = monthGridDays(new Date(2024, 1, 1), MONDAY);
    expect(days.map(toDateParam)).toContain("2024-02-29");
  });

  it("produces local midnights across a daylight saving change", () => {
    const days = monthGridDays(new Date(2026, 2, 1), MONDAY);
    expect(days.map(toDateParam)).toContain("2026-03-29");
    for (const day of days) {
      expect(day.getHours()).toBe(0);
      expect(day.getMinutes()).toBe(0);
    }
  });
});

describe("week boundaries", () => {
  it("starts on Monday", () => {
    expect(toDateParam(startOfWeek(new Date(2026, 7, 20), MONDAY))).toBe(
      "2026-08-17",
    );
  });

  it("starts on Sunday", () => {
    expect(toDateParam(startOfWeek(new Date(2026, 7, 20), SUNDAY))).toBe(
      "2026-08-16",
    );
  });

  it("counts calendar days across a daylight saving change", () => {
    expect(daysBetween(new Date(2026, 2, 28), new Date(2026, 2, 30))).toBe(2);
    expect(daysBetween(new Date(2026, 9, 24), new Date(2026, 9, 26))).toBe(2);
  });

  it("names weekdays from the first day of the week", () => {
    expect(weekdayNames("en-GB", MONDAY, "long")[0]).toBe("Monday");
    expect(weekdayNames("en-GB", SUNDAY, "long")[0]).toBe("Sunday");
    expect(weekdayNames("de-DE", MONDAY, "long")[0]).toBe("Montag");
  });
});

describe("first day of the week", () => {
  it("takes a named day literally", () => {
    expect(resolveFirstDayOfWeek("monday", "en-GB")).toBe(1);
    expect(resolveFirstDayOfWeek("sunday", "en-US")).toBe(0);
    expect(resolveFirstDayOfWeek("saturday", "en-GB")).toBe(6);
  });

  it("asks the locale when told to", () => {
    withLocaleClass(
      class {
        public getWeekInfo(): { firstDay: number } {
          return { firstDay: 7 };
        }
      },
    );
    expect(resolveFirstDayOfWeek("auto", "en-US")).toBe(0);
  });

  it("accepts the shape that exposes week data as a property", () => {
    withLocaleClass(
      class {
        public get weekInfo(): { firstDay: number } {
          return { firstDay: 6 };
        }
      },
    );
    expect(resolveFirstDayOfWeek("auto", "fa-IR")).toBe(6);
  });

  it("falls back to the ISO week where there is no week data", () => {
    withLocaleClass(class {});
    expect(resolveFirstDayOfWeek("auto", "en-GB")).toBe(1);
  });

  it("falls back to the ISO week for an unusable language tag", () => {
    withLocaleClass(
      class {
        public constructor() {
          throw new RangeError("bad tag");
        }
      },
    );
    expect(resolveFirstDayOfWeek("auto", "not a tag")).toBe(1);
  });
});

describe("event positioning", () => {
  const day = new Date(2026, 2, 29);
  const nextDay = new Date(2026, 2, 30);

  it("puts a 10:00 meeting on the 10:00 row of a 23-hour day", () => {
    const start = new Date(2026, 2, 29, 10, 0);
    const [event] = visibleEvents(
      [meeting(start, new Date(2026, 2, 29, 11, 0))],
      day,
      nextDay,
      0,
    );
    expect(event.startMinute).toBe(600);
    // The elapsed time since midnight is an hour short, which is exactly the
    // answer a difference of two instants would have given.
    expect((start.getTime() - day.getTime()) / 60000).toBe(540);
  });

  it("puts a 10:00 meeting on the 10:00 row of a 25-hour day", () => {
    const fallBack = new Date(2026, 9, 25);
    const start = new Date(2026, 9, 25, 10, 0);
    const [event] = visibleEvents(
      [meeting(start, new Date(2026, 9, 25, 11, 0))],
      fallBack,
      new Date(2026, 9, 26),
      0,
    );
    expect(event.startMinute).toBe(600);
    expect((start.getTime() - fallBack.getTime()) / 60000).toBe(660);
  });

  it("splits three overlapping meetings into three columns", () => {
    const events = visibleEvents(
      [
        meeting(
          new Date(2026, 7, 20, 9, 0),
          new Date(2026, 7, 20, 10, 0),
          "!a",
        ),
        meeting(
          new Date(2026, 7, 20, 9, 15),
          new Date(2026, 7, 20, 10, 15),
          "!b",
        ),
        meeting(
          new Date(2026, 7, 20, 9, 30),
          new Date(2026, 7, 20, 10, 30),
          "!c",
        ),
      ],
      new Date(2026, 7, 20),
      new Date(2026, 7, 21),
      0,
    );
    expect(events.map((e) => e.column)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.columnCount)).toEqual([3, 3, 3]);
  });

  it("leaves meetings that do not overlap at full width", () => {
    const events = visibleEvents(
      [
        meeting(
          new Date(2026, 7, 20, 9, 0),
          new Date(2026, 7, 20, 10, 0),
          "!a",
        ),
        meeting(
          new Date(2026, 7, 20, 10, 0),
          new Date(2026, 7, 20, 11, 0),
          "!b",
        ),
      ],
      new Date(2026, 7, 20),
      new Date(2026, 7, 21),
      0,
    );
    expect(events.map((e) => e.columnCount)).toEqual([1, 1]);
    expect(events.map((e) => e.column)).toEqual([0, 0]);
  });

  it("reuses a column freed by an earlier meeting", () => {
    const events = visibleEvents(
      [
        meeting(
          new Date(2026, 7, 20, 9, 0),
          new Date(2026, 7, 20, 11, 0),
          "!a",
        ),
        meeting(
          new Date(2026, 7, 20, 9, 30),
          new Date(2026, 7, 20, 10, 0),
          "!b",
        ),
        meeting(
          new Date(2026, 7, 20, 10, 0),
          new Date(2026, 7, 20, 10, 30),
          "!c",
        ),
      ],
      new Date(2026, 7, 20),
      new Date(2026, 7, 21),
      0,
    );
    expect(events.map((e) => e.column)).toEqual([0, 1, 1]);
    expect(events.map((e) => e.columnCount)).toEqual([2, 2, 2]);
  });

  it("clips a meeting that runs past midnight into its own day", () => {
    const events = visibleEvents(
      [meeting(new Date(2026, 7, 20, 23, 0), new Date(2026, 7, 21, 0, 30))],
      new Date(2026, 7, 20),
      new Date(2026, 7, 22),
      0,
    );
    expect(events).toHaveLength(1);
    expect(events[0].dayIndex).toBe(0);
    expect(events[0].startMinute).toBe(1380);
    expect(events[0].endMinute).toBe(1440);
  });

  it("drops meetings outside the window", () => {
    const events = visibleEvents(
      [meeting(new Date(2026, 7, 19, 9, 0), new Date(2026, 7, 19, 10, 0))],
      new Date(2026, 7, 20),
      new Date(2026, 7, 21),
      0,
    );
    expect(events).toEqual([]);
  });

  it("marks a meeting that is running", () => {
    const now = new Date(2026, 7, 20, 9, 30).getTime();
    const [event] = visibleEvents(
      [meeting(new Date(2026, 7, 20, 9, 0), new Date(2026, 7, 20, 10, 0))],
      new Date(2026, 7, 20),
      new Date(2026, 7, 21),
      now,
    );
    expect(event.inProgress).toBe(true);
  });
});

describe("view windows", () => {
  const focused = new Date(2026, 7, 20);

  it("covers one day", () => {
    const { start, end } = viewRange("day", focused, MONDAY);
    expect(daysBetween(start, end)).toBe(1);
  });

  it("covers one week from its first day", () => {
    const { start, end } = viewRange("week", focused, MONDAY);
    expect(toDateParam(start)).toBe("2026-08-17");
    expect(daysBetween(start, end)).toBe(7);
  });

  it("covers whole weeks for a month", () => {
    const { start, end } = viewRange("month", focused, MONDAY);
    expect(daysBetween(start, end) % 7).toBe(0);
  });

  it("covers the calendar month for an agenda", () => {
    const { start, end } = viewRange("agenda", focused, MONDAY);
    expect(toDateParam(start)).toBe("2026-08-01");
    expect(toDateParam(end)).toBe("2026-09-01");
  });

  it("steps by the unit the view shows", () => {
    expect(toDateParam(stepDate("day", focused, 1))).toBe("2026-08-21");
    expect(toDateParam(stepDate("week", focused, -1))).toBe("2026-08-13");
    expect(toDateParam(stepDate("month", focused, 1))).toBe("2026-09-01");
    expect(toDateParam(stepDate("agenda", focused, -1))).toBe("2026-07-01");
  });
});

describe("dates in the URL", () => {
  it("round-trips", () => {
    const date = new Date(2026, 7, 20);
    expect(fromDateParam(toDateParam(date))?.getTime()).toBe(date.getTime());
  });

  it("rejects anything that is not a date", () => {
    expect(fromDateParam(null)).toBeUndefined();
    expect(fromDateParam("")).toBeUndefined();
    expect(fromDateParam("20-08-2026")).toBeUndefined();
    expect(fromDateParam("2026-02-31")).toBeUndefined();
  });
});

describe("day helpers", () => {
  it("keeps the time of day when moving across a clock change", () => {
    const before = new Date(2026, 2, 28, 10, 0);
    expect(addDays(before, 1).getHours()).toBe(10);
  });

  it("compares calendar days rather than instants", () => {
    expect(
      isSameDay(new Date(2026, 7, 20, 0, 0), new Date(2026, 7, 20, 23, 59)),
    ).toBe(true);
    expect(
      isSameDay(new Date(2026, 7, 20, 23, 59), new Date(2026, 7, 21, 0, 0)),
    ).toBe(false);
  });

  it("truncates to local midnight", () => {
    expect(startOfDay(new Date(2026, 7, 20, 13, 45)).getHours()).toBe(0);
  });
});

describe("slot geometry", () => {
  it("puts a press in the slot it landed in, and an edge on the nearest", () => {
    // Half way down the 10:00 row of a 24 hour column.
    expect(snappedMinute(10.5 / 24, 15, "floor")).toBe(630);
    // A shade past 11:37, which the pointer is nearer to 11:45 than 11:30.
    expect(snappedMinute(11.63 / 24, 15, "nearest")).toBe(705);
    expect(snappedMinute(11.51 / 24, 15, "floor")).toBe(690);
  });

  it("follows the granularity it is given rather than a fixed one", () => {
    expect(snappedMinute(10.9 / 24, 30, "floor")).toBe(630);
    expect(snappedMinute(10.9 / 24, 60, "floor")).toBe(600);
    expect(snappedMinute(10.9 / 24, 5, "floor")).toBe(650);
  });

  it("never reads a position off the ends of the day", () => {
    expect(snappedMinute(-3, 15, "floor")).toBe(0);
    expect(snappedMinute(4, 15, "nearest")).toBe(MINUTES_PER_DAY);
  });

  it("grows a dragged block downwards from the slot pressed", () => {
    expect(dragRange(630, 690, 15)).toEqual({
      startMinute: 630,
      endMinute: 690,
    });
  });

  it("grows a dragged block upwards, keeping the slot pressed inside it", () => {
    expect(dragRange(630, 540, 15)).toEqual({
      startMinute: 540,
      endMinute: 645,
    });
  });

  it("is never shorter than one slot, however still the pointer is", () => {
    expect(dragRange(630, 630, 15)).toEqual({
      startMinute: 630,
      endMinute: 645,
    });
    expect(dragRange(630, 638, 15)).toEqual({
      startMinute: 630,
      endMinute: 645,
    });
  });

  it("clamps a block to the day rather than spilling into the next", () => {
    expect(dragRange(1425, MINUTES_PER_DAY, 15)).toEqual({
      startMinute: 1425,
      endMinute: MINUTES_PER_DAY,
    });
    // A press on the very last pixel of the column still has a slot to fill.
    expect(dragRange(MINUTES_PER_DAY, MINUTES_PER_DAY, 15)).toEqual({
      startMinute: 1425,
      endMinute: MINUTES_PER_DAY,
    });
    expect(dragRange(60, -120, 15)).toEqual({ startMinute: 0, endMinute: 75 });
  });

  it("reads a start and a length off an ordinary day", () => {
    expect(slotSelection(new Date(2026, 7, 17), 630, 690)).toEqual({
      start: new Date(2026, 7, 17, 10, 30),
      durationMinutes: 60,
    });
  });

  it("measures a block over the hour the clocks skip as the time it lasts", () => {
    // 29 March 2026 has no 02:00-03:00 locally. Three rows of the grid from
    // 01:00 to 04:00 are two hours of meeting, and it has to end at 04:00.
    expect(slotSelection(new Date(2026, 2, 29), 60, 240)).toEqual({
      start: new Date(2026, 2, 29, 1, 0),
      durationMinutes: 120,
    });
  });

  it("measures a block over the hour the clocks repeat as the time it lasts", () => {
    // 25 October 2026 runs 02:00-03:00 twice, so the same three rows are four
    // hours of meeting.
    expect(slotSelection(new Date(2026, 9, 25), 60, 240)).toEqual({
      start: new Date(2026, 9, 25, 1, 0),
      durationMinutes: 240,
    });
  });

  it("ends a block drawn to the foot of the column at midnight", () => {
    const { start, durationMinutes } = slotSelection(
      new Date(2026, 7, 17),
      1380,
      MINUTES_PER_DAY,
    );
    expect(start).toEqual(new Date(2026, 7, 17, 23, 0));
    expect(durationMinutes).toBe(60);
  });
});

describe("formatLength", () => {
  // The keys and their counts are the contract; the English they render is
  // asserted where the label is drawn.
  const t = ((key: string, options: Record<string, number>) =>
    `${key} ${JSON.stringify(options)}`) as unknown as TFunction<"app">;

  it("reports a length under an hour in minutes", () => {
    expect(formatLength(t, 45)).toBe(
      'schedule_meeting.minutes_short {"count":45}',
    );
  });

  it("reports a whole number of hours as hours", () => {
    expect(formatLength(t, 120)).toBe(
      'schedule_meeting.hours_short {"count":2}',
    );
  });

  it("reports hours and minutes through one key, not two joined", () => {
    expect(formatLength(t, 105)).toBe(
      'schedule_meeting.hours_minutes_short {"count":1,"minutes":45}',
    );
  });
});
