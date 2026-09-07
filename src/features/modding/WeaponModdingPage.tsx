import { LoaderCircle, Search, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createFactoryBuild,
  flattenBuildTree,
  validateWeaponBuild,
} from "../../domain/weapon-build";
import {
  loadWeaponBuild,
  saveWeaponBuild,
} from "../../services/weapon-build-storage";
import { recordClientDiagnostic } from "../../services/client-diagnostics";
import {
  loadWeaponModCatalog,
  type WeaponModCatalogFailureCode,
} from "../../services/weapon-mod-data";
import type { ProfileType } from "../../types/data";
import type {
  WeaponBuild,
  WeaponCatalog,
  WeaponCatalogItem,
} from "../../types/weapon-modding";
import { WeaponWorkbench } from "./WeaponWorkbench";
import { WeaponLibrary } from "./WeaponLibrary";
import { WeaponItemImage } from "./WeaponItemImage";
import type { SlotSelection } from "./WeaponSlotTree";
import { useWeaponBuildHistory } from "./use-weapon-build-history";
import { sameBuildAssembly } from "./weapon-build-history";

interface WeaponModdingPageProps {
  activeProfile: ProfileType;
  focusWeaponId?: string;
  loadCatalog?: (signal?: AbortSignal) => Promise<WeaponCatalog>;
  onWeaponSelect?: (weaponId: string) => void;
}

