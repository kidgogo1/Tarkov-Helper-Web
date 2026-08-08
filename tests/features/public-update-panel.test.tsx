import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PublicUpdatePanel } from "../../src/features/settings/PublicUpdatePanel";
import { usePublicUpdate } from "../../src/features/settings/usePublicUpdate";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const idleSession = {
  protocolVersion: 1,
  capability: "PUBLIC_GITHUB_RELEASES",
  token: "u".repeat(43),
  repository: "example/tarkov-helper",
  status: { state: "IDLE", currentVersion: "1.0.0" },
} as const;

const availableStatus = {
  state: "AVAILABLE",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  publishedAt: "2026-08-09T03:04:05.000Z",
  releasePageUrl: "https://github.com/example/tarkov-helper/releases/tag/v1.1.0",
  downloadBytes: 4_500_000,
  candidateId: "c".repeat(43),
} as const;

describe("public update settings", () => {
  it("rechecks a settled update status on startup and every six hours", async () => {
    vi.useFakeTimers();
    try {
      const currentStatus = {
        state: "CURRENT",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        checkedAt: "2026-08-09T03:04:05.000Z",
      } as const;
      const currentSession = { ...idleSession, status: currentStatus } as const;
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(currentSession))
        .mockResolvedValue(jsonResponse({ protocolVersion: 1, status: currentStatus }));

      const { result } = renderHook(() => usePublicUpdate(request));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.status).toEqual(currentStatus);
      expect(request).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
      });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks once on startup and stages the exact reviewed version", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(idleSession))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "CHECKING",
          currentVersion: "1.0.0",
          startedAt: "2026-08-09T03:04:04.000Z",
        },
      }, 202))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: availableStatus }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "DOWNLOADING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          candidateId: availableStatus.candidateId,
          downloadedBytes: 0,
          downloadBytes: availableStatus.downloadBytes,
          startedAt: "2026-08-09T03:05:05.000Z",
        },
      }, 202))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "VERIFYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          candidateId: availableStatus.candidateId,
          startedAt: "2026-08-09T03:05:05.000Z",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: ready }));

    const { result } = renderHook(() => usePublicUpdate(request));

    await waitFor(() => expect(result.current.status).toEqual(availableStatus));
    expect(request).toHaveBeenCalledTimes(3);

    await act(async () => result.current.stage());
    expect(result.current.status).toEqual(ready);
    expect(request.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({
      candidateId: availableStatus.candidateId,
    }));
  });

  it("keeps static hosting and an unconfigured local build non-fatal", async () => {
    const staticRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response("not found", { status: 404 }));
    const staticHook = renderHook(() => usePublicUpdate(staticRequest));
    await waitFor(() => expect(staticHook.result.current.initializing).toBe(false));
    expect(staticHook.result.current.session).toBeNull();
    expect(staticRequest).toHaveBeenCalledOnce();

    const disabled = {
      ...idleSession,
      repository: null,
      status: { state: "DISABLED", currentVersion: "1.0.0", reason: "NOT_CONFIGURED" },
    } as const;
    const disabledRequest = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(disabled));
    const disabledHook = renderHook(() => usePublicUpdate(disabledRequest));
    await waitFor(() => expect(disabledHook.result.current.status?.state).toBe("DISABLED"));
    expect(disabledRequest).toHaveBeenCalledOnce();
  });

  it("resumes an in-progress startup check as a check operation", async () => {
    let resolveStatus!: (response: Response) => void;
    const checkingSession = {
      ...idleSession,
      status: {
        state: "CHECKING",
        currentVersion: "1.0.0",
        startedAt: "2026-08-09T03:04:04.000Z",
      },
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(checkingSession))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveStatus = resolve;
      }));

    const { result } = renderHook(() => usePublicUpdate(request));

    await waitFor(() => expect(result.current.busy).toBe("CHECK"));
    resolveStatus(jsonResponse({ protocolVersion: 1, status: availableStatus }));
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));
  });

  it("shows release details, retries checks, and explains restart installation", () => {
    const onCheck = vi.fn();
    const onStage = vi.fn();
    const { rerender } = render(
      <PublicUpdatePanel
        busy={null}
        clientError={null}
        initializing={false}
        onCheck={onCheck}
        onStage={onStage}
        session={idleSession}
        status={availableStatus}
      />,
    );

    expect(screen.getByText("v1.1.0 업데이트 가능")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "변경 내용 보기" })).toHaveAttribute(
      "href",
      availableStatus.releasePageUrl,
    );
    fireEvent.click(screen.getByRole("button", { name: "업데이트 다운로드 및 검증" }));
    expect(onStage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    expect(onCheck).toHaveBeenCalledOnce();

    rerender(
      <PublicUpdatePanel
        busy={null}
        clientError={null}
        initializing={false}
        onCheck={onCheck}
        onStage={onStage}
        session={idleSession}
        status={{
          state: "READY_TO_RESTART",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          candidateId: availableStatus.candidateId,
          stagedAt: "2026-08-09T03:05:06.000Z",
        }}
      />,
    );
    expect(screen.getByText(/탭을 닫은 다음.*Tarkov Helper 실행\.vbs.*다시 실행/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 확인" })).not.toBeInTheDocument();
  });
});
