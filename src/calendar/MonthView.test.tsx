import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { mockConfig } from "../utils/test";
import { MonthView } from "./MonthView";

// Pinned to a zone with daylight saving, before any date below is built.
process.env.TZ = "Europe/Berlin";

// The shared clock schedules its first tick when its module loads, so the
// fake timers have to be installed before that: vi.hoisted runs first
// whatever it is written. shouldAdvanceTime keeps timer-driven async work
// (user events, the accessibility pass) going while the clock is ours.
vi.hoisted(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

const AUGUST = new Date(2026, 7, 15);

function meeting(start: Date, roomId = "!a:example.org"): ScheduledMeeting {
  return {
    room: { roomId },
    roomName: `Meeting ${roomId}`,
    bookingId: roomId,
    scheduledStart: start.getTime(),
    scheduledEnd: start.getTime() + 3600000,
    organizerName: "",
    prospectName: "",
    practiceType: "solo",
    timezone: "UTC",
    isAdmin: false,
    meetLink: "",
  } as unknown as ScheduledMeeting;
}

/**
 * Moves the shared clock, which only re-reads the time on its own tick, so
 * the value it lands on is somewhere in the minute that follows `date`.
 */
function setNow(date: Date): void {
  vi.setSystemTime(date);
  act(() => {
    vi.advanceTimersByTime(60000);
  });
}

beforeEach(() => {
  mockConfig({ calendar: { first_day_of_week: "monday" } });
  setNow(new Date(2026, 7, 15, 12, 0));
});

afterAll(() => vi.useRealTimers());

describe("MonthView", () => {
  it("renders whole weeks of days", () => {
    render(
      <MonthView focusedDate={AUGUST} meetings={[]} onSelectDay={vi.fn()} />,
    );
    const cells = screen.getAllByRole("gridcell");
    expect(cells).toHaveLength(42);
    expect(cells[0]).toHaveAttribute("data-date", "2026-07-27");
  });

  it("labels the columns in the interface language", async () => {
    render(
      <MonthView focusedDate={AUGUST} meetings={[]} onSelectDay={vi.fn()} />,
    );
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent),
    ).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

    await act(async () => {
      await i18n.changeLanguage("de");
    });
    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("Mo");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  it("marks today, and moves the mark when the day turns over", () => {
    const { container } = render(
      <MonthView focusedDate={AUGUST} meetings={[]} onSelectDay={vi.fn()} />,
    );
    const today = (): Element | null => container.querySelector(".today");
    expect(today()).toHaveAttribute("data-date", "2026-08-15");

    setNow(new Date(2026, 7, 16, 0, 30));
    expect(today()).toHaveAttribute("data-date", "2026-08-16");
  });

  it("keeps exactly one day in the tab order as the arrows move", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <MonthView focusedDate={AUGUST} meetings={[]} onSelectDay={vi.fn()} />,
    );

    const tabbable = (): Element[] =>
      screen.getAllByRole("gridcell").filter((c) => c.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAttribute("data-date", "2026-08-15");

    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(tabbable()).toHaveLength(1);
    expect(document.activeElement).toHaveAttribute("data-date", "2026-08-16");

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-date", "2026-08-23");

    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(document.activeElement).toHaveAttribute("data-date", "2026-08-15");

    await user.keyboard("{Home}");
    expect(document.activeElement).toHaveAttribute("data-date", "2026-08-10");

    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-date", "2026-08-16");
    expect(tabbable()).toHaveLength(1);
  });

  it("opens the day on Enter", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSelectDay = vi.fn();
    render(
      <MonthView
        focusedDate={AUGUST}
        meetings={[]}
        onSelectDay={onSelectDay}
      />,
    );

    await user.tab();
    await user.keyboard("{Enter}");
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(onSelectDay.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it("asks the page for a day outside the month it is showing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onFocusDate = vi.fn();
    render(
      <MonthView
        focusedDate={AUGUST}
        meetings={[]}
        onSelectDay={vi.fn()}
        onFocusDate={onFocusDate}
      />,
    );

    // The grid runs from 27 July, so the first of July is off it.
    await user.tab();
    await user.keyboard("{PageUp}");
    expect(onFocusDate).toHaveBeenCalledTimes(1);
    expect(onFocusDate.mock.calls[0][0]).toEqual(new Date(2026, 6, 1));
  });

  it("shows meetings on the days they fall on", () => {
    render(
      <MonthView
        focusedDate={AUGUST}
        meetings={[meeting(new Date(2026, 7, 20, 9, 0))]}
        onSelectDay={vi.fn()}
        onSelectMeeting={vi.fn()}
      />,
    );
    const cell = screen
      .getAllByRole("gridcell")
      .find((c) => c.getAttribute("data-date") === "2026-08-20")!;
    expect(within(cell).getByRole("button")).toHaveTextContent(
      "Meeting !a:example.org",
    );
  });

  it("summarises a day with more meetings than fit", () => {
    const meetings = Array.from({ length: 5 }, (_, i) =>
      meeting(new Date(2026, 7, 20, 9 + i, 0), `!m${i}:example.org`),
    );
    render(
      <MonthView
        focusedDate={AUGUST}
        meetings={meetings}
        onSelectDay={vi.fn()}
        onSelectMeeting={vi.fn()}
      />,
    );
    expect(screen.getByText("2 more")).toBeInTheDocument();
  });

  it("renders the compact density without chips", () => {
    const { container } = render(
      <MonthView
        compact
        focusedDate={AUGUST}
        meetings={[meeting(new Date(2026, 7, 20, 9, 0))]}
        selectedDate={new Date(2026, 7, 20)}
        onSelectDay={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector(".marker")).toBeInTheDocument();
    expect(container.querySelector(".selected")).toHaveAttribute(
      "data-date",
      "2026-08-20",
    );
  });

  it("renders an empty month without meetings", () => {
    render(
      <MonthView
        focusedDate={AUGUST}
        meetings={[]}
        onSelectDay={vi.fn()}
        onSelectMeeting={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is accessible", async () => {
    const { container } = render(
      <MonthView
        focusedDate={AUGUST}
        meetings={[meeting(new Date(2026, 7, 20, 9, 0))]}
        onSelectDay={vi.fn()}
        onSelectMeeting={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
