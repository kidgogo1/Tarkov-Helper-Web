import { KeyRound, Trash2 } from "lucide-react";
import type { FormEvent } from "react";

import { Dialog } from "../../components/Dialog";
import type { ItemData, MapConfig } from "../../types/data";
import type { KeyMapMarker } from "../../types/state";

function itemIconUrl(item: ItemData): string | undefined {
  if (!item.localIcon) return undefined;
  return `${import.meta.env.BASE_URL}${item.localIcon.replace(/^\/+/, "")}`;
}

function itemLabel(item: ItemData): string {
  return item.shortNameKo || item.shortNameEn || item.nameKo || item.nameEn || item.name;
}

interface KeyMarkerEditorProps {
  editor: { marker: KeyMapMarker; isNew: boolean };
  itemOptions: readonly ItemData[];
  floors: readonly MapConfig["floors"][number][];
  onCancel: () => void;
  onChange: (marker: KeyMapMarker) => void;
  onDelete?: () => void;
  onReposition?: () => void;
  onSave: () => void;
}

export function KeyMarkerEditor({
  editor,
  itemOptions,
  floors,
  onCancel,
  onChange,
  onDelete,
  onReposition,
  onSave,
}: KeyMarkerEditorProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editor.marker.itemId) onSave();
  };
  const selectedItem = itemOptions.find((item) => item.id === editor.marker.itemId);

  return (
    <Dialog
      description="위치를 직접 클릭해 저장한 프로필 전용 키 위치입니다. 실제 위치와 다르면 다시 편집해 주세요."
      footer={
        <>
          {onDelete ? (
            <button className="danger map-delete-marker" onClick={onDelete} type="button">
              <Trash2 aria-hidden="true" size={16} /> 위치 삭제
            </button>
          ) : null}
          <span className="map-dialog-spacer" />
          <button onClick={onCancel} type="button">취소</button>
          <button
            className="primary"
            disabled={!editor.marker.itemId}
            form="key-marker-form"
            type="submit"
          >
            위치 저장
          </button>
        </>
      }
      onClose={onCancel}
      open
      title={editor.isNew ? "키 위치 등록" : "키 위치 수정"}
    >
      <form className="map-marker-form" id="key-marker-form" onSubmit={submit}>
        <label className="map-field">
          <span>키 또는 키카드</span>
          <select
            aria-label="키 또는 키카드"
            onChange={(event) => onChange({ ...editor.marker, itemId: event.target.value })}
            value={editor.marker.itemId}
          >
            <option value="">키를 선택하세요</option>
            {itemOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {itemLabel(item)} — {item.nameEn || item.name}
              </option>
            ))}
          </select>
        </label>

        {selectedItem ? (
          <div className="map-key-editor-item" role="status">
            {itemIconUrl(selectedItem) ? (
              <img alt="" src={itemIconUrl(selectedItem)} />
            ) : (
              <KeyRound aria-hidden="true" size={20} />
            )}
            <span>
              <strong>{itemLabel(selectedItem)}</strong>
              <small>{selectedItem.nameEn || selectedItem.name}</small>
            </span>
          </div>
        ) : null}

        <div className="map-dialog-grid">
          <label className="map-field">
            <span>층</span>
            <select
              aria-label="키 마커 층"
              disabled={floors.length === 0}
              onChange={(event) => onChange({
                ...editor.marker,
                floorId: event.target.value || undefined,
              })}
              value={editor.marker.floorId ?? ""}
            >
              {floors.length === 0 ? <option value="">단일 층</option> : null}
              {floors.map((floor) => (
                <option key={floor.layerId} value={floor.layerId}>{floor.displayName}</option>
              ))}
            </select>
          </label>
          <label className="map-field">
            <span>방/건물 이름</span>
            <input
              aria-label="방 또는 건물 이름"
              maxLength={120}
              onChange={(event) => onChange({ ...editor.marker, roomName: event.target.value })}
              placeholder="예: 기숙사 103호"
              type="text"
              value={editor.marker.roomName ?? ""}
            />
          </label>
        </div>

        <label className="map-field">
          <span>귀중품 방 여부</span>
          <select
            aria-label="귀중품 방 여부"
            onChange={(event) => onChange({
              ...editor.marker,
              lootTier: event.target.value === "high" ? "high" : "normal",
            })}
            value={editor.marker.lootTier}
          >
            <option value="normal">일반 방</option>
            <option value="high">귀중품이 잘 나오는 방</option>
          </select>
        </label>

        <label className="map-field">
          <span>메모</span>
          <textarea
            aria-label="키 위치 메모"
            maxLength={500}
            onChange={(event) => onChange({ ...editor.marker, note: event.target.value })}
            placeholder="예: 문 앞 금고 2개, 열쇠 사용 후 내부 확인"
            rows={3}
            value={editor.marker.note ?? ""}
          />
        </label>

        <div className="map-dialog-coordinates">
          <span>X {editor.marker.x.toFixed(1)} · Y {editor.marker.y.toFixed(1)} · Z {editor.marker.z.toFixed(1)}</span>
          {onReposition ? (
            <button className="ghost map-reposition-button" onClick={onReposition} type="button">
              지도에서 위치 다시 지정
            </button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
