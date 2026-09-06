import { Save, Star } from "lucide-react";
import { useState } from "react";

import {
  loadModdingLibrary,
  removeNamedWeaponPreset,
  saveNamedWeaponPreset,
  setFavoriteWeapon,
  type ModdingLibrary,
  type ModdingLibraryFailureReason,
  type NamedWeaponPreset,
} from "../../services/weapon-modding-library";
import type { WeaponBuild, WeaponCatalogItem } from "../../types/weapon-modding";
import { WeaponItemImage } from "./WeaponItemImage";
import "../../styles/weapon-modding-library.css";

interface WeaponLibraryProps {
  build?: WeaponBuild;
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  onSelectWeapon: (id: string) => void;
  onLoadPreset: (preset: NamedWeaponPreset) => boolean;
}

export function WeaponLibrary({ build, itemById, onSelectWeapon, onLoadPreset }: WeaponLibraryProps) {
  const [stored, setStored] = useState(loadModdingLibrary);
  const [notice, setNotice] = useState("");
  const { library } = stored;
  const currentWeapon = build ? itemById.get(build.weaponId) : undefined;
  const favorites = library.favoriteWeaponIds.flatMap((id) => {
    const item = itemById.get(id);
    return item?.kind === "weapon" ? [item] : [];
  });
  const isFavorite = Boolean(build && library.favoriteWeaponIds.includes(build.weaponId));
  const updateLibrary = (next: ModdingLibrary) => setStored({ ok: true, library: next });
  const toggleFavorite = () => {
    if (!build) return;
    const result = setFavoriteWeapon(build.weaponId, !isFavorite);
    if (result.ok) {
      updateLibrary(result.library);
      setNotice(isFavorite ? "즐겨찾기를 해제했습니다." : "즐겨찾기에 추가했습니다.");
    } else setNotice(libraryFailureMessage(result.reason));
  };
  return (
    <section aria-label="내 총기와 모딩 프로필" className="modding-library">
      <div className="modding-favorites-row">
        <strong><Star aria-hidden="true" size={14} />즐겨찾기</strong>
        <nav aria-label="즐겨찾는 총기">
          {favorites.map((weapon) => (
            <button key={weapon.id} type="button" title={weapon.nameKo ?? weapon.name}
              aria-current={build?.weaponId === weapon.id ? "true" : undefined}
              onClick={() => onSelectWeapon(weapon.id)}>
              <WeaponItemImage alt="" fallbackSize={18} loading="lazy" src={weapon.iconUrl ?? weapon.imageUrl} />
              <span>{weapon.shortName ?? weapon.name}</span>
            </button>
          ))}
          {!favorites.length ? <span>총기를 선택하고 별을 눌러 등록하세요.</span> : null}
        </nav>
        {currentWeapon ? (
          <button className="modding-favorite-toggle" type="button" aria-pressed={isFavorite}
            aria-label={`현재 총기 즐겨찾기 ${isFavorite ? "해제" : "추가"}`} onClick={toggleFavorite}>
            <Star aria-hidden="true" size={15} fill={isFavorite ? "currentColor" : "none"} />
            {currentWeapon.shortName ?? "현재 총기"}
          </button>
        ) : null}
      </div>
      {!stored.ok ? <p className="modding-library-notice" role="alert">
        저장 자료를 읽을 수 없습니다. 기존 자료를 보호하기 위해 덮어쓰지 않습니다.
      </p> : null}
      {notice ? <p className="modding-library-notice" aria-live="polite">{notice}</p> : null}
      {build && currentWeapon ? (
        <NamedBuildControls key={build.weaponId} build={build}
          weaponName={currentWeapon.shortName ?? currentWeapon.name}
          presets={library.presets.filter((preset) => preset.build.weaponId === build.weaponId)}
          onLibraryChange={updateLibrary} onLoadPreset={onLoadPreset} />
      ) : null}
    </section>
  );
}

