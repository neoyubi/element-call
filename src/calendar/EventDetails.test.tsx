import { type MatrixClient, type Room } from "matrix-js-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@vector-im/compound-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { Modal } from "../Modal";
import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { mockConfig } from "../utils/test";
import { EventDetails } from "./EventDetails";

process.env.TZ = "Europe/Berlin";

const ADMIN_API = "https://admin-api.example.org";
const MEET_LINK = "https://call.example.org/meet-abc#?password=s3cret";

const MEETING = {
  room: { roomId: "!a:example.org" } as Room,
  roomName: "Consultation",
  bookingId: "booking-1",
  scheduledStart: new Date(2026, 7, 20, 10, 0).getTime(),
  scheduledEnd: new Date(2026, 7, 20, 10, 30).getTime(),
  organizerName: "Sam Taylor",
  prospectName: "",
  practiceType: "solo",
  timezone: "UTC",
  isAdmin: true,
  meetLink: MEET_LINK,
} as ScheduledMeeting;

const client = {
  getAccessToken: () => "syt_token",
  getUserId: () => "@me:example.org",
} as unknown as MatrixClient;

function renderDetails(
  props: Partial<Parameters<typeof EventDetails>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <EventDetails
          meeting={MEETING}
          client={client}
          canModify
          onDone={vi.fn()}
          {...props}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockConfig({ admin_api_url: ADMIN_API });
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetails", () => {
  it("shows what the meeting is and when it runs", () => {
    renderDetails();
    expect(screen.getByText("Consultation")).toBeInTheDocument();
    expect(screen.getByText(/Organized by Sam Taylor/)).toBeInTheDocument();
    expect(screen.getByText(/Scheduled in UTC/)).toBeInTheDocument();
  });

  it("copies the join link exactly as it was issued", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderDetails();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy join link" }),
    );
    expect(writeText).toHaveBeenCalledWith(MEET_LINK);
    vi.unstubAllGlobals();
  });

  it("joins through the link's own route rather than rebuilding one", () => {
    renderDetails();
    expect(screen.getByRole("button", { name: "Join" })).toHaveAttribute(
      "href",
      "/meet-abc#?password=s3cret",
    );
  });

  it("offers nothing to join when the meeting has no link", () => {
    renderDetails({ meeting: { ...MEETING, meetLink: "" } });
    expect(
      screen.queryByRole("button", { name: "Join" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy join link" }),
    ).not.toBeInTheDocument();
  });

  it("hides the changes a viewer may not make", () => {
    renderDetails({ canModify: false });
    expect(
      screen.queryByRole("button", { name: "Reschedule" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel meeting" }),
    ).not.toBeInTheDocument();
  });

  it("never offers to answer for an attendee", () => {
    renderDetails();
    for (const label of [
      /accept/i,
      /decline/i,
      /rsvp/i,
      /going/i,
      /attending/i,
    ])
      expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it("sends exactly the three fields a reschedule may carry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const onDone = vi.fn();
    renderDetails({ onDone });

    await userEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    const future = new Date(Date.now() + 86400000);
    const date = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    await userEvent.clear(screen.getByLabelText("Date"));
    await userEvent.type(screen.getByLabelText("Date"), date);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ADMIN_API}/api/admin/rooms/!a%3Aexample.org`);
    expect(init?.method).toBe("PUT");
    expect(Object.keys(JSON.parse(init?.body as string))).toEqual([
      "scheduled_start",
      "scheduled_end",
      "timezone",
    ]);
  });

  it("refuses a start in the past without asking the service", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const past = Date.now() - 86400000;
    renderDetails({
      meeting: {
        ...MEETING,
        scheduledStart: past,
        scheduledEnd: past + 1800000,
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("The meeting must start in the future"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels through the service, once confirmed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const onDone = vi.fn();
    renderDetails({ onDone });

    await userEvent.click(
      screen.getByRole("button", { name: "Cancel meeting" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getAllByRole("button", { name: "Cancel meeting" })[0],
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("keeps the meeting when the confirmation is declined", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderDetails();

    await userEvent.click(
      screen.getByRole("button", { name: "Cancel meeting" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep meeting" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Reschedule" }),
    ).toBeInTheDocument();
  });

  it("says so when the service refuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 502 }),
    );
    renderDetails();

    await userEvent.click(
      screen.getByRole("button", { name: "Cancel meeting" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Cancel meeting" })[0],
    );
    expect(
      await screen.findByText("Could not update the meeting"),
    ).toBeInTheDocument();
  });

  it("is accessible while open", async () => {
    const { container } = render(
      <MemoryRouter>
        <TooltipProvider>
          <Modal title="Meeting details" open onDismiss={vi.fn()}>
            <EventDetails
              meeting={MEETING}
              client={client}
              canModify
              onDone={vi.fn()}
            />
          </Modal>
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Consultation")).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
    expect(container).toBeInTheDocument();
  });
});
