import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createDefaultState } from "../../src/app/store";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";

describe("SettingsDialog", () => {
  it("edits profile fields and shows exact bundled source metadata", () => {
    const state = createDefaultState();
    const onUpdateProfile = vi.fn();

    render(
      <SettingsDialog
        dataMeta={{
          originalCommit: "ef71936",
          modifiedCommit: "77ee734",
          exportedAt: "2026-08-07T00:00:00Z",
          counts: { quests: 488, items: 4014, hideoutStations: 26, maps: 12, mapMarkers: 454 },
        }}
        onClose={vi.fn()}
        onLogFiles={vi.fn()}
        onOpenInProgressQuests={vi.fn()}
        onUpdateMapSettings={vi.fn()}
        onUpdateProfile={onUpdateProfile}
        onUpdateSettings={vi.fn()}
        open
        profile={state.profiles.pvp}
        settings={state.settings}
      />,
    );

    expect(
      screen.getByRole("group", { name: "캐릭터 레벨" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "미선택" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "BEAR" }));
    expect(onUpdateProfile).toHaveBeenCalledWith({ faction: "bear" });

    fireEvent.click(screen.getByRole("button", { name: "데이터" }));
    expect(screen.getByText("ef71936")).toBeInTheDocument();
    expect(screen.getByText("77ee734")).toBeInTheDocument();
    expect(screen.getByText("4,014개")).toBeInTheDocument();
    expect(screen.getByText("454개")).toBeInTheDocument();
  });

  it("passes explicitly selected log files to the importer", () => {
    const state = createDefaultState();
    const onLogFiles = vi.fn();

    render(
      <SettingsDialog
        dataMeta={{
          originalCommit: "original",
          modifiedCommit: "modified",
          exportedAt: "2026-08-07T00:00:00Z",
          counts: { quests: 0, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
        }}
        onClose={vi.fn()}
        onLogFiles={onLogFiles}
        onOpenInProgressQuests={vi.fn()}
        onUpdateMapSettings={vi.fn()}
        onUpdateProfile={vi.fn()}
        onUpdateSettings={vi.fn()}
        open
        profile={state.profiles.pvp}
        settings={state.settings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "로그 동기화" }));
    const selectButton = screen.getByRole("button", { name: "로그 파일 선택" });
    selectButton.focus();
    expect(selectButton).toHaveFocus();
    expect(selectButton).toHaveAttribute("type", "button");
    const file = new File(["quest log"], "notifications.log", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("로그 파일 선택"), {
      target: { files: [file] },
    });

    expect(onLogFiles).toHaveBeenCalledWith([file]);
  });

  it("exposes the desktop map marker style, label sizes, and opacity", () => {
    const state = createDefaultState();
    const onUpdateMapSettings = vi.fn();

    render(
      <SettingsDialog
        dataMeta={{
          originalCommit: "original",
          modifiedCommit: "modified",
          exportedAt: "2026-08-07T00:00:00Z",
          counts: { quests: 0, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
        }}
        onClose={vi.fn()}
        onLogFiles={vi.fn()}
        onOpenInProgressQuests={vi.fn()}
        onUpdateMapSettings={onUpdateMapSettings}
        onUpdateProfile={vi.fn()}
        onUpdateSettings={vi.fn()}
        open
        profile={state.profiles.pvp}
        settings={state.settings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "화면" }));
    fireEvent.change(screen.getByRole("combobox", { name: "퀘스트 마커 모양" }), {
      target: { value: "circleWithName" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "커스텀 마커 투명도" }), {
      target: { value: "0.6" },
    });

    expect(onUpdateMapSettings).toHaveBeenCalledWith({ questMarkerStyle: "circleWithName" });
    expect(onUpdateMapSettings).toHaveBeenCalledWith({ customMarkerOpacity: 0.6 });
    expect(screen.getByText("퀘스트 이름 크기")).toBeInTheDocument();
    expect(screen.getByText("탈출구 이름 크기")).toBeInTheDocument();
  });

  it("keeps minimap controls out of the full settings dialog", () => {
    const state = createDefaultState();
    render(
      <SettingsDialog
        dataMeta={{
          originalCommit: "original",
          modifiedCommit: "modified",
          exportedAt: "2026-08-07T00:00:00Z",
          counts: { quests: 0, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
        }}
        onClose={vi.fn()}
        onLogFiles={vi.fn()}
        onOpenInProgressQuests={vi.fn()}
        onUpdateMapSettings={vi.fn()}
        onUpdateProfile={vi.fn()}
        onUpdateSettings={vi.fn()}
        open
        profile={state.profiles.pvp}
        settings={state.settings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "화면" }));

    expect(screen.queryByRole("combobox", { name: "미니맵 화면 방식" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "미니맵 확대율" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "미니맵 위치 초기화" })).not.toBeInTheDocument();
  });

  it("opens manual in-progress quest input from log sync settings", () => {
    const state = createDefaultState();
    const onOpenInProgressQuests = vi.fn();

    render(
      <SettingsDialog
        dataMeta={{
          originalCommit: "original",
          modifiedCommit: "modified",
          exportedAt: "2026-08-07T00:00:00Z",
          counts: { quests: 0, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
        }}
        onClose={vi.fn()}
        onLogFiles={vi.fn()}
        onOpenInProgressQuests={onOpenInProgressQuests}
        onUpdateMapSettings={vi.fn()}
        onUpdateProfile={vi.fn()}
        onUpdateSettings={vi.fn()}
        open
        profile={state.profiles.pvp}
        settings={state.settings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "로그 동기화" }));
    fireEvent.click(screen.getByRole("button", { name: "진행 중인 퀘스트 입력" }));

    expect(onOpenInProgressQuests).toHaveBeenCalledOnce();
  });
});
