import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "../../src/app/AppErrorBoundary";

function BrokenApp(): never {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  it("shows a recoverable Korean error screen instead of leaving the page blank", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <BrokenApp />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "화면을 불러오지 못했습니다" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();

    consoleError.mockRestore();
  });
});
