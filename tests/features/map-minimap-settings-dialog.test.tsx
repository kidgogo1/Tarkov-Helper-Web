import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppStoreProvider, createDefaultState } from "../../src/app/store";
import { MapMiniMapSettingsDialog } from "../../src/features/map/MapMiniMapSettingsDialog";

describe("MapMiniMapSettingsDialog", () => {
  it("edits the independent size and display controls without opening the full settings dialog", () => {
    const settings = createDefaultState().settings.map;
    const onUpdateMapSettings = vi.fn();

    render(
      <AppStoreProvider>
        <MapMiniMapSettingsDialog
          mapSettings={settings}
          onClose={vi.fn()}
          onUpdateMapSettings={onUpdateMapSettings}
          open
        />
      </AppStoreProvider>,
    );

    expect(screen.getByRole("dialog", { name: "미니맵 설정" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton", { name: "미니맵 창 크기" }), {
      target: { value: "480" },
    });
    const zoom = screen.getByRole("slider", { name: "미니맵 확대율" });
    expect(zoom).toHaveAttribute("max", "1500");
    fireEvent.change(zoom, {
      target: { value: "180" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "미니맵 화면 방식" }), {
      target: { value: "fixed" },
    });

    expect(onUpdateMapSettings).toHaveBeenCalledWith({ miniMapWindowSize: 480 });
    expect(onUpdateMapSettings).toHaveBeenCalledWith({ miniMapZoom: 1.8 });
    expect(onUpdateMapSettings).toHaveBeenCalledWith({ miniMapViewMode: "fixed" });
  });
});
