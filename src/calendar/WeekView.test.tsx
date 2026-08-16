import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { mockConfig } from "../utils/test";
import { formatDay } from "./dates";
import { NARROW_VIEWPORT, WeekView } from "./WeekView";

process.env.TZ = "Europe/Berlin";

const WEEK = Array.from(
  { length: 7 },
  (_, i) => new Date(2026, 7, 17 + i), // Monday 17 August 2026 onwards
);

function meeting(
  start: Date,
  end: Date,
  roomId = "!a:example.org",
): ScheduledMeeting {
  return {
    room: { roomId },
    roomName: `Meeting ${roomId}`,
    bookingId: roomId,
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

/** Answers the calendar's own width query, and nothing else. */
function setViewport(narrow: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === NARROW_VIEWPORT ? narrow : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as Partial<MediaQueryList> as MediaQueryList) as typeof window.matchMedia;
}

function renderWeek(
  props: Partial<Parameters<typeof WeekView>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <WeekView
      days={WEEK}
      focusedDate={WEEK[2]}
      meetings={[]}
      canSchedule={false}
      onSelectDay={vi.fn()}
      onSelectMeeting={vi.fn()}
      onSelectSlot={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockConfig({ calendar: { day_start_hour: 8, day_end_hour: 18 } });
  setViewport(false);
});

afterEach(() => vi.restoreAllMocks());

describe("WeekView", () => {
  it("shows seven days when there is room", () => {
    const { container } = renderWeek();
    expect(container.querySelectorAll(".column")).toHaveLength(7);
  });

  it("never shows seven columns of time on a narrow viewport", () => {
    setViewport(true);
    const { container } = renderWeek();
    expect(container.querySelectorAll(".column")).toHaveLength(1);
    expect(
      screen.getByLabelText(formatDay(i18n.language, WEEK[2])),
    ).toBeInTheDocument();
  });

  it("shows a single day when given one", () => {
    const { container } = renderWeek({ days: [WEEK[0]] });
    expect(container.querySelectorAll(".column")).toHaveLength(1);
  });

  it("renders the whole day, dimming the hours outside working time", () => {
    const { container } = renderWeek({ days: [WEEK[0]] });
    expect(container.querySelectorAll(".slot")).toHaveLength(24);
    // 00:00-08:00 and 18:00-24:00
    expect(container.querySelectorAll(".offHours")).toHaveLength(14);
  });

  it("follows a different working day from configuration", () => {
    mockConfig({ calendar: { day_start_hour: 6, day_end_hour: 22 } });
    const { container } = renderWeek({ days: [WEEK[0]] });
    expect(container.querySelectorAll(".offHours")).toHaveLength(8);
  });

  it("places a meeting by its wall-clock time and duration", () => {
    const { container } = renderWeek({
      days: [WEEK[0]],
      meetings: [
        meeting(new Date(2026, 7, 17, 9, 0), new Date(2026, 7, 17, 10, 30)),
      ],
    });
    const chip = container.querySelector<HTMLElement>(".block")!;
    expect(chip.style.insetBlockStart).toBe(`${(540 / 1440) * 100}%`);
    expect(chip.style.blockSize).toBe(`${(90 / 1440) * 100}%`);
    expect(chip.style.inlineSize).toBe("100%");
  });

  it("splits overlapping meetings across the column", () => {
    const { container } = renderWeek({
      days: [WEEK[0]],
      meetings: [
        meeting(
          new Date(2026, 7, 17, 9, 0),
          new Date(2026, 7, 17, 10, 0),
          "!a:example.org",
        ),
        meeting(
          new Date(2026, 7, 17, 9, 30),
          new Date(2026, 7, 17, 10, 30),
          "!b:example.org",
        ),
      ],
    });
    const chips = container.querySelectorAll<HTMLElement>(".block");
    expect(chips[0].style.inlineSize).toBe("50%");
    expect(chips[1].style.insetInlineStart).toBe("50%");
  });

  it("offers no way to book a slot without permission", () => {
    const { container } = renderWeek({ days: [WEEK[0]] });
    expect(container.querySelectorAll(".slotButton")).toHaveLength(0);
    expect(screen.queryByLabelText(/^Schedule on/)).not.toBeInTheDocument();
  });

  it("offers a slot per hour, and one per day for the keyboard", async () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    expect(container.querySelectorAll(".slotButton")).toHaveLength(24);

    await userEvent.click(
      screen.getByLabelText(`Schedule on ${formatDay(i18n.language, WEEK[0])}`),
    );
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 7, 17, 8, 0));
  });

  it("opens a day from its heading", async () => {
    const onSelectDay = vi.fn();
    renderWeek({ days: [WEEK[0]], onSelectDay });
    await userEvent.click(
      screen.getByLabelText(formatDay(i18n.language, WEEK[0])),
    );
    expect(onSelectDay).toHaveBeenCalledWith(WEEK[0]);
  });

  it("opens a meeting from its chip", async () => {
    const onSelectMeeting = vi.fn();
    renderWeek({
      days: [WEEK[0]],
      meetings: [
        meeting(new Date(2026, 7, 17, 9, 0), new Date(2026, 7, 17, 10, 0)),
      ],
      onSelectMeeting,
    });
    await userEvent.click(screen.getByText("Meeting !a:example.org"));
    expect(onSelectMeeting).toHaveBeenCalledTimes(1);
  });

  it("is accessible", async () => {
    const { container } = renderWeek({
      canSchedule: true,
      meetings: [
        meeting(new Date(2026, 7, 17, 9, 0), new Date(2026, 7, 17, 10, 0)),
      ],
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
