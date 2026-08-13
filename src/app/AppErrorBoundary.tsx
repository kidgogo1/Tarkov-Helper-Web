import { AlertTriangle } from "lucide-react";
import { Component } from "react";
import type { ReactNode } from "react";

import { downloadClientDiagnostics } from "../services/client-diagnostic-download";
import { getClientDiagnosticSnapshot, recordClientDiagnostic } from "../services/client-diagnostics";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  diagnosticDownloadError: boolean;
  diagnosticPersistence: "localStorage" | "memory" | null;
}

/** Keeps a rendering failure from turning the local app into an empty page. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = {
    hasError: false,
    diagnosticDownloadError: false,
    diagnosticPersistence: null,
  };

  public static getDerivedStateFromError(): AppErrorBoundaryState {
    return {
      hasError: true,
      diagnosticDownloadError: false,
      diagnosticPersistence: null,
    };
  }

  public componentDidCatch(error: Error): void {
    recordClientDiagnostic({
      source: "react",
      code: "REACT_RENDER_ERROR",
      error,
    });
    this.setState({
      diagnosticPersistence: getClientDiagnosticSnapshot().persistence,
    });
  }

  public render() {
    if (this.state.hasError) {
      const diagnosticsPersisted = this.state.diagnosticPersistence === "localStorage";
      return (
        <main className="startup-state error" role="alert">
          <AlertTriangle aria-hidden="true" size={34} />
          <h1>화면을 불러오지 못했습니다</h1>
          <p>업데이트 또는 파일을 적용하는 중 문제가 발생했을 수 있습니다.</p>
          <p>
            {diagnosticsPersisted
              ? "저장된 기록은 다음 실행 후 설정 > 데이터에서도 확인할 수 있습니다."
              : "현재 기록은 앱을 닫으면 사라질 수 있으므로 다시 시도하기 전에 다운로드해 주세요."}
          </p>
          {this.state.diagnosticDownloadError ? (
            <p className="startup-diagnostic-error">진단 기록 파일을 만들지 못했습니다.</p>
          ) : null}
          <div className="startup-actions">
            <button onClick={() => window.location.reload()} type="button">다시 시도</button>
            <button
              className="ghost"
              onClick={() => {
                if (!downloadClientDiagnostics()) {
                  this.setState({ diagnosticDownloadError: true });
                }
              }}
              type="button"
            >
              진단 기록 다운로드
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
