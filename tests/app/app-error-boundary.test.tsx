import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "../../src/app/AppErrorBoundary";
import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
} from "../../src/services/client-diagnostics";

function BrokenApp(): never {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  it("shows a recoverable Korean error screen instead of leaving the page blank", () => {
    clearClientDiagnostics();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <BrokenApp />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "화면을 불러오지 못했습니다" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "진단 기록 다운로드" })).toBeInTheDocument();
    expect(screen.getByText("저장된 기록은 다음 실행 후 설정 > 데이터에서도 확인할 수 있습니다.")).toBeInTheDocument();
    expect(getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({
        source: "react",
        code: "REACT_RENDER_ERROR",
        message: "render failed",
        count: 1,
      }),
    ]);

    consoleError.mockRestore();
  });

  it("keeps the recovery screen usable when diagnostic persistence and download fail", () => {
    clearClientDiagnostics();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => {
        throw new Error("download blocked");
      }),
    });

    render(
      <AppErrorBoundary>
        <BrokenApp />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("현재 기록은 앱을 닫으면 사라질 수 있으므로 다시 시도하기 전에 다운로드해 주세요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "진단 기록 다운로드" }));

    expect(screen.getByRole("heading", { name: "화면을 불러오지 못했습니다" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("진단 기록 파일을 만들지 못했습니다.");
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(1);

    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    consoleError.mockRestore();
  });
});
