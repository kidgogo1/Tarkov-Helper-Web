import { beforeEach, describe, expect, it, vi } from "vitest";

import { startClientBootstrap } from "../../src/services/client-bootstrap";
import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
} from "../../src/services/client-diagnostics";

describe("client bootstrap", () => {
  beforeEach(() => {
    localStorage.clear();
    clearClientDiagnostics();
    document.body.innerHTML = '<div id="root"><span>앱을 불러오는 중입니다.</span></div>';
  });

  it("records a rejected application import before showing a recoverable startup screen", async () => {
    const stop = startClientBootstrap(async () => {
      throw new Error("C:\\Users\\Alice\\private\\broken.js token=bootstrap-secret");
    });

    await expect.poll(() => getClientDiagnosticSnapshot().entries.length).toBe(1);

    expect(getClientDiagnosticSnapshot().entries[0]).toMatchObject({
      source: "global",
      code: "APP_BOOTSTRAP_FAILED",
    });
    expect(JSON.stringify(getClientDiagnosticSnapshot())).not.toMatch(/Alice|private|bootstrap-secret/);
    expect(document.getElementById("root")).toHaveTextContent("앱을 불러오지 못했습니다");
    expect(document.getElementById("root")).toHaveTextContent("다시 실행하거나 새로고침해 주세요");
    expect(document.getElementById("root")).toHaveTextContent("진단 기록 다운로드");

    stop();
  });

  it("records a synchronous mount failure through the same bootstrap boundary", async () => {
    const stop = startClientBootstrap(async () => ({
      mountApp() {
        throw new Error("mount failed");
      },
    }));

    await expect.poll(() => getClientDiagnosticSnapshot().entries.length).toBe(1);
    expect(getClientDiagnosticSnapshot().entries[0]).toMatchObject({
      code: "APP_BOOTSTRAP_FAILED",
      message: "mount failed",
    });
    expect(document.getElementById("root")).toHaveTextContent("앱을 불러오지 못했습니다");
    stop();
  });

  it("does not mount a late module after bootstrap cleanup", async () => {
    let resolveModule: ((module: { mountApp(): void }) => void) | undefined;
    const mountApp = vi.fn();
    const stop = startClientBootstrap(() => new Promise((resolve) => {
      resolveModule = resolve;
    }));

    stop();
    stop();
    resolveModule?.({ mountApp });
    await Promise.resolve();
    await Promise.resolve();

    expect(mountApp).not.toHaveBeenCalled();
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });
});
