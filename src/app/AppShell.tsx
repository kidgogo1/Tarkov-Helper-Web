import {
  Boxes,
  House,
  ListChecks,
  Map,
  RotateCcw,
  Settings,
  Trophy,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { QuantityStepper } from "../components/QuantityStepper";
import type { ProfileType } from "../types/data";

export type AppTab = "quests" | "hideout" | "items" | "collector" | "map";

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
}: AppShellProps) {
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
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? "active" : ""}
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                role="tab"
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      <main className="app-main">{children}</main>
    </div>
  );
}

