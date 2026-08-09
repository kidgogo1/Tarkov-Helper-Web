import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../../src/app/AppShell";

describe("AppShell", () => {
  it("switches tabs and profiles through accessible controls", () => {
    const onTabChange = vi.fn();
    const onProfileChange = vi.fn();

    render(
      <AppShell
        activeProfile="pvp"
        activeTab="quests"
        level={15}
        onLevelChange={vi.fn()}
        onProfileChange={onProfileChange}
        onReset={vi.fn()}
        onSettings={vi.fn()}
        onTabChange={onTabChange}
      >
        <p>화면 내용</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("tab", { name: /아이템/ }));
    expect(onTabChange).toHaveBeenCalledWith("items");

    fireEvent.click(screen.getByRole("tab", { name: "시세" }));
    expect(onTabChange).toHaveBeenCalledWith("prices");

    fireEvent.click(screen.getByRole("button", { name: "PVE 프로필" }));
    expect(onProfileChange).toHaveBeenCalledWith("pve");
  });

  it("exposes profile, reset, and settings actions without icon-only ambiguity", () => {
    const onLevelChange = vi.fn();
    const onReset = vi.fn();
    const onSettings = vi.fn();

    render(
      <AppShell
        activeProfile="pve"
        activeTab="map"
        level={1}
        onLevelChange={onLevelChange}
        onProfileChange={vi.fn()}
        onReset={onReset}
        onSettings={onSettings}
        onTabChange={vi.fn()}
      >
        <p>지도 화면</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "레벨 증가" }));
    expect(onLevelChange).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: /진행 초기화/ }));
    expect(onReset).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: /설정/ }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
