import { Database, FileJson, MonitorCog, Shield, Upload } from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
} from "react";

import { Dialog } from "../../components/Dialog";
import { QuantityStepper } from "../../components/QuantityStepper";
import type { ProfilePatch } from "../../app/store";
import type { DataMeta } from "../../types/data";
import type {
  MapDisplaySettings,
  ProfileState,
  SharedSettings,
} from "../../types/state";
import { PublicUpdatePanel } from "./PublicUpdatePanel";
import type { PublicUpdateController } from "./usePublicUpdate";
import { ClientDiagnosticsPanel } from "./ClientDiagnosticsPanel";

interface SettingsDialogProps {
  open: boolean;
  profile: ProfileState;
  settings: SharedSettings;
  dataMeta: DataMeta;
  publicUpdate?: PublicUpdateController;
  logImportError?: string | null;
  onClose: () => void;
  onUpdateProfile: (patch: ProfilePatch) => void;
  onUpdateSettings: (patch: Partial<SharedSettings>) => void;
  onUpdateMapSettings: (patch: Partial<MapDisplaySettings>) => void;
  onLogFiles: (files: File[]) => void;
  onOpenInProgressQuests: () => void;
}

type SettingsSection = "profile" | "display" | "sync" | "data";

interface DirectoryInputAttributes extends InputHTMLAttributes<HTMLInputElement> {
  directory?: string;
  webkitdirectory?: string;
}

const DIRECTORY_INPUT_ATTRIBUTES: DirectoryInputAttributes = {
  directory: "",
  webkitdirectory: "",
};

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: typeof Shield;
}> = [
  { id: "profile", label: "프로필", icon: Shield },
  { id: "display", label: "화면", icon: MonitorCog },
  { id: "sync", label: "로그 동기화", icon: FileJson },
  { id: "data", label: "데이터", icon: Database },
];

