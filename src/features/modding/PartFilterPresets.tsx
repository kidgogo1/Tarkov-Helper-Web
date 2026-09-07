import { useEffect, useState } from "react";

import {
  loadPartFilterPresets,
  MAX_PART_FILTER_PRESETS,
  MAX_PART_FILTER_PRESET_NAME_LENGTH,
  PART_FILTER_PRESETS_STORAGE_KEY,
  removePartFilterPreset,
  savePartFilterPreset,
  type PartFilterPresetSettings,
} from "../../services/part-filter-presets";
import { DEFAULT_PART_CANDIDATE_FILTERS, type CandidateSortKey, type PartCandidateFilters } from "./part-candidate-controls";
import "../../styles/part-filter-presets.css";

const BUILTINS: { name: string; first: string; second: string; sortKeys: CandidateSortKey[] }[] = [
  { name: "반동 우선", first: "반동 감소", second: "인체공학 높은 순", sortKeys: ["recoil", "ergonomics"] },
  { name: "인체공학 우선", first: "인체공학 높은 순", second: "반동 감소", sortKeys: ["ergonomics", "recoil"] },
];

interface PartFilterPresetsProps {
  filters: PartCandidateFilters;
  sortKeys: readonly CandidateSortKey[];
  onApply: (settings: PartFilterPresetSettings) => void;
  traderOptions: readonly { id: string; name: string }[];
}

