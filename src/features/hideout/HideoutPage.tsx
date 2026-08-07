import {
  Check,
  Clock3,
  Hammer,
  Package,
  Search,
  ShieldCheck,
  Users,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "../../components/EmptyState";
import { QuantityStepper } from "../../components/QuantityStepper";
import { useAppStore } from "../../app/store";
import type {
  HideoutItemRequirement,
  HideoutLevel,
  HideoutStation,
  TarkovData,
} from "../../types/data";

interface HideoutPageProps {
  data: TarkovData;
}

function stationName(station: HideoutStation): string {
  return station.nameKo?.trim() || station.name;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "즉시";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days}일` : "", hours ? `${hours}시간` : "", minutes ? `${minutes}분` : ""]
    .filter(Boolean)
    .join(" ");
}

export function HideoutPage({ data }: HideoutPageProps) {
  const { profile, setHideoutLevel, setInventory } = useAppStore();
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState(data.hideoutStations[0]?.id ?? "");
  const [showAllRemaining, setShowAllRemaining] = useState(false);

  const filteredStations = useMemo(() => {
    const needle = searchText.trim().toLocaleLowerCase();
    if (!needle) return data.hideoutStations;
    return data.hideoutStations.filter((station) =>
      [station.name, station.nameKo, station.nameJa]
        .filter(Boolean)
        .some((name) => name!.toLocaleLowerCase().includes(needle)),
    );
  }, [data.hideoutStations, searchText]);

  const selected = data.hideoutStations.find((station) => station.id === selectedId)
    ?? filteredStations[0]
    ?? null;

  const statistics = useMemo(() => {
    let completed = 0;
    let started = 0;
    let levels = 0;
    let completedLevels = 0;
    for (const station of data.hideoutStations) {
      const level = profile.hideoutLevels[station.id] ?? 0;
      levels += station.maxLevel;
      completedLevels += Math.min(level, station.maxLevel);
      if (level >= station.maxLevel) completed += 1;
      else if (level > 0) started += 1;
    }
    return { completed, started, levels, completedLevels };
  }, [data.hideoutStations, profile.hideoutLevels]);

  const visibleLevels = selected
    ? selected.levels.filter((level) => level.level > (profile.hideoutLevels[selected.id] ?? 0))
    : [];
  const displayedLevels = showAllRemaining ? visibleLevels : visibleLevels.slice(0, 1);

  return (
    <section className="tracker-page hideout-page" aria-labelledby="hideout-title">
      <div className="page-toolbar panel">
        <div className="search-field">
          <Search aria-hidden="true" size={16} />
          <input
            aria-label="은신처 시설 검색"
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="시설 이름 검색"
            type="search"
            value={searchText}
          />
        </div>
        <div className="summary-line" id="hideout-title">
          <span>모듈 <strong>{data.hideoutStations.length}</strong></span>
          <span>완료 <strong>{statistics.completed}</strong></span>
          <span>진행 중 <strong>{statistics.started}</strong></span>
          <span>레벨 <strong>{statistics.completedLevels}/{statistics.levels}</strong></span>
        </div>
      </div>

      <div className="tracker-split">
        <div className="tracker-list panel" aria-label="은신처 시설 목록">
          {filteredStations.length ? filteredStations.map((station) => {
            const currentLevel = profile.hideoutLevels[station.id] ?? 0;
            const displayName = stationName(station);
            const selectedStation = selected?.id === station.id;
            return (
              <article
                className={`station-row${selectedStation ? " selected" : ""}`}
                key={station.id}
              >
                <button
                  aria-pressed={selectedStation}
                  className="station-select ghost"
                  onClick={() => setSelectedId(station.id)}
                  type="button"
                >
                  <span className="station-icon">
                    {station.localIcon ? (
                      <img alt="" src={station.localIcon} />
                    ) : (
                      <Hammer aria-hidden="true" size={20} />
                    )}
                  </span>
                  <span className="station-name">
                    <strong>{displayName}</strong>
                    {displayName !== station.name ? <small>{station.name}</small> : null}
                  </span>
                </button>
                <div className="station-level-control">
                  <strong>{currentLevel} / {station.maxLevel}</strong>
                  <QuantityStepper
                    compact
                    label={`${displayName} 레벨`}
                    max={station.maxLevel}
                    onChange={(level) => setHideoutLevel(station.id, level)}
                    value={currentLevel}
                  />
                </div>
              </article>
            );
          }) : (
            <EmptyState icon={<Search size={24} />} title="검색 결과가 없습니다" />
          )}
        </div>

        <aside className="tracker-detail panel" aria-live="polite">
          {selected ? (
            <>
              <header className="detail-header">
                <div>
                  <span className="eyebrow">HIDEOUT MODULE</span>
                  <h2>{stationName(selected)}</h2>
                  <p>{selected.name}</p>
                </div>
                <span className={visibleLevels.length ? "level-chip" : "level-chip complete"}>
                  {profile.hideoutLevels[selected.id] ?? 0} / {selected.maxLevel}
                </span>
              </header>

              {visibleLevels.length ? (
                <>
                  <div className="detail-mode-switch" role="group" aria-label="요구 사항 범위">
                    <button
                      aria-pressed={!showAllRemaining}
                      className={!showAllRemaining ? "active" : ""}
                      onClick={() => setShowAllRemaining(false)}
                      type="button"
                    >
                      다음 레벨
                    </button>
                    <button
                      aria-pressed={showAllRemaining}
                      className={showAllRemaining ? "active" : ""}
                      onClick={() => setShowAllRemaining(true)}
                      type="button"
                    >
                      남은 전체
                    </button>
                  </div>
                  <div className="requirements-scroll">
                    {displayedLevels.map((level) => (
                      <LevelRequirements
                        data={data}
                        key={level.id}
                        level={level}
                        profile={profile}
                        setInventory={setInventory}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={<ShieldCheck size={28} />}
                  title="모든 업그레이드 완료"
                  description="이 시설에 남은 요구 사항이 없습니다."
                />
              )}
            </>
          ) : (
            <EmptyState icon={<Wrench size={28} />} title="시설을 선택하세요" />
          )}
        </aside>
      </div>
    </section>
  );
}

interface LevelRequirementsProps {
  data: TarkovData;
  level: HideoutLevel;
  profile: ReturnType<typeof useAppStore>["profile"];
  setInventory: ReturnType<typeof useAppStore>["setInventory"];
}

function LevelRequirements({ data, level, profile, setInventory }: LevelRequirementsProps) {
  return (
    <section className="level-requirements">
      <header>
        <h3>레벨 {level.level}</h3>
        <span><Clock3 aria-hidden="true" size={14} /> {formatDuration(level.constructionTime)}</span>
      </header>

      {level.items.length ? (
        <div className="requirement-group">
          <h4><Package aria-hidden="true" size={15} /> 아이템</h4>
          {level.items.map((requirement) => (
            <HideoutItemRow
              data={data}
              key={requirement.id}
              profile={profile}
              requirement={requirement}
              setInventory={setInventory}
            />
          ))}
        </div>
      ) : null}

      {level.stations.length ? (
        <div className="requirement-group">
          <h4><Hammer aria-hidden="true" size={15} /> 시설</h4>
          {level.stations.map((requirement) => {
            const current = profile.hideoutLevels[requirement.stationId] ?? 0;
            const met = current >= requirement.requiredLevel;
            return (
              <div className={`simple-requirement${met ? " met" : ""}`} key={requirement.id}>
                <Check aria-hidden="true" size={14} />
                <span>{requirement.stationNameKo?.trim() || requirement.stationName}</span>
                <strong>Lv.{current} / {requirement.requiredLevel}</strong>
              </div>
            );
          })}
        </div>
      ) : null}

      {level.traders.length ? (
        <div className="requirement-group">
          <h4><Users aria-hidden="true" size={15} /> 상인</h4>
          {level.traders.map((requirement) => (
            <div className="simple-requirement" key={requirement.id}>
              <span>{requirement.nameKo?.trim() || requirement.name}</span>
              <strong>우호도 Lv.{requirement.requiredLevel}</strong>
            </div>
          ))}
        </div>
      ) : null}

      {level.skills.length ? (
        <div className="requirement-group">
          <h4><Wrench aria-hidden="true" size={15} /> 스킬</h4>
          {level.skills.map((requirement) => (
            <div className="simple-requirement" key={requirement.id}>
              <span>{requirement.nameKo?.trim() || requirement.name}</span>
              <strong>Lv.{requirement.requiredLevel}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface HideoutItemRowProps {
  data: TarkovData;
  requirement: HideoutItemRequirement;
  profile: ReturnType<typeof useAppStore>["profile"];
  setInventory: ReturnType<typeof useAppStore>["setInventory"];
}

function HideoutItemRow({ data, requirement, profile, setInventory }: HideoutItemRowProps) {
  const item = data.items.find((candidate) => candidate.id === requirement.itemId);
  const amount = profile.inventory[requirement.itemId] ?? { fir: 0, nonFir: 0 };
  const owned = requirement.foundInRaid ? amount.fir : amount.fir + amount.nonFir;
  const met = owned >= requirement.count;
  const name = requirement.itemNameKo?.trim() || item?.nameKo?.trim() || requirement.itemName;

  return (
    <div
      className={`hideout-item-row${met ? " met" : ""}`}
      data-testid={`hideout-item-${requirement.itemId}`}
    >
      <span className="requirement-icon">
        {item?.localIcon ? <img alt="" src={item.localIcon} /> : <Package aria-hidden="true" size={18} />}
      </span>
      <span className="requirement-name">
        <strong>{name}</strong>
        <small>
          {owned} / {requirement.count} 보유
          {requirement.foundInRaid ? <span className="fir-label"> FIR</span> : null}
        </small>
      </span>
      <div className="requirement-inventory">
        {requirement.foundInRaid ? (
          <QuantityStepper
            compact
            label={`${name} FIR 보유량`}
            onChange={(fir) => setInventory(requirement.itemId, { ...amount, fir })}
            value={amount.fir}
          />
        ) : (
          <QuantityStepper
            compact
            label={`${name} 보유량`}
            onChange={(nonFir) => setInventory(requirement.itemId, { ...amount, nonFir })}
            value={amount.nonFir}
          />
        )}
      </div>
    </div>
  );
}

