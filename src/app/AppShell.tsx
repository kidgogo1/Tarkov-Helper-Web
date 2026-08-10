import {
  Boxes,
  BadgeDollarSign,
  House,
  ListChecks,
  Map,
  RotateCcw,
  Settings,
  Trophy,
} from "lucide-react";
import { useRef } from "react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";

import { QuantityStepper } from "../components/QuantityStepper";
import type { ProfileType } from "../types/data";
import packageManifest from "../../package.json";

export type AppTab = "quests" | "hideout" | "items" | "collector" | "prices" | "map";

interface AppShellProps {
  activeTab: AppTab;
  activeProfile: ProfileType;
  level: number;
  children: ReactNode;
  onTabChange: (tab: AppTab) => void;
  onProfileChange: (profile: ProfileType) => void;
  onLevelChange: (level: number) => void;
  onReset: () => void;
  onSettings: () => void;
  storageWarning?: boolean;
}

interface TabDefinition {
  id: AppTab;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: "true" }>;
}

const TABS: readonly TabDefinition[] = [
  { id: "quests", label: "퀘스트", icon: ListChecks },
  { id: "hideout", label: "은신처", icon: House },
  { id: "items", label: "아이템", icon: Boxes },
  { id: "collector", label: "수집가 · 카파", icon: Trophy },
  { id: "prices", label: "시세", icon: BadgeDollarSign },
  { id: "map", label: "지도", icon: Map },
];

export function AppShell({
  activeTab,
  activeProfile,
  level,
  children,
  onTabChange,
  onProfileChange,
  onLevelChange,
  onReset,
  onSettings,
  storageWarning = false,
}: AppShellProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + TABS.length) % TABS.length;
        break;
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = TABS.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = TABS[nextIndex];
    tabRefs.current[nextIndex]?.focus();
    onTabChange(nextTab.id);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="topbar">
          <button className="brand ghost" onClick={() => onTabChange("quests")} type="button">
            <span aria-hidden="true" className="brand-mark">TH</span>
            <span>
              <strong>TARKOV HELPER</strong>
              <small>QUEST &amp; HIDEOUT TRACKER</small>
            </span>
            <span aria-label={`앱 버전 ${packageManifest.version}`} className="brand-version">
              v{packageManifest.version}
            </span>
          </button>

          <div className="profile-switch" aria-label="게임 모드" role="group">
            <button
              aria-label="PVP 프로필"
              aria-pressed={activeProfile === "pvp"}
              className={activeProfile === "pvp" ? "active pvp" : ""}
              onClick={() => onProfileChange("pvp")}
              type="button"
            >
              PVP
            </button>
            <button
              aria-label="PVE 프로필"
              aria-pressed={activeProfile === "pve"}
              className={activeProfile === "pve" ? "active" : ""}
              onClick={() => onProfileChange("pve")}
              type="button"
            >
              PVE
            </button>
          </div>

          <div className="header-actions">
            <div className="level-control">
              <span>Lv.</span>
              <QuantityStepper
                compact
                label="레벨"
                max={79}
                min={1}
                onChange={onLevelChange}
                value={level}
              />
            </div>
            <button onClick={onReset} type="button">
              <RotateCcw aria-hidden="true" size={15} />
              <span>진행 초기화</span>
            </button>
            <button onClick={onSettings} type="button">
              <Settings aria-hidden="true" size={16} />
              <span>설정</span>
            </button>
          </div>
        </div>

        <nav aria-label="주요 화면" className="app-tabs" role="tablist">
          {TABS.map((tab, index) => {
            const Icon = tab.icon;
            return (
              <button
                aria-controls={`app-panel-${tab.id}`}
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? "active" : ""}
                id={`app-tab-${tab.id}`}
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                role="tab"
                tabIndex={activeTab === tab.id ? 0 : -1}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      {storageWarning ? (
        <div className="app-storage-warning" role="alert">
          브라우저 저장공간을 사용할 수 없습니다. 현재 변경 내용은 임시로만 유지될 수 있으니
          시크릿 모드를 끄고 이 사이트의 저장을 허용한 뒤 새로고침하세요.
        </div>
      ) : null}

      <main
        aria-labelledby={`app-tab-${activeTab}`}
        className="app-main"
        id={`app-panel-${activeTab}`}
        role="tabpanel"
      >
        {children}
      </main>
    </div>
  );
}
