import {
  installGlobalDiagnosticHandlers,
  recordClientDiagnostic,
} from "./client-diagnostics";
import { downloadClientDiagnostics } from "./client-diagnostic-download";

export interface ClientAppModule {
  mountApp(): void | (() => void);
}

type ClientAppLoader = () => Promise<ClientAppModule>;

function showBootstrapFailure(): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren();
  const main = document.createElement("main");
  main.className = "startup-state error";
  main.setAttribute("role", "alert");
  main.style.cssText = "display:grid;min-height:100vh;place-content:center;gap:12px;padding:24px;background:#181a19;color:#e8e8e3;font:16px/1.45 'Segoe UI','Noto Sans KR',Arial,sans-serif;text-align:center";
  const heading = document.createElement("h1");
  heading.textContent = "앱을 불러오지 못했습니다";
  const message = document.createElement("p");
  message.textContent = "다시 실행하거나 새로고침해 주세요. 오류 내용은 로컬 진단 기록에 보관했습니다.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "새로고침";
  reload.addEventListener("click", () => window.location.reload());
  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "진단 기록 다운로드";
  download.addEventListener("click", () => {
    if (!downloadClientDiagnostics()) {
      message.textContent = "진단 기록 파일을 만들지 못했습니다. 앱을 다시 실행해 주세요.";
    }
  });
  const actions = document.createElement("div");
  actions.className = "startup-actions";
  actions.style.cssText = "display:flex;flex-wrap:wrap;justify-content:center;gap:8px";
  actions.append(reload, download);
  main.append(heading, message, actions);
  root.append(main);
}

/** Installs diagnostics before loading React, CSS, lifecycle, or application modules. */
export function startClientBootstrap(loadApp: ClientAppLoader): () => void {
  const stopDiagnostics = installGlobalDiagnosticHandlers();
  let cancelled = false;
  let unmount: (() => void) | undefined;

  void Promise.resolve()
    .then(loadApp)
    .then((app) => {
      if (cancelled) return;
      const cleanup = app.mountApp();
      if (typeof cleanup === "function") unmount = cleanup;
    })
    .catch((error: unknown) => {
      if (cancelled) return;
      recordClientDiagnostic({
        source: "global",
        code: "APP_BOOTSTRAP_FAILED",
        error,
        message: "앱 모듈을 불러오거나 시작하지 못했습니다.",
      });
      showBootstrapFailure();
    });

  return () => {
    if (cancelled) return;
    cancelled = true;
    try {
      unmount?.();
    } finally {
      stopDiagnostics();
    }
  };
}