export function SettingsDialog({
  open,
  profile,
  settings,
  dataMeta,
  publicUpdate,
  logImportError,
  onClose,
  onUpdateProfile,
  onUpdateSettings,
  onUpdateMapSettings,
  onLogFiles,
  onOpenInProgressQuests,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>("profile");
  const [fontError, setFontError] = useState("");
  const fontInputRef = useRef<HTMLInputElement>(null);
  const logFileInputRef = useRef<HTMLInputElement>(null);
  const logDirectoryInputRef = useRef<HTMLInputElement>(null);

  const loadFont = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFontError("");
    const url = URL.createObjectURL(file);
    try {
      const uploadedFont = new FontFace("TarkovHelperUploaded", `url(${url})`);
      await uploadedFont.load();
      document.fonts.add(uploadedFont);
      document.documentElement.style.setProperty("--font-ui", "TarkovHelperUploaded, sans-serif");
      onUpdateSettings({ fontFamily: "uploaded" });
    } catch {
      setFontError("글꼴 파일을 불러오지 못했습니다. 지원 형식과 파일 상태를 확인해 주세요.");
    } finally {
      URL.revokeObjectURL(url);
      event.target.value = "";
    }
  };

  return (
    <Dialog
      description="현재 모드의 진행 조건과 공통 표시 옵션을 설정합니다."
      onClose={onClose}
      open={open}
      title="설정"
      wide
    >
      <div className="settings-layout">
        <nav aria-label="설정 항목" className="settings-nav">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={section === item.id ? "page" : undefined}
                className={section === item.id ? "active" : "ghost"}
                key={item.id}
                onClick={() => setSection(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          {section === "profile" ? (
            <section aria-labelledby="profile-settings-title">
              <h3 id="profile-settings-title">진행 조건</h3>
              <p className="settings-help">
                퀘스트 잠금·추천 계산에 사용하는 현재 캐릭터 조건입니다.
              </p>
              <div className="settings-grid">
                <div className="settings-field">
                  <span>레벨</span>
                  <QuantityStepper
                    label="캐릭터 레벨"
                    max={79}
                    min={1}
                    onChange={(level) => onUpdateProfile({ level })}
                    value={profile.level}
                  />
                </div>
                <label>
                  <span>스캐브 평판</span>
                  <input
                    max={6}
                    min={-6}
                    onChange={(event) => onUpdateProfile({ scavRep: Number(event.target.value) })}
                    step={0.01}
                    type="number"
                    value={profile.scavRep}
                  />
                </label>
                <div className="settings-field">
                  <span>DSP 해독 수</span>
                  <QuantityStepper
                    label="DSP 해독 수"
                    max={3}
                    onChange={(dspDecodeCount) => onUpdateProfile({ dspDecodeCount })}
                    value={profile.dspDecodeCount}
                  />
                </div>
                <div className="settings-field">
                  <span>프레스티지</span>
                  <QuantityStepper
                    label="프레스티지 레벨"
                    max={5}
                    onChange={(prestigeLevel) => onUpdateProfile({ prestigeLevel })}
                    value={profile.prestigeLevel}
                  />
                </div>
              </div>

              <div className="settings-row-group">
                <fieldset>
                  <legend>진영</legend>
                  <label>
                    <input
                      checked={profile.faction === null}
                      name="faction"
                      onChange={() => onUpdateProfile({ faction: null })}
                      type="radio"
                    />
                    미선택
                  </label>
                  <label>
                    <input
                      checked={profile.faction === "bear"}
                      name="faction"
                      onChange={() => onUpdateProfile({ faction: "bear" })}
                      type="radio"
                    />
                    BEAR
                  </label>
                  <label>
                    <input
                      checked={profile.faction === "usec"}
                      name="faction"
                      onChange={() => onUpdateProfile({ faction: "usec" })}
                      type="radio"
                    />
                    USEC
                  </label>
                </fieldset>
                <fieldset>
                  <legend>에디션</legend>
                  <label>
                    <input
                      checked={profile.hasEodEdition}
                      onChange={(event) => onUpdateProfile({ hasEodEdition: event.target.checked })}
                      type="checkbox"
                    />
                    Edge of Darkness
                  </label>
                  <label>
                    <input
                      checked={profile.hasUnheardEdition}
                      onChange={(event) => onUpdateProfile({ hasUnheardEdition: event.target.checked })}
                      type="checkbox"
                    />
                    The Unheard Edition
                  </label>
                </fieldset>
              </div>
            </section>
          ) : null}

          {section === "display" ? (
            <section aria-labelledby="display-settings-title">
              <h3 id="display-settings-title">화면 및 지도</h3>
              <p className="settings-help">브라우저 전체에 적용되는 공통 표시 옵션입니다.</p>
              <div className="settings-grid">
                <label>
                  <span>글꼴</span>
                  <select
                    onChange={(event) =>
                      onUpdateSettings({ fontFamily: event.target.value as SharedSettings["fontFamily"] })
                    }
                    value={settings.fontFamily}
                  >
                    <option value="system">시스템 기본</option>
                    <option value="sans">고딕</option>
                    <option value="serif">명조</option>
                    <option value="mono">고정폭</option>
                    {settings.fontFamily === "uploaded" ? <option value="uploaded">불러온 글꼴</option> : null}
                  </select>
                </label>
                <div className="settings-field">
                  <span>기본 글자 크기</span>
                  <QuantityStepper
                    label="기본 글자 크기"
                    max={28}
                    min={10}
                    onChange={(fontSize) => onUpdateSettings({ fontSize })}
                    value={settings.fontSize}
                  />
                </div>
              </div>
              <input
                accept=".ttf,.otf,.woff,.woff2"
                className="sr-only"
                onChange={loadFont}
                ref={fontInputRef}
                type="file"
              />
              <button onClick={() => fontInputRef.current?.click()} type="button">
                <Upload aria-hidden="true" size={15} /> 개인 글꼴 불러오기
              </button>
              {fontError ? <p className="settings-error" role="alert">{fontError}</p> : null}
              <p className="settings-note">불러온 글꼴은 현재 브라우저 세션에만 유지됩니다.</p>

              <hr />
              <div className="settings-grid">
                <label>
                  <span>퀘스트 마커 모양</span>
                  <select
                    onChange={(event) => onUpdateMapSettings({
                      questMarkerStyle: event.target.value as MapDisplaySettings["questMarkerStyle"],
                    })}
                    value={settings.map.questMarkerStyle}
                  >
                    <option value="icon">아이콘</option>
                    <option value="circle">원형</option>
                    <option value="iconWithName">아이콘 + 선택한 목표 이름</option>
                    <option value="circleWithName">원형 + 선택한 목표 이름</option>
                  </select>
                </label>
                <div className="settings-field">
                  <span>퀘스트 마커 크기</span>
                  <QuantityStepper
                    label="퀘스트 마커 크기"
                    max={32}
                    min={12}
                    onChange={(markerSize) => onUpdateMapSettings({ markerSize })}
                    value={settings.map.markerSize}
                  />
                </div>
                <div className="settings-field">
                  <span>플레이어 마커 크기</span>
                  <QuantityStepper
                    label="플레이어 마커 크기"
                    max={32}
                    min={12}
                    onChange={(playerMarkerSize) => onUpdateMapSettings({ playerMarkerSize })}
                    value={settings.map.playerMarkerSize}
                  />
                </div>
                <div className="settings-field">
                  <span>퀘스트 이름 크기</span>
                  <QuantityStepper
                    label="퀘스트 이름 크기"
                    max={32}
                    min={12}
                    onChange={(questNameSize) => onUpdateMapSettings({ questNameSize })}
                    value={settings.map.questNameSize}
                  />
                </div>
                <div className="settings-field">
                  <span>탈출구 이름 크기</span>
                  <QuantityStepper
                    label="탈출구 이름 크기"
                    max={32}
                    min={10}
                    onChange={(extractNameSize) => onUpdateMapSettings({ extractNameSize })}
                    value={settings.map.extractNameSize}
                  />
                </div>
                <label>
                  <span>커스텀 마커 투명도 {Math.round(settings.map.customMarkerOpacity * 100)}%</span>
                  <input
                    aria-label="커스텀 마커 투명도"
                    max={1}
                    min={0}
                    onChange={(event) => onUpdateMapSettings({
                      customMarkerOpacity: Number(event.target.value),
                    })}
                    step={0.05}
                    type="range"
                    value={settings.map.customMarkerOpacity}
                  />
                </label>
              </div>
              <label className="check-row">
                <input
                  checked={settings.map.fixedView}
                  onChange={(event) => onUpdateMapSettings({ fixedView: event.target.checked })}
                  type="checkbox"
                />
                고정 뷰 — 새 위치를 읽어도 지도를 자동으로 가운데 맞추지 않음
              </label>

            </section>
          ) : null}

          {section === "sync" ? (
            <section aria-labelledby="sync-settings-title">
              <h3 id="sync-settings-title">EFT 로그 동기화</h3>
              <p className="settings-help">
                브라우저 보안상 폴더를 자동 감시할 수 없어 사용자가 선택한 로그만 읽습니다.
              </p>
              <div className="manual-quest-sync-card">
                <div>
                  <strong>진행 중인 퀘스트 직접 입력</strong>
                  <span>선택한 퀘스트는 유지하고, 완료되어 있어야 하는 선행 퀘스트만 미리 확인해 반영합니다.</span>
                </div>
                <button onClick={onOpenInProgressQuests} type="button">
                  진행 중인 퀘스트 입력
                </button>
              </div>
              {logImportError ? (
                <p className="settings-error" role="alert">{logImportError}</p>
              ) : null}
              <div className="file-drop-card">
                <FileJson aria-hidden="true" size={31} />
                <strong>퀘스트 완료·실패·시작 이벤트 가져오기</strong>
                <span>여러 .log 또는 .txt 파일을 한 번에 선택할 수 있습니다.</span>
                <button
                  className="primary"
                  onClick={() => logFileInputRef.current?.click()}
                  type="button"
                >
                  로그 파일 선택
                </button>
                <input
                  accept=".log,.txt"
                  aria-label="로그 파일 선택"
                  multiple
                  onChange={(event) => {
                    onLogFiles(Array.from(event.target.files ?? []));
                    event.currentTarget.value = "";
                  }}
                  ref={logFileInputRef}
                  type="file"
                />
                <button
                  onClick={() => logDirectoryInputRef.current?.click()}
                  type="button"
                >
                  로그 폴더 선택
                </button>
                <input
                  {...DIRECTORY_INPUT_ATTRIBUTES}
                  aria-label="로그 폴더 선택"
                  multiple
                  onChange={(event) => {
                    onLogFiles(Array.from(event.target.files ?? []));
                    event.currentTarget.value = "";
                  }}
                  ref={logDirectoryInputRef}
                  type="file"
                />
              </div>
            </section>
          ) : null}

          {section === "data" ? (
            <section aria-labelledby="data-settings-title">
              <h3 id="data-settings-title">포함된 저장소 데이터</h3>
              <p className="settings-help">
                퀘스트·지도·요구 아이템은 패키징한 정적 데이터를 사용합니다. 시세 화면은
                포함된 스냅샷을 기본으로 사용하며 Windows 바로 실행 버전에서만 선택한 아이템의 최신 시세를 확인합니다.
              </p>
              <dl className="data-facts">
                <div><dt>원본 커밋</dt><dd>{dataMeta.originalCommit}</dd></div>
                <div><dt>수정본 커밋</dt><dd>{dataMeta.modifiedCommit}</dd></div>
                <div><dt>퀘스트</dt><dd>{dataMeta.counts.quests.toLocaleString()}개</dd></div>
                <div><dt>아이템</dt><dd>{dataMeta.counts.items.toLocaleString()}개</dd></div>
                <div><dt>은신처 시설</dt><dd>{dataMeta.counts.hideoutStations}개</dd></div>
                <div><dt>지도</dt><dd>{dataMeta.counts.maps}개</dd></div>
                <div><dt>기본 마커</dt><dd>{dataMeta.counts.mapMarkers.toLocaleString()}개</dd></div>
              </dl>
              <button onClick={() => window.location.reload()} type="button">포함 데이터 다시 불러오기</button>
              {publicUpdate ? (
                <PublicUpdatePanel
                  busy={publicUpdate.busy}
                  clientError={publicUpdate.clientError}
                  initializing={publicUpdate.initializing}
                  onCheck={publicUpdate.check}
                  onInstall={publicUpdate.install}
                  onApply={publicUpdate.apply}
                  session={publicUpdate.session}
                  status={publicUpdate.status}
                />
              ) : null}
              <ClientDiagnosticsPanel />
            </section>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