function NamedBuildControls({ build, weaponName, presets, onLibraryChange, onLoadPreset }: {
  build: WeaponBuild;
  weaponName: string;
  presets: NamedWeaponPreset[];
  onLibraryChange: (library: ModdingLibrary) => void;
  onLoadPreset: (preset: NamedWeaponPreset) => boolean;
}) {
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const selected = presets.find((preset) => preset.id === selectedId);
  const save = (overwrite: boolean) => {
    if (overwrite && (!selected || !window.confirm(`‘${selected.name}’ 모딩을 현재 구성으로 덮어쓸까요?`))) return;
    const result = saveNamedWeaponPreset({ name, build, ...(overwrite ? { id: selectedId } : {}) });
    if (!result.ok) { setNotice(libraryFailureMessage(result.reason)); return; }
    onLibraryChange(result.library);
    setSelectedId(result.preset.id);
    setName(result.preset.name);
    setNotice(`‘${result.preset.name}’ 모딩을 저장했습니다.`);
  };
  const remove = () => {
    if (!selected || !window.confirm(`‘${selected.name}’ 저장 모딩을 삭제할까요? 현재 작업 중인 구성은 유지됩니다.`)) return;
    const result = removeNamedWeaponPreset(selected.id);
    if (!result.ok) { setNotice(libraryFailureMessage(result.reason)); return; }
    onLibraryChange(result.library);
    setSelectedId("");
    setName("");
    setNotice("선택한 저장 모딩을 삭제했습니다. 현재 구성은 그대로입니다.");
  };
  return (
    <section aria-label="모딩 프로필 저장" className="modding-named-builds">
      <header><strong><Save aria-hidden="true" size={14} />{weaponName} 모딩 프로필 · {presets.length}개</strong>
        <small>이 브라우저에 저장 · PVP/PVE 가격은 불러온 화면 기준</small></header>
      <div className="modding-named-build-fields">
        <label><span>모딩 이름</span><input aria-label="모딩 이름" maxLength={80} placeholder="예: 저반동용, 가성비 세팅"
          value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button type="button" disabled={!name.trim()} onClick={() => save(false)}>새 모딩으로 저장</button>
        <label><span>저장한 모딩</span><select aria-label="저장한 모딩" value={selected?.id ?? ""}
          onChange={(event) => {
            const preset = presets.find((entry) => entry.id === event.target.value);
            setSelectedId(preset?.id ?? ""); setName(preset?.name ?? ""); setNotice("");
          }}>
          <option value="">저장한 모딩 선택</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select></label>
        <button type="button" disabled={!selected} onClick={() => {
          if (!selected) return;
          setNotice(onLoadPreset(selected) ? `‘${selected.name}’ 모딩을 불러왔습니다.`
            : "현재 데이터와 호환되지 않아 불러오지 못했습니다. 저장한 원본과 현재 구성은 그대로 유지됩니다.");
        }}>모딩 불러오기</button>
        <button type="button" disabled={!selected || !name.trim()} onClick={() => save(true)}>선택 모딩 덮어쓰기</button>
        <button type="button" disabled={!selected} onClick={remove}>선택 모딩 삭제</button>
      </div>
      <p className="modding-library-help">현재 작업은 자동 보관됩니다. 이름 붙여 저장한 모딩은 다시 저장하기 전까지 바뀌지 않습니다.</p>
      {notice ? <p className="modding-library-notice" aria-live="polite">{notice}</p> : null}
    </section>
  );
}

function libraryFailureMessage(reason: ModdingLibraryFailureReason): string {
  switch (reason) {
    case "duplicate-name": return "같은 이름의 모딩이 있습니다. 다른 이름을 쓰거나 해당 모딩을 선택해 덮어써 주세요.";
    case "limit": return "저장 한도에 도달했습니다. 필요 없는 저장 항목을 정리해 주세요. 기존 자료는 지우지 않았습니다.";
    case "invalid": return "이름이나 모딩 구성 형식을 확인해 주세요.";
    case "not-found": return "선택한 저장 모딩을 찾을 수 없습니다. 화면을 새로고침해 주세요.";
    case "storage": return "저장하지 못했습니다. 브라우저 저장 공간이나 권한을 확인해 주세요. 기존 자료는 그대로 유지됩니다.";
  }
}
