import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PublicUpdatePanel } from "../../src/features/settings/PublicUpdatePanel";
import { usePublicUpdate } from "../../src/features/settings/usePublicUpdate";
import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
} from "../../src/services/client-diagnostics";

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
  it("keeps a clearly named update check button visible in every updater state", () => {
    const onCheck = vi.fn();
    const disabledSession = {
      ...idleSession,
      repository: null,
      status: { state: "DISABLED", currentVersion: "1.0.0", reason: "NOT_CONFIGURED" },
    } as const;
    const { rerender } = render(
      <PublicUpdatePanel
        busy={null}
        clientError={null}
        initializing={false}
        onCheck={onCheck}
        onInstall={vi.fn()}
        onApply={vi.fn()}
        session={disabledSession}
        status={disabledSession.status}
      />,
    );

    expect(screen.getByRole("button", { name: "업데이트 확인" })).toHaveAttribute(
      "title",
      "공개 GitHub 릴리스 저장소 연결 후 사용할 수 있습니다.",
    );
    expect(screen.getByRole("button", { name: "업데이트 확인" })).toBeDisabled();

    rerender(
      <PublicUpdatePanel
        busy={null}
        clientError={null}
        initializing={false}
        onCheck={onCheck}
        onInstall={vi.fn()}
        onApply={vi.fn()}
        session={idleSession}
        status={idleSession.status}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "업데이트 확인" }));
    expect(onCheck).toHaveBeenCalledOnce();
  });

  it("announces updater state changes without repeatedly announcing download percentages", () => {
    const downloading = {
      state: "DOWNLOADING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      downloadedBytes: 2_250_000,
      downloadBytes: availableStatus.downloadBytes,
      startedAt: "2026-08-09T03:05:05.000Z",
    } as const;
    render(
      <PublicUpdatePanel
        busy="STAGE"
        clientError={null}
        initializing={false}
        onApply={vi.fn()}
        onCheck={vi.fn()}
        onInstall={vi.fn()}
        session={{ ...idleSession, status: downloading }}
        status={downloading}
      />,
    );

    expect(screen.getByRole("region", { name: "프로그램 업데이트" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("업데이트를 다운로드하는 중입니다.");
    expect(screen.getByRole("status")).not.toHaveTextContent("50%");
    expect(screen.getByRole("progressbar", { name: "업데이트 다운로드 진행률" })).toHaveAttribute(
      "value",
      "2250000",
    );
  });

  it("explains that GitHub API limits are not an account ban", () => {
    const rateLimited = {
      state: "ERROR",
      currentVersion: "1.0.15",
      operation: "CHECK",
      code: "GITHUB_RATE_LIMIT",
      message: "GitHub API rate limit exceeded.",
    } as const;
    render(
      <PublicUpdatePanel
        busy={null}
        clientError={null}
        initializing={false}
        onApply={vi.fn()}
        onCheck={vi.fn()}
        onInstall={vi.fn()}
        session={{ ...idleSession, status: rateLimited }}
        status={rateLimited}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("GitHub 공개 API 요청 제한");
    expect(screen.getByRole("alert")).toHaveTextContent("계정이 차단된 것은 아닙니다");
  });

  it("does not check GitHub on startup or on a six-hour timer", async () => {
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
        .mockResolvedValueOnce(jsonResponse(currentSession));

      const { result } = renderHook(() => usePublicUpdate(request));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.status).toEqual(currentStatus);
      expect(request).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
      });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a broken launcher session initialization but ignores a static 404 and cancellation", async () => {
    clearClientDiagnostics();
    const brokenRequest = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { message: `do not retain ${"s".repeat(43)}` },
    }, 503));
    const broken = renderHook(() => usePublicUpdate(brokenRequest));
    await waitFor(() => expect(broken.result.current.initializing).toBe(false));

    const brokenSnapshot = getClientDiagnosticSnapshot();
    expect(brokenSnapshot.entries).toEqual([
      expect.objectContaining({
        source: "update",
        code: "REQUEST_FAILED",
        operation: "INITIALIZE",
        count: 1,
      }),
    ]);
    expect(JSON.stringify(brokenSnapshot)).not.toContain("s".repeat(43));
    broken.unmount();

    clearClientDiagnostics();
    const staticHost = renderHook(() => usePublicUpdate(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404)),
    ));
    await waitFor(() => expect(staticHost.result.current.initializing).toBe(false));
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
    staticHost.unmount();

    clearClientDiagnostics();
    const cancelled = renderHook(() => usePublicUpdate(
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError")),
    ));
    await waitFor(() => expect(cancelled.result.current.initializing).toBe(false));
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
    cancelled.unmount();
  });

  it("preserves a fresh updated terminal state until a manual check", async () => {
    vi.useFakeTimers();
    try {
      const updatedStatus = {
        state: "UPDATED",
        currentVersion: "1.1.0",
        previousVersion: "1.0.0",
        updatedAt: "2026-08-09T03:05:10.000Z",
      } as const;
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: updatedStatus }));

      const { result } = renderHook(() => usePublicUpdate(request));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.status).toEqual(updatedStatus);
      expect(request).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
      });
      expect(result.current.status).toEqual(updatedStatus);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a startup update error visible until a manual check", async () => {
    vi.useFakeTimers();
    try {
      const errorStatus = {
        state: "ERROR",
        currentVersion: "1.0.0",
        operation: "CHECK",
        code: "NETWORK_ERROR",
        message: "The release service could not be reached.",
      } as const;
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: errorStatus }));

      const { result } = renderHook(() => usePublicUpdate(request));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.status).toEqual(errorStatus);
      expect(request).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
      });
      expect(result.current.status).toEqual(errorStatus);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks once, installs the reviewed version, reconnects, and reloads the same page", async () => {
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
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: ready }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "APPLYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          startedAt: "2026-08-09T03:05:07.000Z",
        },
      }, 202))
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "n".repeat(43),
        status: { state: "IDLE", currentVersion: "1.1.0" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "n".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));

    const reload = vi.fn();
    const persistState = vi.fn(() => true);

    const { result } = renderHook(() => usePublicUpdate(request, { reload, persistState }));

    await waitFor(() => expect(result.current.session).toEqual(idleSession));
    await act(async () => result.current.check());
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));

    await act(async () => result.current.install());
    expect(reload).toHaveBeenCalledOnce();
    expect(persistState).toHaveBeenCalledOnce();
    expect(request.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({
      candidateId: availableStatus.candidateId,
    }));
    expect(request.mock.calls[6]?.[0]).toBe("/api/v1/app-update/apply");
  });

  it("refuses to apply when stage polling switches to a different candidate", async () => {
    const switchedCandidate = "d".repeat(43);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: availableStatus }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "DOWNLOADING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          candidateId: availableStatus.candidateId,
          downloadedBytes: 10,
          downloadBytes: availableStatus.downloadBytes,
          startedAt: "2026-08-09T03:05:05.000Z",
        },
      }, 202))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "DOWNLOADING",
          currentVersion: "1.0.0",
          latestVersion: "1.2.0",
          candidateId: switchedCandidate,
          downloadedBytes: 20,
          downloadBytes: availableStatus.downloadBytes,
          startedAt: "2026-08-09T03:05:05.000Z",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "READY_TO_RESTART",
          currentVersion: "1.0.0",
          latestVersion: "1.2.0",
          candidateId: switchedCandidate,
          stagedAt: "2026-08-09T03:05:06.000Z",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "CANDIDATE_MISMATCH", message: "wrong candidate" } }, 409));
    const { result } = renderHook(() => usePublicUpdate(request));
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));

    await act(async () => result.current.install());

    expect(result.current.clientError).toContain("검토한 업데이트 후보");
    expect(request.mock.calls.some(([url]) => url === "/api/v1/app-update/apply")).toBe(false);
  });

  it("refuses regressing stage progress before applying", async () => {
    const downloading = (downloadedBytes: number) => ({
      state: "DOWNLOADING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      downloadedBytes,
      downloadBytes: availableStatus.downloadBytes,
      startedAt: "2026-08-09T03:05:05.000Z",
    } as const);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: availableStatus }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: downloading(100) }, 202))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: downloading(50) }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "READY_TO_RESTART",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          candidateId: availableStatus.candidateId,
          stagedAt: "2026-08-09T03:05:06.000Z",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "UNEXPECTED_APPLY", message: "must not apply" } }, 409));
    const { result } = renderHook(() => usePublicUpdate(request));
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));

    await act(async () => result.current.install());

    expect(result.current.clientError).toContain("진행 상태");
    expect(request.mock.calls.some(([url]) => url === "/api/v1/app-update/apply")).toBe(false);
  });

  it("accepts a progress reset when the worker restarted with a newer start time", async () => {
    const firstAttempt = {
      state: "DOWNLOADING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      downloadedBytes: 100,
      downloadBytes: availableStatus.downloadBytes,
      startedAt: "2026-08-09T03:05:05.000Z",
    } as const;
    const restartedAttempt = { ...firstAttempt, downloadedBytes: 0, startedAt: "2026-08-09T03:05:06.000Z" } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: availableStatus }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: firstAttempt }, 202))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: restartedAttempt }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "READY_TO_RESTART",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          candidateId: availableStatus.candidateId,
          stagedAt: "2026-08-09T03:05:07.000Z",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "APPLYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          startedAt: "2026-08-09T03:05:08.000Z",
        },
      }, 202))
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "r".repeat(43),
        status: { state: "UPDATED", currentVersion: "1.1.0", previousVersion: "1.0.0", updatedAt: "2026-08-09T03:05:10.000Z" },
      }));
    const { result } = renderHook(() => usePublicUpdate(request));
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));

    await act(async () => result.current.install());

    expect(result.current.clientError).toBeNull();
    expect(result.current.status?.state).toBe("UPDATED");
  });

  it("keeps polling a slow stage operation beyond 30 minutes", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const downloading = {
        state: "DOWNLOADING",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        candidateId: availableStatus.candidateId,
        downloadedBytes: 0,
        downloadBytes: availableStatus.downloadBytes,
        startedAt: "2026-08-09T03:05:05.000Z",
      } as const;
      const stageError = {
        state: "ERROR",
        currentVersion: "1.0.0",
        operation: "STAGE",
        code: "NETWORK_ERROR",
        message: "download stopped",
      } as const;
      let call = 0;
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ ...idleSession, status: availableStatus });
        if (call === 2) return jsonResponse({ protocolVersion: 1, status: downloading }, 202);
        return Date.now() - startedAt <= 31 * 60 * 1_000
          ? jsonResponse({ protocolVersion: 1, status: downloading })
          : jsonResponse({ protocolVersion: 1, status: stageError });
      });
      const { result } = renderHook(() => usePublicUpdate(request));
      await act(async () => vi.advanceTimersByTimeAsync(0));

      let installPromise: Promise<void> | undefined;
      act(() => {
        installPromise = result.current.install();
      });
      await act(async () => vi.advanceTimersByTimeAsync(32 * 60 * 1_000));
      await installPromise;

      expect(result.current.status).toEqual(stageError);
      expect(result.current.clientError).toBeNull();
      expect(request.mock.calls.length).toBeLessThan(2_500);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps waiting when the apply response is lost and reloads after the new session appears", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockRejectedValueOnce(new TypeError("accepted response was lost"))
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "r".repeat(43),
        status: { state: "IDLE", currentVersion: "1.1.0" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "r".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    await act(async () => result.current.apply());

    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.session?.token).toBe("r".repeat(43));
  });

  it("reconnects when an accepted apply response is truncated during restart", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockResolvedValueOnce(new Response('{"protocolVersion":1,"status":', {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "t".repeat(43),
        status: { state: "IDLE", currentVersion: "1.1.0" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "t".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    await act(async () => result.current.apply());

    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.session?.token).toBe("t".repeat(43));
  });

  it("reloads the restored app so process-scoped tokens are renewed after rollback", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const rollback = {
      state: "ERROR",
      currentVersion: "1.0.0",
      operation: "APPLY",
      code: "APPLY_FAILED",
      message: "The update failed and the previous version was restored.",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "APPLYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          startedAt: "2026-08-09T03:05:07.000Z",
        },
      }, 202))
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "b".repeat(43),
        status: rollback,
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    await act(async () => result.current.apply());

    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.status).toEqual(rollback);
    expect(result.current.session?.token).toBe("b".repeat(43));
  });

  it("reloads another open tab after receiving a validated update restart broadcast", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const channel = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: "message", listener: (event: MessageEvent<unknown>) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: availableStatus }))
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "m".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, {
      reload,
      createUpdateChannel: () => channel,
    }));
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));

    act(() => messageListener?.(new MessageEvent("message", { data: {
      protocolVersion: 1,
      type: "APPLYING",
      repository: idleSession.repository,
      previousVersion: "01.0.0",
      expectedVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
    } })));
    expect(request).toHaveBeenCalledOnce();

    act(() => messageListener?.(new MessageEvent("message", { data: {
      protocolVersion: 1,
      type: "APPLYING",
      repository: idleSession.repository,
      previousVersion: "1.0.0",
      expectedVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
    } })));

    await waitFor(() => {
      expect(reload).toHaveBeenCalledOnce();
      expect(result.current.session?.token).toBe("m".repeat(43));
    });
  });

  it("does not rewrite a follower tab's stale progress before reconnecting", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const channel = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: "message", listener: (event: MessageEvent<unknown>) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: availableStatus }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "f".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const persistState = vi.fn(() => false);
    const { result } = renderHook(() => usePublicUpdate(request, {
      reload,
      persistState,
      createUpdateChannel: () => channel,
    }));
    await waitFor(() => expect(result.current.status).toEqual(availableStatus));

    act(() => messageListener?.(new MessageEvent("message", { data: {
      protocolVersion: 1,
      type: "APPLYING",
      repository: idleSession.repository,
      previousVersion: "1.0.0",
      expectedVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
    } })));

    await waitFor(() => {
      expect(reload).toHaveBeenCalledOnce();
      expect(result.current.session?.token).toBe("f".repeat(43));
    });
    expect(persistState).not.toHaveBeenCalled();
  });

  it("releases another tab when an ambiguous apply attempt leaves the old candidate ready", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const channel = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: "message", listener: (event: MessageEvent<unknown>) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, {
      reload,
      createUpdateChannel: () => channel,
    }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    act(() => messageListener?.(new MessageEvent("message", { data: {
      protocolVersion: 1,
      type: "APPLYING",
      repository: idleSession.repository,
      previousVersion: "1.0.0",
      expectedVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
    } })));

    await waitFor(() => expect(result.current.clientError).not.toBeNull());
    expect(result.current.status).toEqual(ready);
    expect(result.current.busy).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("aborts a reconnect and never reloads after the update view unmounts", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    let reconnectSignal: AbortSignal | undefined;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "APPLYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          startedAt: "2026-08-09T03:05:07.000Z",
        },
      }, 202))
      .mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
        reconnectSignal = init?.signal ?? undefined;
        reconnectSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }));
    const reload = vi.fn();
    const hook = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(hook.result.current.status).toEqual(ready));

    let updatePromise: Promise<void> | undefined;
    act(() => {
      updatePromise = hook.result.current.apply();
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    hook.unmount();
    await updatePromise;

    expect(reconnectSignal?.aborted).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("aborts an in-flight apply mutation when the app unmounts", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    let applySignal: AbortSignal | undefined;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
        applySignal = init?.signal ?? undefined;
        applySignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }));
    const reload = vi.fn();
    const hook = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(hook.result.current.status).toEqual(ready));

    let updatePromise: Promise<void> | undefined;
    act(() => {
      updatePromise = hook.result.current.apply();
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    hook.unmount();
    await updatePromise;

    expect(applySignal?.aborted).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not restart when the latest progress cannot be saved", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, {
      reload,
      persistState: () => false,
    }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    await act(async () => result.current.apply());

    expect(request).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.clientError).toContain("진행도와 설정을 저장하지 못해");
  });

  it("retries apply when the response failed before the old server accepted it", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockRejectedValueOnce(new TypeError("request never reached the server"))
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "APPLYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          startedAt: "2026-08-09T03:05:07.000Z",
        },
      }, 202))
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "q".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    await act(async () => result.current.apply());

    expect(request.mock.calls.filter(([url]) => url === "/api/v1/app-update/apply")).toHaveLength(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("finishes reconnecting with the same new-server token after opening during apply", async () => {
    const applying = {
      state: "APPLYING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      startedAt: "2026-08-09T03:05:07.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: applying }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();

    renderHook(() => usePublicUpdate(request, { reload }));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps reconnecting when a verified large update takes longer than 150 seconds", async () => {
    vi.useFakeTimers();
    try {
      const applying = {
        state: "APPLYING",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        startedAt: "2026-08-09T03:05:07.000Z",
      } as const;
      let sessionReads = 0;
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        sessionReads += 1;
        if (sessionReads === 1) {
          return jsonResponse({ ...idleSession, status: applying });
        }
        if (sessionReads <= 190) {
          return jsonResponse({ ...idleSession, status: applying });
        }
        return jsonResponse({
          ...idleSession,
          token: "l".repeat(43),
          status: {
            state: "UPDATED",
            currentVersion: "1.1.0",
            previousVersion: "1.0.0",
            updatedAt: "2026-08-09T03:08:00.000Z",
          },
        });
      });
      const reload = vi.fn();

      renderHook(() => usePublicUpdate(request, { reload }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(170_000);
      });

      expect(sessionReads).toBeGreaterThan(150);
      expect(sessionReads).toBeLessThan(300);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reconnecting when a maximum signed package takes longer than 30 minutes", async () => {
    vi.useFakeTimers();
    try {
      const applying = {
        state: "APPLYING",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        startedAt: "2026-08-09T03:05:07.000Z",
      } as const;
      const startedAt = Date.now();
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (Date.now() - startedAt <= 31 * 60 * 1_000) {
          return jsonResponse({ ...idleSession, status: applying });
        }
        return jsonResponse({
          ...idleSession,
          token: "u".repeat(43),
          status: {
            state: "UPDATED",
            currentVersion: "1.1.0",
            previousVersion: "1.0.0",
            updatedAt: "2026-08-09T03:36:08.000Z",
          },
        });
      });
      const reload = vi.fn();

      renderHook(() => usePublicUpdate(request, { reload }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(32 * 60 * 1_000);
      });

      expect(reload).toHaveBeenCalledOnce();
      expect(request.mock.calls.length).toBeLessThan(2_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues a restart broadcast received while another update operation is busy", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    let rejectStatus!: (reason: unknown) => void;
    const channel = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: "message", listener: (event: MessageEvent<unknown>) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
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
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
        rejectStatus = reject;
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "z".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, {
      reload,
      createUpdateChannel: () => channel,
    }));
    await waitFor(() => expect(result.current.busy).toBe("CHECK"));

    act(() => messageListener?.(new MessageEvent("message", { data: {
      protocolVersion: 1,
      type: "APPLYING",
      repository: idleSession.repository,
      previousVersion: "1.0.0",
      expectedVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
    } })));
    rejectStatus(new TypeError("old server stopped"));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("recovers a restart broadcast even when the old server vanished before session initialization", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const channel = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: "message", listener: (event: MessageEvent<unknown>) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "y".repeat(43),
        status: { state: "IDLE", currentVersion: "1.1.0" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "y".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, {
      reload,
      createUpdateChannel: () => channel,
    }));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    act(() => messageListener?.(new MessageEvent("message", { data: {
      protocolVersion: 1,
      type: "APPLYING",
      repository: idleSession.repository,
      previousVersion: "1.0.0",
      expectedVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
    } })));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries after transient probes miss an apply request that the old server never accepted", async () => {
    const ready = {
      state: "READY_TO_RESTART",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      stagedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockRejectedValueOnce(new TypeError("apply request failed"))
      .mockRejectedValueOnce(new TypeError("probe 1 failed"))
      .mockRejectedValueOnce(new TypeError("probe 2 failed"))
      .mockRejectedValueOnce(new TypeError("probe 3 failed"))
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: ready }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 1,
        status: {
          state: "APPLYING",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          startedAt: "2026-08-09T03:05:07.000Z",
        },
      }, 202))
      .mockResolvedValueOnce(jsonResponse({
        ...idleSession,
        token: "w".repeat(43),
        status: {
          state: "UPDATED",
          currentVersion: "1.1.0",
          previousVersion: "1.0.0",
          updatedAt: "2026-08-09T03:05:10.000Z",
        },
      }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePublicUpdate(request, { reload }));
    await waitFor(() => expect(result.current.status).toEqual(ready));

    await act(async () => result.current.apply());

    expect(request.mock.calls.filter(([url]) => url === "/api/v1/app-update/apply")).toHaveLength(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("publishes live download and verification states while staging", async () => {
    const downloading = {
      state: "DOWNLOADING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      downloadedBytes: 0,
      downloadBytes: availableStatus.downloadBytes,
      startedAt: "2026-08-09T03:05:05.000Z",
    } as const;
    const verifying = {
      state: "VERIFYING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      startedAt: "2026-08-09T03:05:06.000Z",
    } as const;
    let finalSignal: AbortSignal | undefined;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...idleSession, status: availableStatus }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: downloading }, 202))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: verifying }))
      .mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
        finalSignal = init?.signal ?? undefined;
        finalSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
    const hook = renderHook(() => usePublicUpdate(request));
    await waitFor(() => expect(hook.result.current.status).toEqual(availableStatus));

    let installPromise: Promise<void> | undefined;
    act(() => {
      installPromise = hook.result.current.install();
    });
    await waitFor(() => expect(hook.result.current.status).toEqual(verifying));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    hook.unmount();
    await installPromise;

    expect(finalSignal?.aborted).toBe(true);
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
        onInstall={onStage}
        onApply={vi.fn()}
        session={idleSession}
        status={availableStatus}
      />,
    );

    expect(screen.getByText("v1.1.0 업데이트 가능")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "변경 내용 보기" })).toHaveAttribute(
      "href",
      availableStatus.releasePageUrl,
    );
    fireEvent.click(screen.getByRole("button", { name: "업데이트 및 계속 사용" }));
    expect(onStage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "업데이트 확인" }));
    expect(onCheck).toHaveBeenCalledOnce();

    rerender(
      <PublicUpdatePanel
        busy={null}
        clientError={null}
        initializing={false}
        onCheck={onCheck}
        onInstall={onStage}
        onApply={vi.fn()}
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
    expect(screen.getByRole("button", { name: "지금 적용하고 계속 사용" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "업데이트 확인" })).toBeDisabled();
  });

  it("records a sanitized client update failure with operation and version context", async () => {
    clearClientDiagnostics();
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(idleSession))
      .mockRejectedValueOnce(new Error(`C:\\Users\\private-user\\update.zip token=${"s".repeat(43)}`));
    const { result } = renderHook(() => usePublicUpdate(request));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.check());

    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      source: "update",
      code: "REQUEST_FAILED",
      operation: "CHECK",
      currentVersion: "1.0.0",
      count: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-user");
    expect(JSON.stringify(snapshot)).not.toContain("s".repeat(43));
    expect(JSON.stringify(snapshot)).not.toContain(idleSession.token);
  });

  it("counts the same terminal update error again on a separate manual attempt", async () => {
    clearClientDiagnostics();
    const terminalError = {
      state: "ERROR",
      currentVersion: "1.0.0",
      operation: "CHECK",
      code: "GITHUB_RATE_LIMIT",
      message: "GitHub API rate limit exceeded.",
    } as const;
    const checkingStatus = {
      state: "CHECKING",
      currentVersion: "1.0.0",
      startedAt: "2026-08-13T01:00:00.000Z",
    } as const;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(idleSession))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: checkingStatus }, 202))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: terminalError }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: terminalError }));
    const { result } = renderHook(() => usePublicUpdate(request));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.check());
    await act(async () => result.current.check());

    expect(getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({
        source: "update",
        code: "GITHUB_RATE_LIMIT",
        operation: "CHECK",
        currentVersion: "1.0.0",
        count: 2,
      }),
    ]);
  });
});
