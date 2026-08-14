import { CheckCircle2, Download, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";

import type { PublicUpdateSession, PublicUpdateStatus } from "../../services/public-update";
import type { PublicUpdateBusyState } from "./usePublicUpdate";

interface PublicUpdatePanelProps {
  session: PublicUpdateSession | null;
  status: PublicUpdateStatus | null;
  initializing: boolean;
  busy: PublicUpdateBusyState;
  clientError: string | null;
  onCheck: () => void;
  onInstall: () => void;
  onApply: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.ceil(bytes / 1_000).toLocaleString()} KB`;
  return `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

function updateCheckUnavailableReason(
  session: PublicUpdateSession | null,
  status: PublicUpdateStatus | null,
  initializing: boolean,
): string | null {
  if (initializing) return "업데이트 기능을 확인하는 중입니다.";
  if (!session) return "Windows 바로 실행 버전에서 사용할 수 있습니다.";
  if (!status) return "업데이트 상태를 불러오는 중입니다.";
  if (status.state === "DISABLED") return "공개 GitHub 릴리스 저장소 연결 후 사용할 수 있습니다.";
  if (status.state === "AVAILABLE") {
    return "이미 검증한 업데이트 후보를 설치하거나 앱을 다시 실행한 뒤 확인할 수 있습니다.";
  }
  if (status.state === "READY_TO_RESTART") return "준비된 업데이트를 적용한 뒤 다시 확인할 수 있습니다.";
  return null;
}

function updateAnnouncement(
  session: PublicUpdateSession | null,
  status: PublicUpdateStatus | null,
  initializing: boolean,
  busy: PublicUpdateBusyState,
  clientError: string | null,
): string {
  if (initializing) return "로컬 업데이트 기능을 확인하는 중입니다.";
  if (clientError) return clientError;
  if (!session) return "업데이트 기능은 Windows 바로 실행 버전에서 사용할 수 있습니다.";
  if (!status) return "업데이트 상태를 불러오는 중입니다.";
  switch (status.state) {
    case "DISABLED": return "공개 GitHub 릴리스 저장소가 연결되지 않았습니다.";
    case "IDLE": return "아직 업데이트를 확인하지 않았습니다.";
    case "CHECKING": return "최신 공개 버전을 확인하는 중입니다.";
    case "DOWNLOADING": return "업데이트를 다운로드하는 중입니다.";
    case "VERIFYING": return "서명, 해시, 패키지 파일을 검증하는 중입니다.";
    case "APPLYING": return "새 버전을 적용하고 다시 연결하는 중입니다. 이 탭을 닫지 마세요.";
    case "ROLLING_BACK": return "이전 버전으로 안전하게 복원하는 중입니다.";
    case "CURRENT": return `최신 버전입니다. 현재 버전 ${status.currentVersion}.`;
    case "AVAILABLE": return `버전 ${status.latestVersion} 업데이트를 사용할 수 있습니다.`;
    case "READY_TO_RESTART": return `버전 ${status.latestVersion} 다운로드와 검증이 끝났습니다.`;
    case "UPDATED": return `버전 ${status.currentVersion} 업데이트가 완료되었습니다.`;
    case "ERROR": return "";
    default: return busy === "CHECK" ? "최신 공개 버전을 확인하는 중입니다." : "";
  }
}

function formatUpdateError(status: Extract<PublicUpdateStatus, { state: "ERROR" }>): string {
  switch (status.code) {
    case "GITHUB_RATE_LIMIT":
      return "GitHub 공개 API 요청 제한에 도달했습니다. 잠시 후 다시 확인하세요. GitHub 계정이 차단된 것은 아닙니다.";
    case "GITHUB_FORBIDDEN":
      return "GitHub가 업데이트 요청을 거부했습니다(HTTP 403). VPN, 프록시 또는 방화벽 설정을 확인하세요.";
    case "NETWORK_ERROR":
      return "GitHub 업데이트 서버에 연결할 수 없습니다. 네트워크 또는 방화벽 설정을 확인하세요.";
    default:
      return status.message;
  }
}

export function PublicUpdatePanel({
  session,
  status,
  initializing,
  busy,
  clientError,
  onCheck,
  onInstall,
  onApply,
}: PublicUpdatePanelProps) {
  const checkUnavailableReason = updateCheckUnavailableReason(session, status, initializing);
  const announcement = updateAnnouncement(session, status, initializing, busy, clientError);

  return (
    <>
      {announcement ? <p aria-live="polite" className="sr-only" role="status">{announcement}</p> : null}
      <section aria-busy={busy !== null} aria-labelledby="public-update-title" className="public-update-panel">
      <div className="public-update-heading">
        <div>
          <h3 id="public-update-title">프로그램 업데이트</h3>
          <p>공개 GitHub 릴리스에서 검증된 전체 앱·데이터 패키지를 확인합니다.</p>
        </div>
        <button
          disabled={busy !== null || checkUnavailableReason !== null}
          onClick={onCheck}
          title={checkUnavailableReason ?? undefined}
          type="button"
        >
          <RefreshCw aria-hidden="true" className={busy === "CHECK" ? "spin" : undefined} size={15} />
          업데이트 확인
        </button>
      </div>

      {initializing ? <p className="update-status">로컬 업데이트 기능을 확인하는 중입니다.</p> : null}
      {!initializing && !session && !clientError ? (
        <p className="update-status muted">업데이트 기능은 Windows 바로 실행 버전에서 사용할 수 있습니다.</p>
      ) : null}
      {status?.state === "DISABLED" ? (
        <p className="update-status muted">
          이 빌드는 아직 공개 GitHub 릴리스 저장소와 연결되지 않았습니다.
        </p>
      ) : null}
      {status?.state === "IDLE" && busy !== "CHECK" ? (
        <p className="update-status muted">아직 업데이트를 확인하지 않았습니다.</p>
      ) : null}
      {status?.state === "CHECKING" || busy === "CHECK" ? (
        <p className="update-status">최신 공개 버전을 확인하는 중입니다.</p>
      ) : null}
      {status?.state === "DOWNLOADING" ? (
        <div className="update-status">
          <span>업데이트를 다운로드하는 중입니다. {Math.floor(status.downloadedBytes / status.downloadBytes * 100)}%</span>
          <progress aria-label="업데이트 다운로드 진행률" max={status.downloadBytes} value={status.downloadedBytes} />
        </div>
      ) : null}
      {status?.state === "VERIFYING" ? (
        <p className="update-status">서명·해시·패키지 파일을 검증하는 중입니다.</p>
      ) : null}
      {status?.state === "APPLYING" ? (
        <p className="update-status">
          새 버전을 적용하고 다시 연결하는 중입니다. 이 탭을 닫지 마세요.
        </p>
      ) : null}
      {status?.state === "ROLLING_BACK" ? (
        <p className="update-status">이전 버전으로 안전하게 복원하는 중입니다.</p>
      ) : null}
      {status?.state === "CURRENT" ? (
        <div className="update-status success">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>최신 버전입니다. 현재 v{status.currentVersion}</span>
        </div>
      ) : null}
      {status?.state === "AVAILABLE" ? (
        <div className="update-available-card">
          <div>
            <strong>v{status.latestVersion} 업데이트 가능</strong>
            <span>현재 v{status.currentVersion} · 다운로드 {formatBytes(status.downloadBytes)}</span>
            <span>검증 후 로컬 서버가 잠시 재시작되며 현재 탭이 자동으로 다시 연결됩니다.</span>
          </div>
          <div className="update-actions">
            <a href={status.releasePageUrl} rel="noreferrer" target="_blank">변경 내용 보기</a>
            <button className="primary" disabled={busy !== null} onClick={onInstall} type="button">
              <Download aria-hidden="true" size={15} />
              {busy === "STAGE" ? "다운로드·검증 중" : "업데이트 및 계속 사용"}
            </button>
          </div>
        </div>
      ) : null}
      {status?.state === "READY_TO_RESTART" ? (
        <div className="update-status success">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>
            v{status.latestVersion} 다운로드와 검증이 끝났습니다. 적용하면 로컬 서버가 잠시 재시작되고
            이 탭이 자동으로 다시 연결됩니다.
          </span>
          <button className="primary" disabled={busy !== null} onClick={onApply} type="button">
            <RotateCw aria-hidden="true" size={15} />
            {busy === "APPLY" ? "적용·재연결 중" : "지금 적용하고 계속 사용"}
          </button>
        </div>
      ) : null}
      {status?.state === "UPDATED" ? (
        <div className="update-status success">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>v{status.currentVersion} 업데이트가 완료되었습니다.</span>
        </div>
      ) : null}
      {status?.state === "ERROR" ? (
        <div className="update-status error" role="alert">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>
            {formatUpdateError(status)}
            {" "}
            <code>지원 코드: {status.operation}/{status.code}</code>
          </span>
        </div>
      ) : null}
      {clientError ? (
        <div className="update-status error" role="alert">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>{clientError}</span>
        </div>
      ) : null}
      </section>
    </>
  );
}
