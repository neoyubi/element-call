import { type MatrixClient, KnownMembership, type Room } from "matrix-js-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@vector-im/compound-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { mockConfig } from "../utils/test";
import { homeUpcomingOpen } from "../settings/settings";
import { UpcomingMeetings } from "./UpcomingMeetings";
import { type ScheduledMeeting } from "./useScheduledMeetings";

process.env.TZ = "Europe/Berlin";

const SCHEDULERS_ROOM = "!schedulers:example.org";
const ADMIN_API = "https://admin-api.example.org";

const START = Date.now() + 2 * 86400000;

function fakeClient(): MatrixClient {
  return {
    getRooms: () => [],
    getRoom: (roomId: string) =>
      roomId === SCHEDULERS_ROOM
        ? ({ getMyMembership: () => KnownMembership.Join } as unknown as Room)
        : null,
    getUserId: () => "@me:example.org",
    getAccessToken: () => "syt_token",
    on: () => {},
    off: () => {},
  } as unknown as MatrixClient;
}

function meeting(name: string, start: number): ScheduledMeeting {
  return {
    room: { roomId: `!${name}:example.org`, name } as unknown as Room,
    roomName: name,
    bookingId: name,
    scheduledStart: start,
    scheduledEnd: start + 1800000,
    organizerName: "Dr Ada",
    prospectName: name,
    practiceType: "",
    timezone: "UTC",
    isAdmin: true,
    meetLink: "https://call.example.org/meet-abc",
  } as ScheduledMeeting;
}

function renderList(
  meetings: ScheduledMeeting[],
  featured?: ScheduledMeeting,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <UpcomingMeetings
          client={fakeClient()}
          meetings={meetings}
          featured={featured}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockConfig({
    admin_api_url: ADMIN_API,
    schedulers_room_id: SCHEDULERS_ROOM,
    calendar: { first_day_of_week: "monday" },
  });
  homeUpcomingOpen.setValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe("UpcomingMeetings", () => {
  it("lists the meetings that are still to come", () => {
    renderList([meeting("Ana", START), meeting("Tom", START + 86400000)]);
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText("Tom")).toBeInTheDocument();
  });

  it("leaves out the meeting that is already shown on its own", () => {
    const next = meeting("Ana", START);
    renderList([next, meeting("Tom", START + 86400000)], next);

    expect(screen.queryByText("Ana")).not.toBeInTheDocument();
    expect(screen.getByText("Tom")).toBeInTheDocument();
    // The count follows the list, so it does not promise a meeting that the
    // section does not contain.
    expect(screen.getByText("1 upcoming meeting")).toBeInTheDocument();
  });

  it("renders nothing at all when there is nothing left to show", () => {
    const next = meeting("Ana", START);
    const { container } = renderList([next], next);
    expect(container).toBeEmptyDOMElement();
  });

  it("collapses, and remembers that it was collapsed", async () => {
    renderList([meeting("Ana", START)]);
    const trigger = screen.getByRole("button", { expanded: true });

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Ana")).not.toBeInTheDocument();
    expect(homeUpcomingOpen.value$.value).toBe(false);
  });

  it("opens the meeting dialog from a tile", async () => {
    renderList([meeting("Ana", START)]);

    await userEvent.click(screen.getByRole("button", { name: /^Ana,/ }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reschedule" }),
    ).toBeInTheDocument();
  });

  it("does not drop the keyboard when the dialog closes", async () => {
    renderList([meeting("Ana", START)]);
    await userEvent.click(screen.getByRole("button", { name: /^Ana,/ }));

    await userEvent.keyboard("{Escape}");

    // Wherever it lands — the tile it came from, or the section when that tile
    // is gone — it must not fall back to the document.
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).not.toBeNull();
    });
  });

  it("is accessible", async () => {
    const { container } = renderList([meeting("Ana", START)]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
