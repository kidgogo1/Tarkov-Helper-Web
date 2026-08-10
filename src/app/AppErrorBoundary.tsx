import { AlertTriangle } from "lucide-react";
import { Component } from "react";
import type { ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

/** Keeps a rendering failure from turning the local app into an empty page. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(): void {
    // The local app intentionally has no remote error reporting. The fallback
    // gives the user a safe recovery action without exposing implementation details.
  }

  public render() {
    if (this.state.hasError) {
      return (
        <main className="startup-state error" role="alert">
          <AlertTriangle aria-hidden="true" size={34} />
          <h1>화면을 불러오지 못했습니다</h1>
          <p>업데이트 또는 파일을 적용하는 중 문제가 발생했을 수 있습니다.</p>
          <button onClick={() => window.location.reload()} type="button">다시 시도</button>
        </main>
      );
    }

    return this.props.children;
  }
}
