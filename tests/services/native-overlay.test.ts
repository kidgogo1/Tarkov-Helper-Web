import { describe, expect, it, vi } from "vitest";

import {
  NativeOverlayApiError,
  attachNativeMiniMap,
  beginNativeOverlayClaim,
  detachNativeMiniMap,
  fetchNativeOverlaySession,
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
});
