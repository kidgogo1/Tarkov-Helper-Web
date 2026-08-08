import { describe, expect, it, vi } from "vitest";

import {
  PublicUpdateApiError,
  checkForPublicUpdate,
  fetchPublicUpdateStatus,
  fetchPublicUpdateSession,
  stagePublicUpdate,
  type PublicUpdateSession,
} from "../../src/services/public-update";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const availableStatus = {
  state: "AVAILABLE",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  publishedAt: "2026-08-09T03:04:05.000Z",
  releasePageUrl: "https://github.com/example/tarkov-helper/releases/tag/v1.1.0",
  downloadBytes: 4_500_000,
  candidateId: "c".repeat(43),
} as const;

const session: PublicUpdateSession = {
  protocolVersion: 1,
  capability: "PUBLIC_GITHUB_RELEASES",
  token: "u".repeat(43),
  repository: "example/tarkov-helper",
  status: availableStatus,
};

describe("public GitHub update API boundary", () => {
  it("loads an exact, memory-only updater session without caching", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(session));

    await expect(fetchPublicUpdateSession(controller.signal, request)).resolves.toEqual(session);
    expect(request).toHaveBeenCalledWith("/api/v1/app-update/session", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it.each([
    { ...session, protocolVersion: 2 },
    { ...session, capability: "PRIVATE_RELEASES" },
    { ...session, token: "short" },
    { ...session, repository: "https://github.com/example/repo" },
    { ...session, repository: "example/repo/extra" },
    { ...session, extra: true },
    { ...session, status: { ...availableStatus, state: "UNKNOWN" } },
    { ...session, status: { ...availableStatus, latestVersion: "1.1.0-beta.1" } },
    { ...session, status: { ...availableStatus, latestVersion: "999999999999999999999.1.0" } },
    { ...session, status: { ...availableStatus, latestVersion: "0.9.0" } },
    { ...session, status: { ...availableStatus, downloadBytes: -1 } },
    { ...session, status: { ...availableStatus, releasePageUrl: "http://github.com/example/repo" } },
    { ...session, status: { ...availableStatus, releasePageUrl: "https://github.com/other/repo/releases/tag/v1.1.0" } },
  ])("rejects an invalid or over-broad session payload", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(fetchPublicUpdateSession(undefined, request)).resolves.toBeNull();
  });

  it("supports a direct build whose public repository is not configured yet", async () => {
    const disabled = {
      protocolVersion: 1,
      capability: "PUBLIC_GITHUB_RELEASES",
      token: "d".repeat(43),
      repository: null,
      status: {
        state: "DISABLED",
        currentVersion: "1.0.0",
        reason: "NOT_CONFIGURED",
      },
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(disabled));

    await expect(fetchPublicUpdateSession(undefined, request)).resolves.toEqual(disabled);
  });

  it("treats a static host, HTML fallback, network failure, and abort as unsupported", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html>"));
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(fetchPublicUpdateSession(undefined, missing)).resolves.toBeNull();
    await expect(fetchPublicUpdateSession(undefined, html)).resolves.toBeNull();
    await expect(fetchPublicUpdateSession(undefined, failed)).resolves.toBeNull();
    await expect(fetchPublicUpdateSession(undefined, aborted)).resolves.toBeNull();
  });

  it("checks for an update with the exact authenticated empty request", async () => {
    const checking = { state: "CHECKING", currentVersion: "1.0.0", startedAt: "2026-08-09T03:04:04.000Z" };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      status: checking,
    }, 202));

    await expect(checkForPublicUpdate(session, request)).resolves.toEqual(checking);
    expect(request).toHaveBeenCalledWith("/api/v1/app-update/check", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Update": session.token,
      },
      body: "{}",
    });
  });

  it("polls authenticated status without allowing cached or cross-session state", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      status: availableStatus,
    }));

    await expect(fetchPublicUpdateStatus(session, undefined, request)).resolves.toEqual(availableStatus);
    expect(request).toHaveBeenCalledWith("/api/v1/app-update/status", {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Tarkov-Update": session.token,
      },
      signal: undefined,
    });
  });

  it("stages only the version the user reviewed", async () => {
    const downloading = {
      state: "DOWNLOADING",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      candidateId: availableStatus.candidateId,
      downloadedBytes: 0,
      downloadBytes: availableStatus.downloadBytes,
      startedAt: "2026-08-09T03:05:05.000Z",
    } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      status: downloading,
    }, 202));

    await expect(stagePublicUpdate(session, availableStatus.candidateId, request)).resolves.toEqual(downloading);
    expect(request).toHaveBeenCalledWith("/api/v1/app-update/stage", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Update": session.token,
      },
      body: JSON.stringify({ candidateId: availableStatus.candidateId }),
    });
  });

  it("rejects semantic mismatches and normalized launcher errors", async () => {
    const wrongCheckState = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      status: {
        state: "READY_TO_RESTART",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        candidateId: availableStatus.candidateId,
        stagedAt: "2026-08-09T03:05:06.000Z",
      },
    }));
    await expect(checkForPublicUpdate(session, wrongCheckState)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const mismatched = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      status: { ...availableStatus, latestVersion: "1.2.0" },
    }));
    await expect(stagePublicUpdate(session, availableStatus.candidateId, mismatched)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const failed = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { code: "HASH_MISMATCH", message: "The package digest did not match." },
    }, 409));
    await expect(checkForPublicUpdate(session, failed)).rejects.toEqual(
      new PublicUpdateApiError("HASH_MISMATCH", "The package digest did not match."),
    );
  });
});
