import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { type ComponentProps, type ReactNode, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { TooltipProvider } from "@vector-im/compound-web";
import { type MatrixClient } from "matrix-js-sdk";

import { SettingsModal } from "./SettingsModal";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { mockMediaDevices } from "../utils/test";

vi.mock("../UrlParams", () => ({
  useUrlParams: (): { controlledAudioDevices: boolean } => ({
    controlledAudioDevices: false,
  }),
}));

vi.mock("../livekit/TrackProcessorContext", () => ({
  useTrackProcessor: (): { supported: boolean; processor: undefined } => ({
    supported: false,
    processor: undefined,
  }),
}));

const client = {
  getUserId: () => "@alice:example.org",
  getUser: () => null,
} as unknown as MatrixClient;

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

beforeAll(() => {
  // Needed by the volume slider
  globalThis.ResizeObserver = class ResizeObserver {
    public observe(): void {
      // do nothing
    }
    public unobserve(): void {
      // do nothing
    }
    public disconnect(): void {
      // do nothing
    }
  };
});

type SettingsTab = ComponentProps<typeof SettingsModal>["tab"];

function Settings(): ReactNode {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("audio");
  return (
    <TooltipProvider>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <MediaDevicesContext
        value={mockMediaDevices({ requestDeviceNames: vi.fn() })}
      >
        <SettingsModal
          open={open}
          onDismiss={() => setOpen(false)}
          tab={tab}
          onTabChange={setTab}
          client={client}
        />
      </MediaDevicesContext>
    </TooltipProvider>
  );
}

test("the open settings modal is accessible", async () => {
  const user = userEvent.setup();
  render(<Settings />);
  await user.click(screen.getByRole("button", { name: "Open settings" }));

  expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();
});

test("focus stays within the modal while it is open", async () => {
  const user = userEvent.setup();
  render(<Settings />);
  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = screen.getByRole("dialog");

  // However far the focus is moved, it never leaves the dialog
  for (let i = 0; i < 12; i++) {
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  }

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("every tab is still reachable on a touchscreen", async () => {
  window.matchMedia = (query): MediaQueryList =>
    ({
      matches: query.includes("hover: none") || query.includes("pointer"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as Partial<MediaQueryList> as MediaQueryList;

  const user = userEvent.setup();
  render(<Settings />);
  await user.click(screen.getByRole("button", { name: "Open settings" }));

  // The drawer is the whole width of a phone, which is where the tab strip has
  // the least room. Every tab still has to be there and be selectable.
  const tabs = screen.getAllByRole("tab");
  expect(tabs.length).toBeGreaterThan(1);
  for (const tab of tabs) {
    expect(tab).toBeVisible();
  }
  expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();

  await user.click(tabs[1]);
  expect(tabs[1]).toHaveAttribute("aria-selected", "true");
});
