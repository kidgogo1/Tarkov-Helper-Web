import { useEffect, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { QuantityStepper } from "../../components/QuantityStepper";
import {
  DEFAULT_MINI_MAP_ZOOM_IN_KEY,
  DEFAULT_MINI_MAP_ZOOM_OUT_KEY,
  describeMiniMapShortcut,
  formatMiniMapShortcut,
} from "./minimap-shortcuts";
import type { MapDisplaySettings } from "../../types/state";

interface MapMiniMapSettingsDialogProps {
  open: boolean;
  mapSettings: MapDisplaySettings;
  onClose: () => void;
  onUpdateMapSettings: (patch: Partial<MapDisplaySettings>) => void;
}

export function MapMiniMapSettingsDialog({
  open,
  mapSettings,
  onClose,
  onUpdateMapSettings,
}: MapMiniMapSettingsDialogProps) {
  const [capturing, setCapturing] = useState<"in" | "out" | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCapturing(null);
        return;
      }
      const shortcut = formatMiniMapShortcut(event);
      if (!shortcut) return;
      event.preventDefault();
      onUpdateMapSettings(capturing === "in"
        ? { miniMapZoomInKey: shortcut }
        : { miniMapZoomOutKey: shortcut });
      setCapturing(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [capturing, onUpdateMapSettings]);

  const zoomInKey = describeMiniMapShortcut(mapSettings.miniMapZoomInKey);
  const zoomOutKey = describeMiniMapShortcut(mapSettings.miniMapZoomOutKey);

  return (
    <Dialog
      description="미니맵의 창 크기와 지도 표시 방식을 따로 설정합니다."
      onClose={onClose}
      open={open}
      title="미니맵 설정"
    >
      <section aria-labelledby="minimap-settings-title" className="map-minimap-settings-dialog">
        <h3 id="minimap-settings-title">미니맵 표시</h3>
        <p className="settings-help">
          창 크기는 다음 미니맵 실행부터 적용됩니다. 지도 확대율은 미니맵 안에서 즉시 반영됩니다.
        </p>

        <div className="map-minimap-settings-grid">
          <div className="settings-field">
            <span>미니맵 창 크기 {mapSettings.miniMapWindowSize} × {mapSettings.miniMapWindowSize}px</span>
            <QuantityStepper
              label="미니맵 창 크기"
              max={1000}
              min={240}
              onChange={(miniMapWindowSize) => onUpdateMapSettings({ miniMapWindowSize })}
              value={mapSettings.miniMapWindowSize}
            />
          </div>

          <label>
            <span>미니맵 화면 방식</span>
            <select
              aria-label="미니맵 화면 방식"
              onChange={(event) => onUpdateMapSettings({
                miniMapViewMode: event.target.value as MapDisplaySettings["miniMapViewMode"],
              })}
              value={mapSettings.miniMapViewMode}
            >
              <option value="playerTracking">플레이어 추적</option>
              <option value="fixed">고정</option>
            </select>
          </label>

          <label>
            <span>미니맵 확대율 {Math.round(mapSettings.miniMapZoom * 100)}%</span>
            <input
              aria-label="미니맵 확대율"
              max="1500"
              min="1"
              onChange={(event) => onUpdateMapSettings({
                miniMapZoom: Number(event.target.value) / 100,
              })}
              step="1"
              type="range"
              value={Math.round(mapSettings.miniMapZoom * 100)}
            />
          </label>

          <label>
            <span>미니맵 투명도 {Math.round(mapSettings.miniMapOpacity * 100)}%</span>
            <input
              aria-label="미니맵 투명도"
              max="100"
              min="10"
              onChange={(event) => onUpdateMapSettings({
                miniMapOpacity: Number(event.target.value) / 100,
              })}
              type="range"
              value={Math.round(mapSettings.miniMapOpacity * 100)}
            />
          </label>

          <label>
            <span>미니맵 플레이어 크기 {Math.round(mapSettings.miniMapPlayerMarkerScale * 100)}%</span>
            <input
              aria-label="미니맵 플레이어 크기"
              max="300"
              min="50"
              onChange={(event) => onUpdateMapSettings({
                miniMapPlayerMarkerScale: Number(event.target.value) / 100,
              })}
              type="range"
              value={Math.round(mapSettings.miniMapPlayerMarkerScale * 100)}
            />
          </label>
        </div>

        <fieldset className="map-minimap-shortcuts">
          <legend>미니맵 확대/축소 키</legend>
          <label className="check-row map-minimap-shortcuts-toggle">
            <input
              aria-label="미니맵 키 확대/축소 사용"
              checked={mapSettings.miniMapKeyboardShortcutsEnabled}
              onChange={(event) => onUpdateMapSettings({
                miniMapKeyboardShortcutsEnabled: event.target.checked,
              })}
              type="checkbox"
            />
            <span>키보드 단축키 사용</span>
          </label>
          <p className="settings-help">
            Ctrl, Alt, Shift 또는 Win과 함께 원하는 키를 누르면 미니맵을 확대하거나 축소합니다.
          </p>
          <div className="map-minimap-shortcut-grid">
            <div className="settings-field">
              <span>확대 키</span>
              <button
                aria-label="확대 키 설정"
                className="map-minimap-shortcut-button"
                onClick={() => setCapturing("in")}
                type="button"
              >
                {capturing === "in" ? "키를 누르세요…" : zoomInKey}
              </button>
            </div>
            <div className="settings-field">
              <span>축소 키</span>
              <button
                aria-label="축소 키 설정"
                className="map-minimap-shortcut-button"
                onClick={() => setCapturing("out")}
                type="button"
              >
                {capturing === "out" ? "키를 누르세요…" : zoomOutKey}
              </button>
            </div>
          </div>
          <div className="settings-option-actions">
            <button
              onClick={() => onUpdateMapSettings({
                miniMapZoomInKey: DEFAULT_MINI_MAP_ZOOM_IN_KEY,
                miniMapZoomOutKey: DEFAULT_MINI_MAP_ZOOM_OUT_KEY,
              })}
              type="button"
            >
              기본 키로 초기화
            </button>
          </div>
          {capturing ? (
            <p aria-live="polite" className="settings-key-capture-status">
              조합 키를 누르세요. 취소하려면 Esc를 누르세요.
            </p>
          ) : null}
        </fieldset>

        <div className="settings-option-actions">
          <button
            disabled={mapSettings.miniMapOffsetX === 0 && mapSettings.miniMapOffsetY === 0}
            onClick={() => onUpdateMapSettings({ miniMapOffsetX: 0, miniMapOffsetY: 0 })}
            type="button"
          >
            미니맵 위치 초기화
          </button>
        </div>
      </section>
    </Dialog>
  );
}
