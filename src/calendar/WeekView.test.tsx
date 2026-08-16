import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { mockConfig } from "../utils/test";
import { MINUTES_PER_DAY, formatDay } from "./dates";
import { NARROW_VIEWPORT, WeekView } from "./WeekView";

// Pinned to a zone with daylight saving so the transition days are real:
// 29 March 2026 is 23 hours long and 25 October 2026 is 25 hours long.
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

/**
 * jsdom has no PointerEvent and no pointer capture, so the gesture is played
 * out with mouse events carrying the pointer fields the component reads.
 */
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientY: number,
  { pointerType = "mouse", pointerId = 1, button = 0 } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY,
    button,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  return event;
}

/**
 * Gives every day column a box one pixel per minute tall, so that a clientY
 * in these tests reads directly as minutes from midnight.
 */
function measureColumns(container: HTMLElement): void {
  for (const column of container.querySelectorAll<HTMLElement>(".column"))
    column.getBoundingClientRect = (): DOMRect =>
      ({ top: 0, height: MINUTES_PER_DAY }) as DOMRect;
}

/** Presses on a slot, drags to `toY`, and releases. */
function drag(
  container: HTMLElement,
  fromY: number,
  toY: number,
  options?: { pointerType?: string },
): void {
  measureColumns(container);
  const column = container.querySelector<HTMLElement>(".column")!;
  const slot =
    container.querySelectorAll<HTMLElement>(".slotButton")[
      Math.floor(fromY / 60)
    ];
  act(() => {
    fireEvent(slot, pointer("pointerdown", fromY, options));
    fireEvent(column, pointer("pointermove", toY, options));
    fireEvent(column, pointer("pointerup", toY, options));
  });
}

