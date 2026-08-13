import { describe, expect, it, vi } from "vitest";

import {
  fetchLocalTrackerEvents,
  fetchLocalTrackerStatus,
} from "../../src/services/local-tracker";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("local tracker API boundary", () => {
  it("loads and validates a watching status without caching it", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      screenshotWatcher: {
        state: "WATCHING",
        folderPath: "C:\\Users\\Tester\\Documents\\Escape from Tarkov\\Screenshots",
      },
      latestCursor: 7,
    }));

    await expect(fetchLocalTrackerStatus(controller.signal, request)).resolves.toEqual({
      protocolVersion: 1,
      screenshotWatcher: {
        state: "WATCHING",
        folderPath: "C:\\Users\\Tester\\Documents\\Escape from Tarkov\\Screenshots",
      },
      latestCursor: 7,
    });
    expect(request).toHaveBeenCalledWith("/api/v1/local-tracker/status", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it("normalizes both structured and direct watcher errors", async () => {
    const structured = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      protocolVersion: 1,
      screenshotWatcher: {
        state: "ERROR",
        error: { code: "WATCHER_FAILED", message: "폴더 감시를 시작하지 못했습니다." },
      },
      latestCursor: 0,
    }));
    const direct = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      protocolVersion: 1,
      screenshotWatcher: {
        state: "ERROR",
        message: "스크린샷 폴더 접근이 거부되었습니다.",
      },
      latestCursor: 0,
    }));

    await expect(fetchLocalTrackerStatus(undefined, structured)).resolves.toMatchObject({
      screenshotWatcher: {
        state: "ERROR",
        message: "폴더 감시를 시작하지 못했습니다.",
      },
    });
    await expect(fetchLocalTrackerStatus(undefined, direct)).resolves.toMatchObject({
      screenshotWatcher: {
        state: "ERROR",
        message: "스크린샷 폴더 접근이 거부되었습니다.",
      },
    });
  });

  it.each([
    { protocolVersion: 2, screenshotWatcher: { state: "NOT_FOUND" }, latestCursor: 0 },
    { protocolVersion: 1, screenshotWatcher: { state: "WATCHING", folderPath: "" }, latestCursor: 0 },
    { protocolVersion: 1, screenshotWatcher: { state: "BROKEN" }, latestCursor: 0 },
    { protocolVersion: 1, screenshotWatcher: { state: "ERROR" }, latestCursor: 0 },
    { protocolVersion: 1, screenshotWatcher: { state: "NOT_FOUND" }, latestCursor: -1 },
    { protocolVersion: 1, screenshotWatcher: { state: "NOT_FOUND" }, latestCursor: 1.5 },
  ])("treats an invalid status payload as unavailable", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(fetchLocalTrackerStatus(undefined, request)).resolves.toBeNull();
  });

  it("loads a cursor page and validates screenshot events", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      data: [
        {
          type: "SCREENSHOT_CREATED",
          sequence: 9,
          fileName: "2026-08-07[12-34]_10.5, 3.25, -99.5_0, 0, 0, 1_0.png",
          detectedAt: "2026-08-07T03:34:56.000Z",
        },
      ],
      pagination: {
        afterCursor: 7,
        nextCursor: 9,
        hasMore: false,
        isResetRequired: false,
      },
    }));

    await expect(fetchLocalTrackerEvents(7, controller.signal, request)).resolves.toEqual({
      protocolVersion: 1,
      data: [
        {
          type: "SCREENSHOT_CREATED",
          sequence: 9,
          fileName: "2026-08-07[12-34]_10.5, 3.25, -99.5_0, 0, 0, 1_0.png",
          detectedAt: "2026-08-07T03:34:56.000Z",
        },
      ],
      pagination: {
        afterCursor: 7,
        nextCursor: 9,
        hasMore: false,
        isResetRequired: false,
      },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/v1/local-tracker/events?afterCursor=7&pageSize=100",
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
  });

  it("preserves a bounded optional map identity from newer screenshot events", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      data: [{
        type: "SCREENSHOT_CREATED",
        sequence: 1,
        fileName: "2026-08-07[12-34]_10.5, 3.25, -99.5_0, 0, 0, 1_0.png",
        detectedAt: "2026-08-07T03:34:56.000Z",
        mapKey: "  Customs  ",
      }],
      pagination: {
        afterCursor: 0,
        nextCursor: 1,
        hasMore: false,
      },
    }));

    await expect(fetchLocalTrackerEvents(0, undefined, request)).resolves.toMatchObject({
      data: [{ mapKey: "Customs" }],
    });
  });

  it("accepts an explicit cursor reset from a bounded server event buffer", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      data: [],
      pagination: {
        afterCursor: 1,
        nextCursor: 42,
        hasMore: false,
        isResetRequired: true,
      },
    }));

    await expect(fetchLocalTrackerEvents(1, undefined, request)).resolves.toMatchObject({
      pagination: {
        nextCursor: 42,
        isResetRequired: true,
      },
    });
  });

  it.each([
    {
      protocolVersion: 1,
      data: [{ type: "SCREENSHOT_CREATED", sequence: 1, fileName: "position.png", detectedAt: "invalid" }],
      pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
    },
    {
      protocolVersion: 1,
      data: [{ type: "OTHER_EVENT", sequence: 1, fileName: "position.png", detectedAt: "2026-08-07T00:00:00Z" }],
      pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
    },
    {
      protocolVersion: 1,
      data: [],
      pagination: { afterCursor: 2, nextCursor: 1, hasMore: false },
    },
    {
      protocolVersion: 1,
      data: [],
      pagination: { afterCursor: 0, nextCursor: 0, hasMore: "no" },
    },
    {
      protocolVersion: 1,
      data: [],
      pagination: { afterCursor: 0, nextCursor: 0, hasMore: false, isResetRequired: "yes" },
    },
  ])("treats an invalid event page as unavailable", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(fetchLocalTrackerEvents(0, undefined, request)).resolves.toBeNull();
  });

  it("treats 404, network failures, invalid JSON, and aborts as unavailable", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "missing" }, 404));
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(fetchLocalTrackerStatus(undefined, missing)).resolves.toBeNull();
    await expect(fetchLocalTrackerStatus(undefined, failed)).resolves.toBeNull();
    await expect(fetchLocalTrackerStatus(undefined, invalidJson)).resolves.toBeNull();
    await expect(fetchLocalTrackerEvents(0, undefined, aborted)).resolves.toBeNull();
  });

  it("emits bounded failure reasons without exposing response bodies and excludes abort", async () => {
    const onFailure = vi.fn();
    const secret = "z".repeat(43);

    await fetchLocalTrackerStatus(
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: secret }, 404)),
      onFailure,
    );
    await fetchLocalTrackerStatus(
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ private: secret })),
      onFailure,
    );
    await fetchLocalTrackerEvents(
      0,
      undefined,
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException("cancelled", "AbortError")),
      onFailure,
    );

    expect(onFailure.mock.calls.map(([error]) => error)).toEqual([
      expect.objectContaining({ code: "NOT_FOUND", status: 404 }),
      expect.objectContaining({ code: "INVALID_RESPONSE", status: 200 }),
    ]);
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain(secret);
  });
});