export function PartFilterPresets({ filters, sortKeys, onApply, traderOptions }: PartFilterPresetsProps) {
  const [stored, setStored] = useState(() => loadPartFilterPresets());
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const selected = stored.presets.find((preset) => preset.id === selectedId);
  const settings = { filters, sortKeys: [...sortKeys] };
  const matchedName = stored.presets.find((preset) => sameSettings(settings, preset))?.name
    ?? BUILTINS.find((preset) => sameSettings(settings, { filters: DEFAULT_PART_CANDIDATE_FILTERS, sortKeys: preset.sortKeys }))?.name;

  useEffect(() => {
    const refresh = () => setStored(loadPartFilterPresets());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PART_FILTER_PRESETS_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const save = (overwrite: boolean) => {
    if (overwrite && (!selected || !window.confirm(`‘${selected.name}’ 필터 프리셋을 현재 설정으로 덮어쓸까요?`))) return;
    const result = savePartFilterPreset({ ...settings, name, ...(overwrite ? { id: selectedId } : {}) });
    if (!result.ok) { setNotice(failureMessage(result.reason)); return; }
    setStored({ ok: true, presets: result.presets });
    setSelectedId(result.preset.id);
    setName(result.preset.name);
    setNotice(`‘${result.preset.name}’ 필터 프리셋을 저장했습니다.`);
  };

  const load = () => {
    // Re-read so a save removed or changed in another tab is never silently resurrected.
    const latest = loadPartFilterPresets();
    setStored(latest);
    if (!latest.ok) { setNotice(failureMessage("storage")); return; }
    const preset = latest.presets.find(({ id }) => id === selectedId);
    if (!preset) { setNotice(failureMessage("not-found")); return; }
    const missingTrader = Boolean(preset.filters.traderId) &&
      !traderOptions.some(({ id }) => id === preset.filters.traderId);
    if (missingTrader && !window.confirm("저장된 상인의 판매 정보가 현재 부위·PVP/PVE 모드에 없습니다. 상인 조건을 ‘전체 상인’으로 바꾸고 나머지 설정을 적용할까요? 저장된 원본은 바뀌지 않습니다.")) {
      setNotice("상인 조건이 맞지 않아 불러오기를 취소했습니다. 현재 설정과 저장 원본은 그대로입니다.");
      return;
    }
    onApply({ filters: { ...preset.filters, traderId: missingTrader ? "" : preset.filters.traderId }, sortKeys: [...preset.sortKeys] });
    setName(preset.name);
    setNotice(missingTrader ? `‘${preset.name}’ 적용 · 상인 조건만 제외했습니다. 저장 원본은 유지됩니다.`
      : `‘${preset.name}’ 필터 프리셋을 불러왔습니다.`);
  };

  const remove = () => {
    if (!selected || !window.confirm(`‘${selected.name}’ 필터 프리셋을 삭제할까요? 현재 적용된 필터는 유지됩니다.`)) return;
    const result = removePartFilterPreset(selected.id);
    if (!result.ok) { setNotice(failureMessage(result.reason)); return; }
    setStored({ ok: true, presets: result.presets });
    setSelectedId(""); setName("");
    setNotice("선택한 필터 프리셋을 삭제했습니다. 현재 필터는 그대로입니다.");
  };

  return <section aria-label="필터 프리셋" className="modding-filter-presets">
    <header><strong>필터 프리셋</strong><span>현재: {matchedName ?? "직접 설정"}</span></header>
    <div className="modding-filter-preset-defaults">
      {BUILTINS.map((preset) => <button key={preset.name} type="button"
        aria-label={`${preset.name} 필터 프리셋 적용`}
        aria-pressed={sameSettings(settings, { filters: DEFAULT_PART_CANDIDATE_FILTERS, sortKeys: preset.sortKeys })}
        onClick={() => {
          onApply({ filters: { ...DEFAULT_PART_CANDIDATE_FILTERS }, sortKeys: [...preset.sortKeys] });
          setNotice(`${preset.name} 적용 · 검색·제한 조건을 초기화하고 두 정렬 기준을 적용했습니다.`);
        }}>
        <strong><b>1</b>{preset.first}</strong><span><b>2</b>{preset.second}</span>
      </button>)}
    </div>
    <p>기본 버튼은 검색·제한 조건을 초기화합니다. 2순위는 1순위 수치가 같을 때 적용됩니다.</p>
    <details className="modding-filter-preset-library">
      <summary>내 필터 프리셋 · {stored.presets.length}/{MAX_PART_FILTER_PRESETS}</summary>
      <div className="modding-filter-preset-fields">
        <label><span>저장한 필터 프리셋</span>
          <select aria-label="저장한 필터 프리셋" value={selected?.id ?? ""} onChange={(event) => {
            const next = stored.presets.find(({ id }) => id === event.target.value);
            setSelectedId(next?.id ?? ""); setName(next?.name ?? ""); setNotice("");
          }}>
            <option value="">저장 항목 선택</option>
            {stored.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        <div className="modding-filter-preset-actions">
          <button type="button" disabled={!stored.ok || !selected} onClick={load}>필터 프리셋 불러오기</button>
          <button type="button" disabled={!stored.ok || !selected} onClick={remove}>선택 필터 프리셋 삭제</button>
        </div>
        <label><span>필터 프리셋 이름</span>
          <input aria-label="필터 프리셋 이름" maxLength={MAX_PART_FILTER_PRESET_NAME_LENGTH}
            placeholder="예: LL2 · 3만원 이하 · 저반동" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="modding-filter-preset-actions">
          <button type="button" disabled={!stored.ok || !name.trim()} onClick={() => save(false)}>새 필터 프리셋 저장</button>
          <button type="button" disabled={!stored.ok || !selected || !name.trim()} onClick={() => save(true)}>선택 필터 프리셋 덮어쓰기</button>
        </div>
        <p>검색어·모든 필터·정렬 순서를 이 브라우저에 저장합니다. 다른 총기에서도 불러올 수 있으며, 총기 조립 프리셋과는 별개입니다.</p>
      </div>
    </details>
    {!stored.ok ? <p role="alert">필터 저장 자료를 읽을 수 없어 저장·삭제를 막았습니다. 기존 자료는 보존되며 기본 프리셋은 사용할 수 있습니다.</p> : null}
    <p aria-live="polite" role="status" aria-label="필터 프리셋 알림" className="modding-filter-preset-notice">{notice}</p>
  </section>;
}

function sameSettings(left: PartFilterPresetSettings, right: PartFilterPresetSettings): boolean {
  const a = left.filters;
  const b = right.filters;
  return a.query === b.query && a.availability === b.availability && a.traderId === b.traderId &&
    a.questRequirement === b.questRequirement && a.maxTraderPrice === b.maxTraderPrice &&
    a.maxFleaPrice === b.maxFleaPrice && a.maxLoyaltyLevel === b.maxLoyaltyLevel &&
    sameSet(a.purchaseFilters, b.purchaseFilters) && sameSet(a.effectFilters, b.effectFilters) &&
    sameSet(a.featureFilters, b.featureFilters) && left.sortKeys.length === right.sortKeys.length &&
    left.sortKeys.every((key, index) => key === right.sortKeys[index]);
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function failureMessage(reason: string): string {
  if (reason === "duplicate-name") return "같은 이름의 필터 프리셋이 있습니다. 다른 이름을 쓰거나 해당 항목을 선택해 덮어써 주세요.";
  if (reason === "limit") return "필터 프리셋 저장 한도에 도달했습니다. 필요 없는 항목을 직접 삭제해 주세요. 기존 자료는 지우지 않았습니다.";
  if (reason === "invalid") return "이름과 필터 설정을 확인해 주세요. 이름은 60자, 검색어는 256자까지 저장할 수 있습니다.";
  if (reason === "not-found") return "선택한 필터 프리셋을 찾을 수 없습니다. 저장 목록을 다시 열어 확인해 주세요.";
  return "필터 프리셋을 읽거나 저장하지 못했습니다. 브라우저 저장 공간·권한을 확인해 주세요. 기존 자료는 보존됩니다.";
}
