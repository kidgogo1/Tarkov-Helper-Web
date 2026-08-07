import { describe, expect, it, vi } from "vitest";

import {
  NativeOverlayApiError,
  NATIVE_OVERLAY_HOTKEY_EVENT,
  attachNativeMiniMap,
  beginNativeOverlayClaim,
  detachNativeMiniMap,
  fetchNativeOverlayEvents,
  fetchNativeOverlaySession,
  pollNativeOverlayEvents,
  updateNativeMiniMap,
  type NativeOverlaySession,
} from "../../src/services/native-overlay";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const session: NativeOverlaySession = {
  protocolVersion: 1,
  capability: "WINDOWS_DOCUMENT_PIP",
  token: "t".repeat(43),
  windowTitle: "Tarkov Helper Web",
  sizeLimits: {
    minWidth: 240,
    minHeight: 240,
    maxWidth: 1000,
    maxHeight: 1000,
  },
};

const attachedPayload = {
  protocolVersion: 1,
  overlayId: "o".repeat(43),
  state: "ATTACHED",
  mode: "UNLOCKED",
  globalHotkeysAvailable: true,
  bounds: { left: -120, top: 24, width: 1200, height: 720 },
};

describe("native overlay API boundary", () => {
  it("detects the direct launcher capability without caching the memory-only token", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(session));

    await expect(fetchNativeOverlaySession(controller.signal, request)).resolves.toEqual(session);
    expect(request).toHaveBeenCalledWith("/api/v1/native-overlay/session", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it.each([
    { ...session, protocolVersion: 2 },
    { ...session, capability: "ARBITRARY_WINDOW" },
    { ...session, token: "" },
    { ...session, windowTitle: "" },
    { ...session, extra: true },
    { ...session, sizeLimits: { ...session.sizeLimits, minWidth: 239 } },
    { ...session, sizeLimits: { ...session.sizeLimits, maxWidth: 1001 } },
    { ...session, sizeLimits: { ...session.sizeLimits, hwnd: 1234 } },
  ])("rejects an invalid or over-broad capability response", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(fetchNativeOverlaySession(undefined, request)).resolves.toBeNull();
  });

  it("treats a static-host 404, HTML fallback, network failure, and abort as unsupported", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "missing" }, 404));
    const htmlFallback = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html>"));
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(fetchNativeOverlaySession(undefined, missing)).resolves.toBeNull();
    await expect(fetchNativeOverlaySession(undefined, htmlFallback)).resolves.toBeNull();
    await expect(fetchNativeOverlaySession(undefined, failed)).resolves.toBeNull();
    await expect(fetchNativeOverlaySession(undefined, aborted)).resolves.toBeNull();
  });

  it("begins a short-lived claim with the exact authenticated empty request", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      claimId: "c".repeat(43),
      expiresAt: "2026-08-08T12:00:15.000Z",
    }, 201));

    await expect(beginNativeOverlayClaim(session, request)).resolves.toEqual({
      protocolVersion: 1,
      claimId: "c".repeat(43),
      expiresAt: "2026-08-08T12:00:15.000Z",
    });
    expect(request).toHaveBeenCalledWith("/api/v1/native-overlay/claims", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      body: "{}",
    });
  });

  it("rejects a non-ISO claim expiry even when Date.parse accepts it", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: 1,
      claimId: "c".repeat(43),
      expiresAt: "August 8, 2026 12:00:15 UTC",
    }, 201));

    await expect(beginNativeOverlayClaim(session, request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("attaches only by opaque claim and the launcher-provided title", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(attachedPayload, 201));

    await expect(attachNativeMiniMap(session, "c".repeat(43), request)).resolves.toEqual(attachedPayload);
    expect(request).toHaveBeenCalledWith("/api/v1/native-overlay/minimap", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      body: JSON.stringify({ claimId: "c".repeat(43), windowTitle: session.windowTitle }),
    });
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty("hwnd");
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty("pid");
  });

  it("rejects an attachment that does not begin in the contract's unlocked mode", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...attachedPayload,
      mode: "CLICK_THROUGH",
    }, 201));

    await expect(attachNativeMiniMap(session, "c".repeat(43), request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("accepts an attached overlay when global hotkey registration is unavailable", async () => {
    const unavailable = {
      ...attachedPayload,
      globalHotkeysAvailable: false,
    } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(unavailable, 201));

    await expect(attachNativeMiniMap(
      session,
      "c".repeat(43),
      request,
    )).resolves.toEqual(unavailable);
  });

  it("updates only the opaque overlay ID and an allowed mode", async () => {
    const locked = { ...attachedPayload, mode: "LOCKED" } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(locked));

    await expect(updateNativeMiniMap(session, "o".repeat(43), "LOCKED", {}, request)).resolves.toEqual(locked);
    expect(request).toHaveBeenCalledWith("/api/v1/native-overlay/minimap", {
      method: "PATCH",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      body: JSON.stringify({ overlayId: "o".repeat(43), mode: "LOCKED" }),
    });
  });

  it("sets an allowed width and height together for the first locked overlay", async () => {
    const locked = {
      ...attachedPayload,
      mode: "LOCKED",
      bounds: { ...attachedPayload.bounds, width: 300, height: 300 },
    } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(locked));

    await expect(updateNativeMiniMap(
      session,
      "o".repeat(43),
      "LOCKED",
      { width: 300, height: 300 },
      request,
    )).resolves.toEqual(locked);
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({
      overlayId: "o".repeat(43),
      mode: "LOCKED",
      width: 300,
      height: 300,
    });
  });

  it.each([
    { width: 301, height: 300 },
    { width: 300, height: 301 },
  ])("rejects a resized PATCH response whose bounds do not match the requested size", async (bounds) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...attachedPayload,
      mode: "LOCKED",
      bounds: { ...attachedPayload.bounds, ...bounds },
    }));

    await expect(updateNativeMiniMap(
      session,
      "o".repeat(43),
      "LOCKED",
      { width: 300, height: 300 },
      request,
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    {
      ...attachedPayload,
      overlayId: "x".repeat(43),
      mode: "LOCKED" as const,
    },
    {
      ...attachedPayload,
      mode: "CLICK_THROUGH" as const,
    },
  ])("rejects a PATCH response for a different overlay or mode", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(updateNativeMiniMap(
      session,
      "o".repeat(43),
      "LOCKED",
      {},
      request,
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    { mode: "LOCKED" as const, size: { width: 300 } },
    { mode: "LOCKED" as const, size: { width: 239, height: 300 } },
    { mode: "LOCKED" as const, size: { width: 300, height: 1001 } },
    { mode: "UNLOCKED" as const, size: { width: 300, height: 300 } },
  ])("blocks an invalid native resize before sending it", async ({ mode, size }) => {
    const request = vi.fn<typeof fetch>();
    await expect(updateNativeMiniMap(
      session,
      "o".repeat(43),
      mode,
      size,
      request,
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(request).not.toHaveBeenCalled();
  });

  it("restores and detaches with keepalive during lifecycle cleanup", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(detachNativeMiniMap(session, "o".repeat(43), { keepalive: true }, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/native-overlay/minimap", {
      method: "DELETE",
      cache: "no-store",
      keepalive: true,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      body: JSON.stringify({ overlayId: "o".repeat(43) }),
    });
  });

  it.each([
    { ...attachedPayload, overlayId: "" },
    { ...attachedPayload, state: "DETACHED" },
    { ...attachedPayload, mode: "ALWAYS_ON_TOP" },
    { ...attachedPayload, globalHotkeysAvailable: "true" },
    {
      protocolVersion: 1,
      overlayId: "o".repeat(43),
      state: "ATTACHED",
      mode: "UNLOCKED",
      bounds: attachedPayload.bounds,
    },
    { ...attachedPayload, hwnd: 1234 },
    { ...attachedPayload, bounds: { ...attachedPayload.bounds, width: 0 } },
    { ...attachedPayload, bounds: { ...attachedPayload.bounds, pid: 99 } },
  ])("rejects invalid, unknown, or native-identifier attachment fields", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload, 201));
    await expect(attachNativeMiniMap(session, "c".repeat(43), request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("returns a sanitized structured command error without trusting server text", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: {
        code: "AMBIGUOUS_WINDOW",
        message: "untrusted internal detail C:\\secret",
      },
    }, 409));

    const error = await beginNativeOverlayClaim(session, request).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeOverlayApiError);
    expect(error).toMatchObject({ code: "AMBIGUOUS_WINDOW", status: 409 });
    expect((error as Error).message).not.toContain("secret");
  });

  it("reads an exact authenticated native event batch without a manual Origin header", async () => {
    const controller = new AbortController();
    const payload = {
      protocolVersion: 1,
      latestCursor: 9,
      events: [
        { cursor: 8, action: "ZOOM_IN" },
        { cursor: 9, action: "ZOOM_OUT" },
      ],
    } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

    await expect(fetchNativeOverlayEvents(
      session,
      7,
      controller.signal,
      request,
    )).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith("/api/v1/native-overlay/events?after=7", {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      signal: controller.signal,
    });
    const headers = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Origin");
    expect(headers).not.toHaveProperty("Content-Type");
  });

  it.each([
    {
      protocolVersion: 1,
      latestCursor: 0,
      events: [],
      extra: true,
    },
    {
      protocolVersion: 1,
      latestCursor: -1,
      events: [],
    },
    {
      protocolVersion: 1,
      latestCursor: 1,
      events: [],
    },
    {
      protocolVersion: 1,
      latestCursor: 1,
      events: [{ cursor: 1, action: "ZOOM_IN", extra: true }],
    },
    {
      protocolVersion: 1,
      latestCursor: 1,
      events: [{ cursor: 0, action: "ZOOM_IN" }],
    },
    {
      protocolVersion: 1,
      latestCursor: 2,
      events: [
        { cursor: 2, action: "ZOOM_IN" },
        { cursor: 1, action: "ZOOM_OUT" },
      ],
    },
    {
      protocolVersion: 1,
      latestCursor: 1,
      events: [{ cursor: 1, action: "MOVE_WINDOW" }],
    },
  ])("rejects an invalid native event batch", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(fetchNativeOverlayEvents(
      session,
      0,
      undefined,
      request,
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects overlarge batches and an invalid cursor before it can affect polling", async () => {
    const overlarge = {
      protocolVersion: 1,
      latestCursor: 101,
      events: Array.from({ length: 101 }, (_, index) => ({
        cursor: index + 1,
        action: "ZOOM_IN",
      })),
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(overlarge));

    await expect(fetchNativeOverlayEvents(
      session,
      0,
      undefined,
      request,
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const untouchedRequest = vi.fn<typeof fetch>();
    await expect(fetchNativeOverlayEvents(
      session,
      -1,
      undefined,
      untouchedRequest,
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(untouchedRequest).not.toHaveBeenCalled();
  });

  it("polls from the latest cursor and converts each native action exactly once", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({
          protocolVersion: 1,
          latestCursor: 2,
          events: [
            { cursor: 1, action: "ZOOM_IN" },
            { cursor: 2, action: "ZOOM_OUT" },
          ],
        }))
        .mockResolvedValueOnce(jsonResponse({
          protocolVersion: 1,
          latestCursor: 2,
          events: [],
        }));
      const target = new EventTarget();
      const received: unknown[] = [];
      target.addEventListener(NATIVE_OVERLAY_HOTKEY_EVENT, (event) => {
        received.push((event as CustomEvent).detail);
      });
      const controller = new AbortController();

      const polling = pollNativeOverlayEvents(session, controller.signal, target, request);
      await vi.advanceTimersByTimeAsync(200);
      expect(received).toEqual([
        { protocolVersion: 1, action: "MINIMAP_ZOOM_IN" },
        { protocolVersion: 1, action: "MINIMAP_ZOOM_OUT" },
      ]);
      await vi.advanceTimersByTimeAsync(200);
      expect(request.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/v1/native-overlay/events?after=0",
        "/api/v1/native-overlay/events?after=2",
      ]);
      expect(received).toHaveLength(2);

      controller.abort();
      await polling;
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers after a transient network failure", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("temporary"))
        .mockResolvedValueOnce(jsonResponse({
          protocolVersion: 1,
          latestCursor: 1,
          events: [{ cursor: 1, action: "ZOOM_IN" }],
        }));
      const target = new EventTarget();
      const listener = vi.fn();
      target.addEventListener(NATIVE_OVERLAY_HOTKEY_EVENT, listener);
      const controller = new AbortController();
      const polling = pollNativeOverlayEvents(
        session,
        controller.signal,
        target,
        request,
      );

      await vi.advanceTimersByTimeAsync(400);
      expect(request).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledOnce();
      expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        protocolVersion: 1,
        action: "MINIMAP_ZOOM_IN",
      });

      controller.abort();
      await polling;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after exhausting the bounded network retry budget", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("temporary"));
      const controller = new AbortController();
      const polling = pollNativeOverlayEvents(
        session,
        controller.signal,
        new EventTarget(),
        request,
      );

      await vi.runAllTimersAsync();
      await polling;
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight poll without dispatching a stale event", async () => {
    vi.useFakeTimers();
    try {
      let resolveRequest: ((response: Response) => void) | undefined;
      const requestResponse = new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
      const request = vi.fn<typeof fetch>().mockReturnValue(requestResponse);
      const target = new EventTarget();
      const listener = vi.fn();
      target.addEventListener(NATIVE_OVERLAY_HOTKEY_EVENT, listener);
      const controller = new AbortController();

      const polling = pollNativeOverlayEvents(session, controller.signal, target, request);
      await vi.advanceTimersByTimeAsync(200);
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      controller.abort();
      resolveRequest?.(jsonResponse({
        protocolVersion: 1,
        latestCursor: 1,
        events: [{ cursor: 1, action: "ZOOM_IN" }],
      }));
      await polling;

      expect(listener).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops dispatching the current batch as soon as polling is aborted", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        protocolVersion: 1,
        latestCursor: 2,
        events: [
          { cursor: 1, action: "ZOOM_IN" },
          { cursor: 2, action: "ZOOM_OUT" },
        ],
      }));
      const controller = new AbortController();
      const target = new EventTarget();
      const listener = vi.fn(() => controller.abort());
      target.addEventListener(NATIVE_OVERLAY_HOTKEY_EVENT, listener);

      const polling = pollNativeOverlayEvents(session, controller.signal, target, request);
      await vi.advanceTimersByTimeAsync(200);
      await polling;

      expect(listener).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
