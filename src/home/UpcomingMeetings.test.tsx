import { type MatrixClient, KnownMembership, type Room } from "matrix-js-sdk";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@vector-im/compound-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockConfig } from "../utils/test";
import { formatDate } from "./dateFormat";
import { UpcomingMeetings } from "./UpcomingMeetings";

process.env.TZ = "Europe/Berlin";

const ROOM_ID = "!a:example.org";
const SCHEDULERS_ROOM = "!schedulers:example.org";
const ADMIN_API = "https://admin-api.example.org";

const START = Date.now() + 2 * 86400000;

function fakeClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  const room = {
    roomId: ROOM_ID,
    name: "Consultation",
    getJoinedMembers: () => [
      { userId: "@me:example.org" },
      { userId: "@them:example.org" },
    ],
    currentState: {
      getStateEvents: (type: string): { getContent: () => object } | null =>
        type === "io.element.call.scheduled_meeting"
          ? {
              getContent: () => ({
                scheduled_start: START,
                scheduled_end: START + 1800000,
                timezone: "UTC",
              }),
            }
          : null,
    },
  } as unknown as Room;

  return {
    getRooms: () => [room],
    getRoom: (roomId: string) =>
      roomId === SCHEDULERS_ROOM
        ? ({ getMyMembership: () => KnownMembership.Join } as unknown as Room)
        : null,
    getUserId: () => "@me:example.org",
    getAccessToken: () => "syt_token",
    on: () => {},
    off: () => {},
    ...overrides,
  } as unknown as MatrixClient;
}

function renderList(client = fakeClient()): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <UpcomingMeetings client={client} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** Opens the inline reschedule row and answers with a valid future date. */
async function startEditing(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Edit meeting" }));
}

beforeEach(() => {
  mockConfig({
    admin_api_url: ADMIN_API,
    schedulers_room_id: SCHEDULERS_ROOM,
    calendar: { first_day_of_week: "monday" },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("UpcomingMeetings", () => {
  it("lists a scheduled meeting", () => {
    renderList();
    expect(screen.getByText("Consultation")).toBeInTheDocument();
  });

  it("keeps the edit and cancel controls reachable without a pointer", () => {
    const { container } = renderList();
    const edit = screen.getByRole("button", { name: "Edit meeting" });
    const remove = screen.getByRole("button", { name: "Delete meeting" });

    // Neither is hidden behind a hover state: both are in the document, in
    // the tab order, and the stylesheet reveals them only for pointers that
    // can hover.
    expect(edit).toBeVisible();
    expect(remove).toBeVisible();
    expect(edit.tabIndex).not.toBe(-1);
    expect(remove.tabIndex).not.toBe(-1);
    expect(container.querySelector(".collapsedText")).not.toBeInTheDocument();
  });

  it("sends exactly the three fields a reschedule may carry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    renderList();

    await startEditing();
    const date = screen.getByLabelText("Date");
    expect(date).toHaveValue(formatDate(START));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ADMIN_API}/api/admin/rooms/!a%3Aexample.org`);
    expect(init?.method).toBe("PUT");
    expect(Object.keys(JSON.parse(init?.body as string))).toEqual([
      "scheduled_start",
      "scheduled_end",
      "timezone",
    ]);
  });

  it("refuses a start in the past and asks for nothing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderList();

    await startEditing();
    await userEvent.clear(screen.getByLabelText("Date"));
    await userEvent.type(screen.getByLabelText("Date"), "2020-01-01");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("That time has already passed. Pick a later one."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the row open and says so when the service refuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 502 }),
    );
    renderList();

    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Could not update the meeting"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
  });

  it("cancels through the service once confirmed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    renderList();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete meeting" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("empties and leaves the room where there is no service", async () => {
    mockConfig({ schedulers_room_id: SCHEDULERS_ROOM });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const kick = vi.fn().mockResolvedValue(undefined);
    const leave = vi.fn().mockResolvedValue(undefined);
    renderList(fakeClient({ kick, leave } as unknown as Partial<MatrixClient>));

    await userEvent.click(
      screen.getByRole("button", { name: "Delete meeting" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(leave).toHaveBeenCalledWith(ROOM_ID));
    expect(kick).toHaveBeenCalledWith(ROOM_ID, "@them:example.org");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no changes to a viewer who may not schedule", () => {
    mockConfig({ admin_api_url: ADMIN_API });
    renderList();
    expect(
      screen.queryByRole("button", { name: "Edit meeting" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete meeting" }),
    ).not.toBeInTheDocument();
  });

  it("collapses to a real button rather than a paragraph", async () => {
    renderList();
    await userEvent.click(
      screen.getByRole("button", { name: "Hide calendar" }),
    );
    const summary = screen.getByRole("button", {
      name: "1 upcoming meeting",
    });
    await userEvent.click(summary);
    expect(
      screen.getByRole("button", { name: "Hide calendar" }),
    ).toBeInTheDocument();
  });

  it("filters the list to a day picked on the grid", async () => {
    renderList();
    const grid = screen.getByRole("grid");
    const otherDay = within(grid)
      .getAllByRole("gridcell")
      .find((cell) => cell.getAttribute("data-date") !== formatDate(START))!;

    await userEvent.click(otherDay);
    expect(screen.queryByText("Consultation")).not.toBeInTheDocument();

    await userEvent.click(otherDay);
    expect(screen.getByText("Consultation")).toBeInTheDocument();
  });
});