export function WeaponModdingPage({
  activeProfile,
  focusWeaponId,
  loadCatalog,
  onWeaponSelect,
}: WeaponModdingPageProps) {
  const [catalog, setCatalog] = useState<WeaponCatalog>();
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState({ focusWeaponId, weaponId: focusWeaponId });
  const [selectedSlot, setSelectedSlot] = useState<SlotSelection | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const reportFailure = (code: WeaponModCatalogFailureCode) => {
      recordClientDiagnostic({
        source: "data",
        code: `WEAPON_MOD_${code}`,
        message: `Weapon modding catalog failed: ${code}`,
        operation: "LOAD_WEAPON_MOD_CATALOG",
      });
    };
    const request = loadCatalog
      ? loadCatalog(controller.signal)
      : loadWeaponModCatalog(controller.signal, fetch, reportFailure);
    request
      .then((nextCatalog) => {
        if (nextCatalog.dataVersion === "unavailable") {
          setCatalog(undefined);
          setError("설치된 데이터 묶음이 누락되었거나 현재 버전과 호환되지 않습니다.");
          return;
        }
        setCatalog(nextCatalog);
        setError(undefined);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        recordClientDiagnostic({
          source: "data",
          code: "WEAPON_MOD_CATALOG_LOAD_FAILED",
          error: loadError,
          message: "Weapon modding catalog load failed.",
          operation: "LOAD_WEAPON_MOD_CATALOG",
        });
        setError(loadError instanceof Error ? loadError.message : "알 수 없는 오류");
      });
    return () => controller.abort();
  }, [loadCatalog]);

  const itemById = useMemo(
    () => new Map(catalog?.items.map((item) => [item.id, item]) ?? []),
    [catalog],
  );

  const weapons = useMemo(() => {
    if (!catalog) return [];
    const needle = search.normalize("NFKC").trim().toLocaleLowerCase();
    return catalog.weaponIds
      .map((id) => itemById.get(id))
      .filter((item): item is WeaponCatalogItem => Boolean(item?.kind === "weapon"))
      .filter((item) => !needle || [
        item.name,
        item.nameEn,
        item.nameKo,
        item.shortName,
      ].some((value) => value?.normalize("NFKC").toLocaleLowerCase().includes(needle)))
      .sort((left, right) => (left.nameKo ?? left.name).localeCompare(
        right.nameKo ?? right.name,
        "ko",
      ));
  }, [catalog, itemById, search]);

  // A changed deep link replaces the editor context before rendering its controls.
  const selectedWeaponId = selection.focusWeaponId === focusWeaponId
    ? selection.weaponId
    : focusWeaponId;
  if (selection.focusWeaponId !== focusWeaponId) {
    setSelection({ focusWeaponId, weaponId: focusWeaponId });
    setSelectedSlot(null);
  }
  const initialBuild = useMemo(() => (
    catalog && selectedWeaponId && catalog.weaponIds.includes(selectedWeaponId)
      ? restoreOrCreateBuild(catalog, selectedWeaponId)
      : undefined
  ), [catalog, selectedWeaponId]);
  const editor = useWeaponBuildHistory(initialBuild);
  const displayedBuild = editor.build;
  const selectedParent = displayedBuild && selectedSlot
    ? flattenBuildTree(displayedBuild.root).find((node) => node.instanceId === selectedSlot.parentInstanceId)
    : undefined;
  const displayedSlot = selectedParent && itemById.get(selectedParent.itemId)?.slots?.some(
    (slot) => slot.id === selectedSlot?.slotId,
  ) ? selectedSlot : null;

  const selectWeapon = (weaponId: string) => {
    if (!catalog?.weaponIds.includes(weaponId)) return;
    setSelection({ focusWeaponId, weaponId });
    setSelectedSlot(null);
    onWeaponSelect?.(weaponId);
  };

  const persistBuild = (nextBuild: WeaponBuild | undefined) => {
    if (!nextBuild) return;
    if (!saveWeaponBuild(nextBuild)) setStorageWarning(true);
  };

  const updateBuild = (nextBuild: WeaponBuild) => persistBuild(editor.commit(nextBuild));

  const restoreHistory = (direction: "undo" | "redo") => {
    const nextBuild = editor[direction]();
    if (!nextBuild) return;
    persistBuild(nextBuild);
    setSelectedSlot(null);
  };

  const resetBuild = () => {
    if (!catalog || !displayedBuild) return;
    const factoryBuild = createFactoryBuild(catalog, displayedBuild.weaponId);
    if (sameBuildAssembly(displayedBuild, factoryBuild)) return;
    if (!window.confirm("현재 작업을 상점 기본 구성으로 초기화할까요? 실행 취소로 복원할 수 있으며, 이름 붙여 저장한 모딩은 바뀌지 않습니다.")) return;
    updateBuild(factoryBuild);
    setSelectedSlot(null);
  };

  if (error) {
    return (
      <section className="modding-page">
        <div className="modding-load-state error" role="alert">
          <TriangleAlert aria-hidden="true" size={30} />
          <strong>무기 모딩 자료를 불러오지 못했습니다.</strong>
          <span>{error}</span>
          <span>퀘스트·지도·아이템 기능에는 영향을 주지 않습니다.</span>
        </div>
      </section>
    );
  }
  if (!catalog) {
    return (
      <section className="modding-page">
        <div aria-busy="true" className="modding-load-state">
          <LoaderCircle aria-hidden="true" className="spin" size={30} />
          <strong>무기 모딩 자료를 불러오는 중…</strong>
        </div>
      </section>
    );
  }

  return (
    <section className="modding-page">
      <header className="modding-page-header">
        <div>
          <span className="eyebrow"><Wrench aria-hidden="true" size={15} /> WORKBENCH</span>
          <h1>무기 모딩</h1>
          <p>부위를 선택해 호환 부품을 조립하고 외형·성능·추가 구매 비용을 비교합니다.</p>
          <small className="modding-data-note">
            {`가격·호환성 데이터: 번들 기준 ${formatCatalogDate(catalog.dataVersion)} · 실시간 아님`}
          </small>
        </div>
        <label className="modding-weapon-search">
          <span>총기 검색</span>
          <div>
            <Search aria-hidden="true" size={16} />
            <input
              aria-label="총기 검색"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="M4A1, AK-74, MPX…"
              type="search"
              value={search}
            />
          </div>
        </label>
      </header>

      {storageWarning ? (
        <p className="modding-storage-warning" role="status">
          이 브라우저에서는 모딩 구성을 저장할 수 없습니다. 현재 화면에서는 계속 사용할 수 있습니다.
        </p>
      ) : null}

      {!catalog.weaponIds.length ? (
        <div className="modding-load-state">
          <strong>사용 가능한 총기가 없습니다</strong>
          <span>모딩 데이터 묶음을 새로 고친 뒤 다시 시도하세요.</span>
        </div>
      ) : (
        <>
          <WeaponLibrary build={displayedBuild} itemById={itemById} onSelectWeapon={selectWeapon}
            onLoadPreset={(preset) => {
              const migrated = { ...preset.build, catalogDataVersion: catalog.dataVersion };
              if (validateWeaponBuild(catalog, migrated).issues.some((issue) => issue.code !== "MISSING_REQUIRED_SLOT")) return false;
              updateBuild(migrated);
              setSelectedSlot(null);
              return true;
            }} />
          <nav aria-label="총기 선택" className="modding-weapon-list">
            {weapons.length ? weapons.map((weapon) => (
              <button
                aria-current={displayedBuild?.weaponId === weapon.id ? "true" : undefined}
                className={displayedBuild?.weaponId === weapon.id ? "active" : ""}
                key={weapon.id}
                onClick={() => selectWeapon(weapon.id)}
                type="button"
              >
                <span aria-hidden="true">
                  <WeaponItemImage
                    alt=""
                    fallbackSize={22}
                    loading="lazy"
                    src={weapon.iconUrl ?? weapon.imageUrl}
                  />
                </span>
                <strong>{weapon.nameKo ?? weapon.name}</strong>
                <small>{weapon.shortName ?? weapon.nameEn ?? weapon.name}</small>
              </button>
            )) : <p>조건에 맞는 총기가 없습니다</p>}
          </nav>

          {displayedBuild ? (
            <WeaponWorkbench
              activeProfile={activeProfile}
              build={displayedBuild}
              catalog={catalog}
              itemById={itemById}
              key={displayedBuild.weaponId}
              onBuildChange={updateBuild}
              canUndo={editor.canUndo}
              canRedo={editor.canRedo}
              onUndo={() => restoreHistory("undo")}
              onRedo={() => restoreHistory("redo")}
              onReset={resetBuild}
              onSlotSelect={setSelectedSlot}
              selectedSlot={displayedSlot}
            />
          ) : (
            <div className="modding-empty-workbench">
              <Wrench aria-hidden="true" size={42} />
              <strong>총기를 선택하세요</strong>
              <span>선택한 총기의 상점 기본 외형과 장착 슬롯이 여기에 표시됩니다.</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function restoreOrCreateBuild(catalog: WeaponCatalog, weaponId: string): WeaponBuild {
  const saved = loadWeaponBuild(weaponId);
  if (saved) {
    const migrated = { ...saved, catalogDataVersion: catalog.dataVersion };
    // An unfinished draft is not a corrupt build. Keep missing required slots so
    // returning to this weapon does not silently undo the user's work.
    const validation = validateWeaponBuild(catalog, migrated);
    if (validation.issues.every((issue) => issue.code === "MISSING_REQUIRED_SLOT")) return migrated;
  }
  return createFactoryBuild(catalog, weaponId);
}

function formatCatalogDate(dataVersion: string): string {
  const date = dataVersion.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return date ?? dataVersion;
}
