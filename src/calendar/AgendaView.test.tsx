import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { mockConfig } from "../utils/test";
import { AgendaView } from "./AgendaView";

// Pinned to a zone with daylight saving, before any date below is built.
process.env.TZ = "Europe/Berlin";

// The shared clock schedules its first tick when its module loads, so the
// fake timers have to be installed before that: vi.hoisted runs first
// whatever it is written. shouldAdvanceTime keeps timer-driven async work
// going while the clock is ours.
vi.hoisted(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

const MONTH_START = new Date(2026, 7, 1);
const MONTH_END = new Date(2026, 8, 1);

function meeting(
  start: Date,
  roomId = "!a:example.org",
  name = "Consultation",
): ScheduledMeeting {
  return {
    room: { roomId },
    roomName: name,
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
  mockConfig({});
  setNow(new Date(2026, 7, 20, 9, 0));
});

afterAll(() => vi.useRealTimers());

describe("AgendaView", () => {
  it("groups meetings under the day they fall on", () => {
    render(
      <AgendaView
        meetings={[
          meeting(new Date(2026, 7, 20, 10, 0), "!a:example.org", "First"),
          meeting(new Date(2026, 7, 20, 14, 0), "!b:example.org", "Second"),
          meeting(new Date(2026, 7, 21, 10, 0), "!c:example.org", "Third"),
        ]}
        rangeStart={MONTH_START}
        rangeEnd={MONTH_END}
        onSelectMeeting={vi.fn()}
      />,
    );
    const headings = screen.getAllByRole("heading");
    expect(headings).toHaveLength(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("says so when the period is empty", () => {
    render(
      <AgendaView
        meetings={[]}
        rangeStart={MONTH_START}
        rangeEnd={MONTH_END}
        onSelectMeeting={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Nothing scheduled in this period"),
    ).toBeInTheDocument();
  });

  it("opens a meeting from its row, which is the whole action", async () => {
    const onSelectMeeting = vi.fn();
    render(
      <AgendaView
        meetings={[meeting(new Date(2026, 7, 20, 10, 0))]}
        rangeStart={MONTH_START}
        rangeEnd={MONTH_END}
        onSelectMeeting={onSelectMeeting}
      />,
    );
    // One control per meeting: everything else is reached from the detail
    // it opens, so nothing is exclusive to the grid views.
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(1);
    await userEvent.click(rows[0]);
    expect(onSelectMeeting).toHaveBeenCalledTimes(1);
  });

  it("counts down, and keeps counting", () => {
    render(
      <AgendaView
        meetings={[meeting(new Date(2026, 7, 20, 9, 30))]}
        rangeStart={MONTH_START}
        rangeEnd={MONTH_END}
        onSelectMeeting={vi.fn()}
      />,
    );
    const before = screen.getByText(/^in \d+ minutes?$/).textContent;

    setNow(new Date(2026, 7, 20, 9, 20));
    const after = screen.getByText(/^in \d+ minutes?$/).textContent;
    expect(after).not.toBe(before);
  });

  it("says when a meeting is under way", () => {
    render(
      <AgendaView
        meetings={[meeting(new Date(2026, 7, 20, 8, 45))]}
        rangeStart={MONTH_START}
        rangeEnd={MONTH_END}
        onSelectMeeting={vi.fn()}
      />,
    );
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("is accessible", async () => {
    const { container } = render(
      <AgendaView
        meetings={[
          meeting(new Date(2026, 7, 20, 10, 0), "!a:example.org", "First"),
          meeting(new Date(2026, 7, 21, 10, 0), "!b:example.org", "Second"),
        ]}
        rangeStart={MONTH_START}
        rangeEnd={MONTH_END}
        onSelectMeeting={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