beforeEach(() => {
  mockConfig({ calendar: { day_start_hour: 8, day_end_hour: 18 } });
  setViewport(false);
  // The preview is redrawn on an animation frame; the tests want it now.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("books the length dragged out, across an hour boundary", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    // Half way down the 10:00 row, pulled to 11:30.
    drag(container, 630, 690);
    expect(onSelectSlot).toHaveBeenCalledWith(
      new Date(2026, 7, 17, 10, 30),
      60,
    );
  });

  it("grows the block above the press when dragged upwards", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    // Pressed at 10:30 and pulled back to 09:00: the slot pressed on stays in.
    drag(container, 630, 540);
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 7, 17, 9, 0), 105);
  });

  it("snaps to the shortest meeting the deployment offers", () => {
    mockConfig({
      calendar: {
        day_start_hour: 8,
        day_end_hour: 18,
        duration_options: [30, 60],
      },
    });
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    drag(container, 620, 700);
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 7, 17, 10, 0), 90);
  });

  it("leaves a press that does not move to open the form as a click does", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    measureColumns(container);
    const slot = container.querySelectorAll<HTMLElement>(".slotButton")[10];
    act(() => {
      fireEvent(slot, pointer("pointerdown", 630));
      // A pixel of shake is not a drag.
      fireEvent(slot, pointer("pointerup", 631));
    });
    expect(onSelectSlot).not.toHaveBeenCalled();

    fireEvent.click(slot);
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 7, 17, 10, 0));
    // No length, so the form keeps its own default.
    expect(onSelectSlot.mock.calls[0]).toHaveLength(1);
  });

  it("does not also open the form from the click a drag ends in", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    drag(container, 630, 690);
    fireEvent.click(container.querySelectorAll(".slotButton")[11]);
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
  });

  it("leaves touch to scroll the grid", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    drag(container, 630, 690, { pointerType: "touch" });
    expect(onSelectSlot).not.toHaveBeenCalled();
    expect(container.querySelector(".dragBlock")).not.toBeInTheDocument();
  });

  it("does not start a drag on a meeting already in the grid", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
      meetings: [
        meeting(new Date(2026, 7, 17, 10, 0), new Date(2026, 7, 17, 11, 0)),
      ],
    });
    measureColumns(container);
    const column = container.querySelector<HTMLElement>(".column")!;
    act(() => {
      const chip = screen.getByText("Meeting !a:example.org");
      fireEvent(chip, pointer("pointerdown", 630));
      fireEvent(column, pointer("pointermove", 690));
      fireEvent(column, pointer("pointerup", 690));
    });
    expect(onSelectSlot).not.toHaveBeenCalled();
  });

  it("books over a meeting that is already there", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
      meetings: [
        meeting(new Date(2026, 7, 17, 10, 0), new Date(2026, 7, 17, 11, 0)),
      ],
    });
    // Started on free time at 09:30 and pulled straight through the meeting,
    // which the grid lays out side by side rather than refusing.
    drag(container, 570, 690);
    expect(onSelectSlot).toHaveBeenCalledWith(
      new Date(2026, 7, 17, 9, 30),
      120,
    );
  });

  it("shows the start and the running length while dragging", () => {
    const { container } = renderWeek({ days: [WEEK[0]], canSchedule: true });
    measureColumns(container);
    const column = container.querySelector<HTMLElement>(".column")!;
    const slot = container.querySelectorAll<HTMLElement>(".slotButton")[10];

    act(() => {
      fireEvent(slot, pointer("pointerdown", 630));
      fireEvent(column, pointer("pointermove", 690));
    });
    expect(container.querySelector(".dragBlock")).toHaveTextContent(
      "10:30 · 1 h",
    );

    act(() => void fireEvent(column, pointer("pointermove", 735)));
    expect(container.querySelector(".dragBlock")).toHaveTextContent(
      "10:30 · 1 h 45 min",
    );

    act(() => void fireEvent(column, pointer("pointerup", 735)));
    expect(container.querySelector(".dragBlock")).not.toBeInTheDocument();
  });

  it("draws the block over the minutes it covers", () => {
    const { container } = renderWeek({ days: [WEEK[0]], canSchedule: true });
    measureColumns(container);
    const column = container.querySelector<HTMLElement>(".column")!;
    act(() => {
      fireEvent(
        container.querySelectorAll<HTMLElement>(".slotButton")[10],
        pointer("pointerdown", 630),
      );
      fireEvent(column, pointer("pointermove", 690));
    });
    const block = container.querySelector<HTMLElement>(".dragBlock")!;
    expect(block.style.transform).toBe("translateY(630px)");
    expect(block.style.blockSize).toBe("60px");
  });

  it("abandons a drag on Escape without booking anything", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    measureColumns(container);
    const column = container.querySelector<HTMLElement>(".column")!;
    act(() => {
      fireEvent(
        container.querySelectorAll<HTMLElement>(".slotButton")[10],
        pointer("pointerdown", 630),
      );
      fireEvent(column, pointer("pointermove", 690));
    });
    act(() => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(container.querySelector(".dragBlock")).not.toBeInTheDocument();

    act(() => void fireEvent(column, pointer("pointerup", 690)));
    expect(onSelectSlot).not.toHaveBeenCalled();
  });

  it("books the time a block lasts, not the rows it covers, when the clocks go forward", () => {
    const onSelectSlot = vi.fn();
    // 29 March 2026 has no 02:00-03:00 locally.
    const { container } = renderWeek({
      days: [new Date(2026, 2, 29)],
      canSchedule: true,
      onSelectSlot,
    });
    drag(container, 60, 240);
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 2, 29, 1, 0), 120);
  });

  it("books the time a block lasts when the clocks go back", () => {
    const onSelectSlot = vi.fn();
    // 25 October 2026 runs 02:00-03:00 twice.
    const { container } = renderWeek({
      days: [new Date(2026, 9, 25)],
      canSchedule: true,
      onSelectSlot,
    });
    drag(container, 60, 240);
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 9, 25, 1, 0), 240);
  });

  it("keeps a block inside the day it started in", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: true,
      onSelectSlot,
    });
    // Pulled well past the foot of the column.
    drag(container, 1380, 2000);
    expect(onSelectSlot).toHaveBeenCalledWith(new Date(2026, 7, 17, 23, 0), 60);
  });

  it("offers no drag without permission to schedule", () => {
    const onSelectSlot = vi.fn();
    const { container } = renderWeek({
      days: [WEEK[0]],
      canSchedule: false,
      onSelectSlot,
    });
    measureColumns(container);
    const column = container.querySelector<HTMLElement>(".column")!;
    act(() => {
      fireEvent(column, pointer("pointerdown", 630));
      fireEvent(column, pointer("pointermove", 690));
      fireEvent(column, pointer("pointerup", 690));
    });
    expect(onSelectSlot).not.toHaveBeenCalled();
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
