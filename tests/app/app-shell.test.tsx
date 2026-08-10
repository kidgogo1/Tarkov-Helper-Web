import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppShell, type AppTab } from "../../src/app/AppShell";
import packageManifest from "../../package.json";

function renderShell(activeTab: AppTab = "quests") {
  const onTabChange = vi.fn();

  render(
    <AppShell
      activeProfile="pvp"
      activeTab={activeTab}
      level={15}
      onLevelChange={vi.fn()}
      onProfileChange={vi.fn()}
      onReset={vi.fn()}
      onSettings={vi.fn()}
      onTabChange={onTabChange}
    >
      <p>Current content</p>
    </AppShell>,
  );

  return { onTabChange };
}

describe("AppShell tabs", () => {
  it("shows the installed app version beside the brand", () => {
    renderShell();

    expect(screen.getByText(`v${packageManifest.version}`)).toHaveClass("brand-version");
  });

  it("uses a roving tab stop and links each tab to the active panel", () => {
    renderShell("items");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
    expect(tabs[2]).toHaveAttribute("id", "app-tab-items");
    expect(tabs[2]).toHaveAttribute("aria-controls", "app-panel-items");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "app-panel-items");
    expect(panel).toHaveAttribute("aria-labelledby", "app-tab-items");
  });

  it("moves focus and selection with Arrow, Home, and End keys", () => {
    const { onTabChange } = renderShell("quests");
    const tabs = screen.getAllByRole("tab");

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[5]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("map");

    fireEvent.keyDown(tabs[5], { key: "Home" });
    expect(tabs[0]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("quests");

    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(tabs[5]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("map");
  });
});
