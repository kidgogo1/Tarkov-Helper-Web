import { CheckCircle2, Download, RefreshCw, TriangleAlert } from "lucide-react";

import type { PublicUpdateSession, PublicUpdateStatus } from "../../services/public-update";
import type { PublicUpdateBusyState } from "./usePublicUpdate";

interface PublicUpdatePanelProps {
  session: PublicUpdateSession | null;
  status: PublicUpdateStatus | null;
  initializing: boolean;
  busy: PublicUpdateBusyState;
  clientError: string | null;
  onCheck: () => void;
  onStage: () => void;
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
  if (status.state === "READY_TO_RESTART") return "준비된 업데이트를 적용한 뒤 다시 확인할 수 있습니다.";
  return null;
}

export function PublicUpdatePanel({
  session,
  status,
  initializing,
  busy,
  clientError,
  onCheck,
  onStage,
}: PublicUpdatePanelProps) {
  const checkUnavailableReason = updateCheckUnavailableReason(session, status, initializing);

  return (
    <section aria-labelledby="public-update-title" className="public-update-panel">
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
      {!initializing && !session ? (
        <p className="update-status muted">업데이트 기능은 Windows 바로 실행 버전에서 사용할 수 있습니다.</p>
      ) : null}
      {status?.state === "DISABLED" ? (
        <p className="update-status muted">
          이 빌드는 아직 공개 GitHub 릴리스 저장소와 연결되지 않았습니다.
        </p>
      ) : null}
      {status?.state === "IDLE" || busy === "CHECK" ? (
        <p className="update-status">최신 공개 버전을 확인하는 중입니다.</p>
      ) : null}
      {status?.state === "DOWNLOADING" ? (
        <p className="update-status">
          업데이트를 다운로드하는 중입니다. {Math.floor(status.downloadedBytes / status.downloadBytes * 100)}%
        </p>
      ) : null}
      {status?.state === "VERIFYING" ? (
        <p className="update-status">서명·해시·패키지 파일을 검증하는 중입니다.</p>
      ) : null}
      {status?.state === "APPLYING" ? (
        <p className="update-status">새 버전을 적용하는 중입니다.</p>
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
          </div>
          <div className="update-actions">
            <a href={status.releasePageUrl} rel="noreferrer" target="_blank">변경 내용 보기</a>
            <button className="primary" disabled={busy !== null} onClick={onStage} type="button">
              <Download aria-hidden="true" size={15} />
              {busy === "STAGE" ? "다운로드·검증 중" : "업데이트 다운로드 및 검증"}
            </button>
          </div>
        </div>
      ) : null}
      {status?.state === "READY_TO_RESTART" ? (
        <div className="update-status success">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>
            v{status.latestVersion} 검증이 끝났습니다. 탭을 닫은 다음 Tarkov Helper 실행.vbs를 다시 실행하면 안전하게 설치됩니다.
          </span>
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
          <span>{status.message}</span>
        </div>
      ) : null}
      {clientError ? (
        <div className="update-status error" role="alert">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>{clientError}</span>
        </div>
      ) : null}
    </section>
  );
}
