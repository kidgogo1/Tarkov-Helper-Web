import { Dialog } from "../../components/Dialog";
import { QuantityStepper } from "../../components/QuantityStepper";
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
              max="400"
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
