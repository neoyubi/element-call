import { KnownMembership, type MatrixClient, type Room } from "matrix-js-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TooltipProvider } from "@vector-im/compound-web";
import { type FC } from "react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientContextProvider, type ValidClientState } from "../ClientContext";
import { calendarView } from "../settings/settings";
import { formatDay } from "./dates";
import { mockConfig } from "../utils/test";
import { CalendarPage } from "./CalendarPage";

process.env.TZ = "Europe/Berlin";

const ROOM_ID = "!a:example.org";
const SCHEDULERS_ROOM = "!schedulers:example.org";

function fakeClient(canSchedule = false): MatrixClient {
  const room = {
    roomId: ROOM_ID,
    name: "Consultation",
    currentState: {
      getStateEvents: (type: string): { getContent: () => object } | null =>
        type === "io.element.call.scheduled_meeting"
          ? {
              getContent: () => ({
                scheduled_start: new Date(2026, 7, 20, 10, 0).getTime(),
                scheduled_end: new Date(2026, 7, 20, 10, 30).getTime(),
                meet_link: "https://call.example.org/meet-abc#?password=s",
              }),
            }
          : null,
    },
  } as unknown as Room;

  return {
    getRooms: () => [room],
    getRoom: (roomId: string) =>
      canSchedule && roomId === SCHEDULERS_ROOM
        ? ({ getMyMembership: () => KnownMembership.Join } as unknown as Room)
        : null,
    getUserId: () => "@me:example.org",
    getAccessToken: () => "syt_token",
    on: () => {},
    off: () => {},
  } as unknown as MatrixClient;
}

const LocationProbe: FC = () => {
  const { search } = useLocation();
  return <span data-testid="search">{search}</span>;
};

// The account menu in the standard header wants a fully-fledged client and
// says nothing about the calendar, so these renders ask for no header.
function renderCalendar(
  initialEntry = "/calendar",
  canSchedule = false,
): ReturnType<typeof render> {
  const entry = initialEntry.includes("?")
    ? `${initialEntry}&header=none`
    : `${initialEntry}?header=none`;
  const clientState = {
    state: "valid",
    authenticated: {
      client: fakeClient(canSchedule),
      isPasswordlessUser: false,
    },
    disconnected: false,
    supportedFeatures: { reactions: true, thumbnails: true },
    setClient: vi.fn(),
  } as unknown as ValidClientState;

  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <ClientContextProvider value={clientState}>
          <Routes>
            <Route
              path="/calendar"
              element={
                <>
                  <CalendarPage />
                  <LocationProbe />
                </>
              }
            />
            <Route path="*" element={<p>Room page</p>} />
          </Routes>
        </ClientContextProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockConfig({ calendar: { first_day_of_week: "monday" } });
  calendarView.setValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  calendarView.setValue(null);
});

describe("CalendarPage", () => {
  it("opens on the week view when nothing has been chosen", () => {
    const { container } = renderCalendar();
    expect(container.querySelector(".week")).toBeInTheDocument();
  });

  it("opens on the view named in the link", () => {
    const { container } = renderCalendar(
      "/calendar?view=month&date=2026-08-20",
    );
    expect(container.querySelector(".grid")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "August 2026",
    );
  });

  it("ignores a view the calendar does not have", () => {
    const { container } = renderCalendar("/calendar?view=decade");
    expect(container.querySelector(".week")).toBeInTheDocument();
  });

  it("opens on the view chosen last time", () => {
    calendarView.setValue("agenda");
    const { container } = renderCalendar();
    expect(container.querySelector(".agenda")).toBeInTheDocument();
  });

  it("says when a period holds nothing rather than showing an empty grid", () => {
    calendarView.setValue("agenda");
    renderCalendar("/calendar?date=2026-12-01");
    expect(
      screen.getByText("Nothing scheduled in this period"),
    ).toBeInTheDocument();
  });

  it("puts the chosen view in the address so it can be linked and undone", async () => {
    renderCalendar("/calendar?date=2026-08-20");
    await userEvent.click(screen.getByRole("button", { name: "Month" }));

    expect(screen.getByTestId("search")).toHaveTextContent("view=month");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "August 2026",
    );
  });

  it("moves the focused date without losing the view", async () => {
    renderCalendar("/calendar?view=month&date=2026-08-20");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByTestId("search")).toHaveTextContent("date=2026-09-01");
    expect(screen.getByTestId("search")).toHaveTextContent("view=month");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "September 2026",
    );
  });

  it("steps back to what the address said before", async () => {
    renderCalendar("/calendar?view=month&date=2026-08-20");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("search")).toHaveTextContent("date=2026-09-01");

    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByTestId("search")).toHaveTextContent("date=2026-08-01");
  });

  it("opens a day from the month grid", async () => {
    renderCalendar("/calendar?view=month&date=2026-08-20");
    await userEvent.click(
      screen.getByLabelText(formatDay(i18n.language, new Date(2026, 7, 20))),
    );
    expect(screen.getByTestId("search")).toHaveTextContent("view=day");
    expect(screen.getByTestId("search")).toHaveTextContent("date=2026-08-20");
  });

  it("leaves other paths to the room page", () => {
    render(
      <MemoryRouter initialEntries={["/some-room"]}>
        <Routes>
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="*" element={<p>Room page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Room page")).toBeInTheDocument();
  });

  it("offers no scheduling to a viewer who may not schedule", () => {
    renderCalendar("/calendar?view=week&date=2026-08-20");
    expect(
      screen.queryByRole("button", { name: "Schedule a meeting" }),
    ).not.toBeInTheDocument();
  });

  it("offers scheduling to a viewer who may", () => {
    mockConfig({
      calendar: { first_day_of_week: "monday" },
      schedulers_room_id: SCHEDULERS_ROOM,
    });
    renderCalendar("/calendar?view=week&date=2026-08-20", true);
    expect(
      screen.getByRole("button", { name: "Schedule a meeting" }),
    ).toBeInTheDocument();
  });

  it("puts focus back where it came from when the detail closes", async () => {
    renderCalendar("/calendar?view=month&date=2026-08-20");
    const chip = screen.getByText("Consultation");

    await userEvent.click(chip);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    expect(document.activeElement).not.toBe(document.body);
    expect(
      document.activeElement?.closest("[role='gridcell']"),
    ).toHaveAttribute("data-date", "2026-08-20");
  });
});
