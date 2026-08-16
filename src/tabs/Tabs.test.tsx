import { expect, test } from "vitest";
import { type ReactNode, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { type Tab, TabContainer } from "./Tabs";

const tabs: Tab<string>[] = [
  { key: "audio", name: "Audio", content: <p>Audio settings</p> },
  { key: "video", name: "Video", content: <p>Video settings</p> },
  { key: "profile", name: "Profile", content: <p>Profile settings</p> },
];

function Tabs(): ReactNode {
  const [tab, setTab] = useState("audio");
  return (
    <TabContainer label="Settings" tab={tab} onTabChange={setTab} tabs={tabs} />
  );
}

test("the tabs are accessible", async () => {
  const { container } = render(<Tabs />);
  expect(await axe(container)).toHaveNoViolations();
});

test("each tab is paired with the panel it controls", () => {
  render(<Tabs />);

  for (const tab of screen.getAllByRole("tab")) {
    const panel = document.getElementById(tab.getAttribute("aria-controls")!);
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  }
});

test("the selected tab is the one whose panel is shown", async () => {
  const user = userEvent.setup();
  render(<Tabs />);
  const audio = screen.getByRole("tab", { name: "Audio" });
  const video = screen.getByRole("tab", { name: "Video" });

  expect(audio).toHaveAttribute("aria-selected", "true");
  expect(video).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Audio settings");

  await user.click(video);

  expect(audio).toHaveAttribute("aria-selected", "false");
  expect(video).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Video settings");
});

test("every tab can be reached and chosen with the keyboard", async () => {
  const user = userEvent.setup();
  render(<Tabs />);
  const [audio, video, profile] = screen.getAllByRole("tab");

  await user.tab();
  expect(audio).toHaveFocus();
  await user.tab();
  expect(video).toHaveFocus();
  await user.tab();
  expect(profile).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(profile).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Profile settings");

  // The panel follows the tabs in the focus order, so its content is reachable
  // without having to pass back through them
  await user.tab();
  expect(screen.getByRole("tabpanel")).toHaveFocus();
});
