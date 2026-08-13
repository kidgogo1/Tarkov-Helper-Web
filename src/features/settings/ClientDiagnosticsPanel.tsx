import { Download, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
  subscribeClientDiagnostics,
} from "../../services/client-diagnostics";
import { downloadClientDiagnostics } from "../../services/client-diagnostic-download";

function latestOccurrence(entries: ReturnType<typeof getClientDiagnosticSnapshot>["entries"]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (latest === null || Date.parse(entry.lastOccurredAt) > Date.parse(latest)) {
      latest = entry.lastOccurredAt;
    }
  }
  return latest;
}

function displayDateTime(value: string): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function ClientDiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState(getClientDiagnosticSnapshot);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    const refresh = () => setSnapshot(getClientDiagnosticSnapshot());
    const unsubscribe = subscribeClientDiagnostics(refresh);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith("tarkov-helper:client-diagnostics:v1")) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const totalOccurrences = useMemo(
    () => snapshot.entries.reduce((total, entry) => total + entry.count, 0),
    [snapshot.entries],
  );
  const latest = latestOccurrence(snapshot.entries);
  const hasEntries = snapshot.entries.length > 0;

  const download = () => {
    setDownloadError("");
    if (!downloadClientDiagnostics()) {
      setDownloadError("진단 기록 파일을 만들지 못했습니다.");
    }
  };

  return (
    <section aria-labelledby="client-diagnostics-title" className="client-diagnostics-panel">
      <div className="client-diagnostics-heading">
        <div>
          <h4 id="client-diagnostics-title">진단 기록</h4>
          <p className="settings-help">업데이트 및 화면 오류의 안전하게 정리된 기록만 이 브라우저에 저장합니다.</p>
        </div>
        <span className="diagnostic-count">
          고유 오류 {snapshot.entries.length.toLocaleString()}건 · 총 발생 {totalOccurrences.toLocaleString()}회
        </span>
      </div>

      <p className="diagnostic-privacy-note">
        <TriangleAlert aria-hidden="true" size={16} />
        개인정보가 포함될 수 있으므로 공유 전에 내용을 확인해 주세요.
      </p>

      {hasEntries ? (
        <dl className="diagnostic-facts">
          <div>
            <dt>마지막 기록</dt>
            <dd><time dateTime={latest ?? undefined}>{latest ? displayDateTime(latest) : "-"}</time></dd>
          </div>
          <div>
            <dt>저장 위치</dt>
            <dd>{snapshot.persistence === "localStorage" ? "이 브라우저" : "현재 실행 중 메모리"}</dd>
          </div>
        </dl>
      ) : (
        <p className="diagnostic-empty" role="status">저장된 진단 기록이 없습니다.</p>
      )}

      {snapshot.persistence === "memory" ? (
        <p className="settings-warning" role="status">
          브라우저 저장 공간을 사용할 수 없어 앱을 닫으면 현재 기록이 사라집니다.
        </p>
      ) : null}
      {downloadError ? <p className="settings-warning" role="alert">{downloadError}</p> : null}

      <div className="diagnostic-actions">
        <button disabled={!hasEntries} onClick={download} type="button">
          <Download aria-hidden="true" size={16} />
          진단 기록 JSON 다운로드
        </button>
        <button
          className="ghost"
          disabled={!hasEntries}
          onClick={() => {
            setDownloadError("");
            if (!clearClientDiagnostics()) {
              setDownloadError("브라우저 저장 공간에서 진단 기록을 삭제하지 못했습니다.");
            }
          }}
          type="button"
        >
          <Trash2 aria-hidden="true" size={16} />
          진단 기록 삭제
        </button>
      </div>
    </section>
  );
}
