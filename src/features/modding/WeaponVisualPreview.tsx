import { useState } from "react";
import type { BuildNode, WeaponCatalogItem, WeaponItem } from "../../types/weapon-modding";
import { WeaponAssemblySlots } from "./WeaponAssemblySlots";
import { WeaponItemImage } from "./WeaponItemImage";
import type { SlotSelection } from "./WeaponSlotTree";
import { useWeaponPreview, type PreviewAngle } from "./use-weapon-preview";
import "../../styles/weapon-visual-preview.css";

interface Props {
  root: BuildNode;
  weapon: WeaponItem;
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  selectedSlot: SlotSelection | null;
  onSelect: (selection: SlotSelection) => void;
}

export function WeaponVisualPreview({ root, weapon, itemById, selectedSlot, onSelect }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [angle, setAngle] = useState<PreviewAngle>(0);
  const [failedImage, setFailedImage] = useState<string>();
  const preview = useWeaponPreview(root, enabled, angle);
  const currentImage = preview.imageUrl !== failedImage ? preview.imageUrl : undefined;
  const imageError = Boolean(preview.imageUrl && preview.imageUrl === failedImage);
  const name = weapon.nameKo ?? weapon.name;
  const retry = () => { setFailedImage(undefined); preview.retry(); };

  return <div className="modding-visual-preview">
    <div className="modding-preview-controls">
      <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        조립 외형 자동 갱신 <small>실험 기능</small></label>
      {enabled && <div role="group" aria-label="조립 이미지 각도">
        {([-30, 0, 30] as const).map((value) => <button type="button" key={value}
          aria-pressed={angle === value} onClick={() => setAngle(value)}>
          {value === 0 ? "측면" : `${value > 0 ? "+" : ""}${value}°`}
        </button>)}
      </div>}
    </div>
    <p className="modding-preview-disclosure">켜면 총기·부품 ID와 장착 구조·각도만 Tarkov Image Generator로 전송합니다. 게임 로그·프로필은 보내지 않습니다.</p>
    <WeaponAssemblySlots itemById={itemById} root={root} slots={weapon.slots}
      selectedSlot={selectedSlot} onSelect={onSelect} angled={Boolean(currentImage && angle !== 0)}>
      <figure className="modding-preview-figure" aria-busy={preview.status === "loading"}>
        {currentImage ? <img alt={`${name} 현재 조립 외형 · ${angle}도`} src={currentImage}
          onError={() => setFailedImage(currentImage)} /> :
          <WeaponItemImage alt={`${name} 상점 기본 외형`} fallbackSize={64} src={weapon.factoryImageUrl ?? weapon.imageUrl} />}
        <figcaption>{currentImage ? "현재 조립 외형 · 각도별 생성 이미지" : "상점 기본 외형 · 현재 모딩 외형이 아닙니다"}</figcaption>
      </figure>
    </WeaponAssemblySlots>
    <div className="modding-preview-status" role={enabled ? "status" : undefined} aria-live={enabled ? "polite" : "off"}>
      {preview.status === "loading" ? "현재 조립 이미지를 생성하고 있습니다… 완료 전에는 기본 외형을 표시합니다." : null}
      {preview.error || imageError ? <><span>{imageError ? "생성 이미지를 표시할 수 없습니다. 기본 외형으로 돌아왔습니다." : preview.error}</span>
        <button type="button" onClick={retry}>이미지 다시 시도</button></> : null}
      {currentImage ? "부품 교체 후 잠시 기다리면 외형이 갱신됩니다. 자유 회전 3D가 아닌 각도별 정지 이미지입니다." : null}
    </div>
  </div>;
}
