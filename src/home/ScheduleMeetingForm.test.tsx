import { type MatrixClient } from "matrix-js-sdk";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@vector-im/compound-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { mockConfig } from "../utils/test";
import { scheduleAdvancedOpen } from "../settings/settings";
import { ScheduleMeetingForm } from "./ScheduleMeetingForm";

process.env.TZ = "Europe/Berlin";

const ADMIN_API = "https://admin-api.example.org";

// Far enough ahead that the "already passed" rule never fires, and a fixed
// time of day so the typed value is stable.
const IN_A_WEEK = new Date(Date.now() + 7 * 86400000);

function typedDate(): string {
  const day = `${IN_A_WEEK.getDate()}`.padStart(2, "0");
  const month = `${IN_A_WEEK.getMonth() + 1}`.padStart(2, "0");
  return `${day}${month}${IN_A_WEEK.getFullYear()}`;
}

function fakeClient(): MatrixClient {
  return {
    getThreePids: vi.fn().mockResolvedValue({ threepids: [] }),
    getUserId: () => "@me:example.org",
    getUser: () => ({ displayName: "Dr Ada" }),
    getAccessToken: () => "syt_token",
  } as unknown as MatrixClient;
}

function renderForm(
  onDone?: () => void,
  initialDurationMinutes?: number,
): ReturnType<typeof render> & { client: MatrixClient } {
  const client = fakeClient();
  return {
    ...render(
      <TooltipProvider>
        <ScheduleMeetingForm
          client={client}
          onDone={onDone}
          initialDurationMinutes={initialDurationMinutes}
        />
      </TooltipProvider>,
    ),
    client,
  };
}

/** Fills in everything the form insists on, leaving the defaults alone. */
async function fillRequiredFields(): Promise<void> {
  await userEvent.type(screen.getByLabelText("Full name"), "Ana Example");
  await userEvent.type(
    screen.getByLabelText("Email address"),
    "ana@example.com",
  );
  await userEvent.type(screen.getByLabelText("Date"), typedDate());
  await userEvent.type(screen.getByLabelText("Start time"), "1430");
}

beforeEach(() => {
  mockConfig({ admin_api_url: ADMIN_API });
  scheduleAdvancedOpen.setValue(false);
});

afterEach(() => vi.restoreAllMocks());

describe("ScheduleMeetingForm", () => {
  it("puts a field's error beneath the field rather than inside it", async () => {
    renderForm();
    const name = screen.getByLabelText("Full name");

    await userEvent.click(name);
    await userEvent.tab();

    const error = await screen.findByText(
      "Enter the name of the person you're meeting",
    );
    // The field's box is a flex row holding the input and its floating label.
    // Anything else in there is laid out beside the input and ends up under
    // the label, which is what this guards against.
    expect(name.parentElement).not.toContainElement(error);
    expect(name).toHaveAccessibleDescription(
      "Enter the name of the person you're meeting",
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
  });

  it("clears the error as the field is corrected, without losing the caret", async () => {
    renderForm();
    const name = screen.getByLabelText("Full name");

    await userEvent.click(name);
    await userEvent.tab();
    await screen.findByText("Enter the name of the person you're meeting");
    // Showing the message must not replace the control it belongs to, or the
    // first keystroke of a correction would throw the keyboard away.
    expect(screen.getByLabelText("Full name")).toBe(name);

    await userEvent.click(name);
    await userEvent.type(name, "Ana Example");

    await waitFor(() =>
      expect(
        screen.queryByText("Enter the name of the person you're meeting"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Full name")).toBe(name);
    expect(document.activeElement).toBe(name);
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the extra options out of reach until they are asked for", async () => {
    renderForm();
    const toggle = screen.getByRole("button", { name: "More options" });
    const panel = document.getElementById(
      toggle.getAttribute("aria-controls")!,
    );

    // Mounted so that opening and closing it can be animated, but inert, so it
    // is neither focusable nor visible to assistive technology.
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("inert");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);

    expect(panel).not.toHaveAttribute("inert");
    expect(
      screen.getByRole("button", { name: "Fewer options" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(scheduleAdvancedOpen.value$.value).toBe(true);
  });

  it("refuses to submit an empty form, and says why", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderForm();

    await userEvent.click(
      screen.getByRole("button", { name: "Schedule meeting" }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter the name of the person you're meeting"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enter an email address so we can send the invite"),
    ).toBeInTheDocument();
    // The keyboard lands on the first thing that needs attention.
    expect(document.activeElement).toBe(screen.getByLabelText("Full name"));
  });

  it("books the meeting and confirms where the invite went", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 201,
      json: vi
        .fn()
        .mockResolvedValue({ meet_link: "https://call.example.com/meet-abc" }),
    } as unknown as Response);
    renderForm();

    await fillRequiredFields();
    await userEvent.click(
      screen.getByRole("button", { name: "Schedule meeting" }),
    );

    await screen.findByText("Meeting scheduled");
    expect(
      screen.getByText("We emailed the invite to ana@example.com."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://call.example.com/meet-abc"),
    ).toBeInTheDocument();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${ADMIN_API}/api/admin/rooms`);
    const body = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      room_name: "Ana Example",
      prospect_name: "Ana Example",
      prospect_email: "ana@example.com",
      organizer_name: "Dr Ada",
      organizer_user_id: "@me:example.org",
    });
  });

  it("keeps the reason to itself when the server refuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 500,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response);
    renderForm();

    await fillRequiredFields();
    await userEvent.click(
      screen.getByRole("button", { name: "Schedule meeting" }),
    );

    expect(
      await screen.findByText("We couldn't schedule that meeting. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Meeting scheduled")).not.toBeInTheDocument();
  });

  it("is accessible", async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is accessible while reporting errors", async () => {
    const { container } = renderForm();
    await userEvent.click(
      screen.getByRole("button", { name: "Schedule meeting" }),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("offers a length dragged out on the calendar as its own choice", () => {
    // 105 minutes is a multiple of the snap but not one of the offered
    // lengths, which is the normal outcome of dragging a block out.
    renderForm(undefined, 105);
    const lengths = within(screen.getByRole("group", { name: "Length" }));

    expect(lengths.getByRole("radio", { name: "105 minutes" })).toBeChecked();
    // The configured lengths are still all there beside it.
    for (const label of ["15 minutes", "30 minutes", "45 minutes"])
      expect(lengths.getByRole("radio", { name: label })).toBeInTheDocument();
  });

  it("does not invent a choice when the length is already offered", () => {
    renderForm(undefined, 30);
    const lengths = within(screen.getByRole("group", { name: "Length" }));

    expect(lengths.getByRole("radio", { name: "30 minutes" })).toBeChecked();
    expect(lengths.getAllByRole("radio")).toHaveLength(4);
  });
});
