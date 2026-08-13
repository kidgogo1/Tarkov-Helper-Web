import { describe, expect, it, vi } from "vitest";

import {
  NativeOverlayV2ApiError,
  attachNativeOverlayWindow,
  beginNativeOverlayV2Claim,
  detachNativeOverlayWindow,
  fetchNativeOverlayV2Session,
  updateNativeOverlayWindow,
  type NativeOverlayV2Session,
} from "../../src/services/native-overlay-v2";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const session: NativeOverlayV2Session = {
  protocolVersion: 2,
  capability: "WINDOWS_MULTI_OVERLAY",
  token: "t".repeat(43),
  windowTitles: {
    minimap: "Tarkov Helper Web",
    questList: "Tarkov Helper Quest List",
  },
  sizeLimits: {
    minWidth: 240,
    minHeight: 240,
    maxWidth: 1000,
    maxHeight: 1000,
  },
};

const questAttachment = {
  protocolVersion: 2,
  overlayKind: "quest-list",
  overlayId: "o".repeat(43),
  state: "ATTACHED",
  mode: "UNLOCKED",
  globalHotkeysAvailable: false,
  bounds: { left: -320, top: 48, width: 430, height: 680 },
} as const;

describe("native multi-overlay v2 API boundary", () => {
  it("detects an exact memory-only multi-overlay session", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(session));

    await expect(fetchNativeOverlayV2Session(controller.signal, request))
      .resolves.toEqual(session);
    expect(request).toHaveBeenCalledWith("/api/v2/native-overlay/session", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it.each([
    { ...session, protocolVersion: 1 },
    { ...session, capability: "ARBITRARY_WINDOW" },
    { ...session, token: "" },
    { ...session, windowTitles: { ...session.windowTitles, questList: "Other" } },
    { ...session, windowTitles: { ...session.windowTitles, extra: "Other" } },
    { ...session, sizeLimits: { ...session.sizeLimits, maxHeight: 1001 } },
    { ...session, extra: true },
  ])("rejects an invalid or over-broad v2 capability", async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(fetchNativeOverlayV2Session(undefined, request)).resolves.toBeNull();
  });

  it("creates a kind-bound claim before the quest popup is opened", async () => {
    const claim = {
      protocolVersion: 2,
      overlayKind: "quest-list",
      claimId: "c".repeat(43),
      expiresAt: "2026-08-13T12:00:15.000Z",
    } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(claim, 201));

    await expect(beginNativeOverlayV2Claim(session, "quest-list", request))
      .resolves.toEqual(claim);
    expect(request).toHaveBeenCalledWith("/api/v2/native-overlay/claims", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      body: JSON.stringify({ overlayKind: "quest-list" }),
    });
  });

  it("attaches a quest-list window without exposing a PID or HWND", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(questAttachment, 201));

    await expect(attachNativeOverlayWindow(
      session,
      "quest-list",
      "c".repeat(43),
      request,
    )).resolves.toEqual(questAttachment);
    const body = JSON.parse(request.mock.calls[0]?.[1]?.body as string);
    expect(request).toHaveBeenCalledWith("/api/v2/native-overlay/windows", expect.objectContaining({
      method: "POST",
    }));
    expect(body).toEqual({
      overlayKind: "quest-list",
      claimId: "c".repeat(43),
      windowTitle: session.windowTitles.questList,
    });
    expect(body).not.toHaveProperty("pid");
    expect(body).not.toHaveProperty("hwnd");
  });

  it("locks, resizes, and changes opacity only for the named quest record", async () => {
    const locked = {
      ...questAttachment,
      mode: "LOCKED",
      bounds: { ...questAttachment.bounds, width: 430, height: 680 },
    } as const;
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(locked));

    await expect(updateNativeOverlayWindow(
      session,
      "quest-list",
      questAttachment.overlayId,
      "LOCKED",
      { width: 430, height: 680, opacity: 0.9 },
      request,
    )).resolves.toEqual(locked);
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({
      overlayKind: "quest-list",
      overlayId: questAttachment.overlayId,
      mode: "LOCKED",
      width: 430,
      height: 680,
      opacity: 0.9,
    });
  });

  it("restores and detaches only the named quest record during lifecycle cleanup", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(detachNativeOverlayWindow(
      session,
      "quest-list",
      questAttachment.overlayId,
      { keepalive: true },
      request,
    )).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v2/native-overlay/windows", {
      method: "DELETE",
      cache: "no-store",
      keepalive: true,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Overlay": session.token,
      },
      body: JSON.stringify({
        overlayKind: "quest-list",
        overlayId: questAttachment.overlayId,
      }),
    });
  });

  it("fails closed when the launcher returns a different kind or record", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...questAttachment,
      overlayKind: "minimap",
    }, 201));

    await expect(attachNativeOverlayWindow(
      session,
      "quest-list",
      "c".repeat(43),
      request,
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("sanitizes launcher errors instead of exposing server-provided paths", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: {
        code: "AMBIGUOUS_WINDOW",
        message: "secret C:\\private\\window.txt",
      },
    }, 409));

    const error = await beginNativeOverlayV2Claim(
      session,
      "quest-list",
      request,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeOverlayV2ApiError);
    expect(error).toMatchObject({ code: "AMBIGUOUS_WINDOW", status: 409 });
    expect((error as Error).message).not.toContain("private");
  });
});
