import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordClientDiagnostic } = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("../../src/services/client-diagnostics", () => ({ recordClientDiagnostic }));

import {
  fetchClientLifecycleSession,
  startClientLifecycle,
} from "../../src/services/client-lifecycle";

const session = {
  protocolVersion: 1,
  leaseToken: "l".repeat(43),
  heartbeatIntervalMs: 2_000,
  timeoutMs: 600_000,
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  recordClientDiagnostic.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("client lifecycle", () => {
  it("accepts only the strict launcher lease session contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(session));
    await expect(fetchClientLifecycleSession(undefined, request)).resolves.toEqual(session);

    const invalid = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...session,
      timeoutMs: 500,
    }));
    await expect(fetchClientLifecycleSession(undefined, invalid)).resolves.toBeNull();
  });

  it("renews the lease and sends a keepalive close when the tab is hidden", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const stop = startClientLifecycle(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(session.heartbeatIntervalMs);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).toBe("/api/v1/client/heartbeat");

    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[0]).toBe("/api/v1/client/close");
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      keepalive: true,
      method: "POST",
    });

    stop();
    await vi.advanceTimersByTimeAsync(session.heartbeatIntervalMs * 2);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries a transient startup transport failure before acquiring the lease", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("launcher is still starting"))
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const stop = startClientLifecycle(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).toBe("/api/v1/client/session");
    stop();
  });

  it("does nothing on a static host that has no lifecycle endpoint", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));
    const stop = startClientLifecycle(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("pagehide"));
    stop();
    expect(request).toHaveBeenCalledTimes(1);
    expect(recordClientDiagnostic).not.toHaveBeenCalled();
  });

  it("does not log an expected aborted lifecycle request", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("request cancelled", "AbortError"),
    );
    startClientLifecycle(request);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(recordClientDiagnostic).not.toHaveBeenCalled();
  });

  it("records one privacy-safe warning after startup transport retries are exhausted", async () => {
    vi.useFakeTimers();
    const opaqueToken = "s".repeat(43);
    const request = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError(`launcher failed at C:\\Users\\Alice\\private ${opaqueToken}`),
    );

    startClientLifecycle(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6));

    expect(recordClientDiagnostic).toHaveBeenCalledOnce();
    const diagnostic = recordClientDiagnostic.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      code: "CLIENT_LIFECYCLE_SESSION_FAILED",
      level: "warning",
      operation: "client-session",
      source: "global",
    });
    expect(diagnostic.message).not.toContain(opaqueToken);
    expect(diagnostic.operation).not.toContain(opaqueToken);
    expect(diagnostic.error).toBeInstanceOf(TypeError);
    expect(diagnostic).not.toHaveProperty("leaseToken");
  });

  it("records malformed and non-404 Direct session responses without retaining their bodies", async () => {
    const responseSecret = "n".repeat(43);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...session,
      leaseToken: responseSecret,
      unexpected: "private body",
    }));
    startClientLifecycle(malformed);
    await vi.waitFor(() => expect(malformed).toHaveBeenCalledOnce());

    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: responseSecret,
    }, 403));
    startClientLifecycle(forbidden);
    await vi.waitFor(() => expect(forbidden).toHaveBeenCalledOnce());

    await vi.waitFor(() => expect(recordClientDiagnostic).toHaveBeenCalledTimes(2));
    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry.code).sort()).toEqual([
      "CLIENT_LIFECYCLE_SESSION_FAILED",
      "CLIENT_LIFECYCLE_SESSION_MALFORMED",
    ]);
    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry.message).join(" "))
      .not.toContain(responseSecret);
    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry.message).join(" "))
      .not.toContain("private body");
  });

  it("deduplicates a heartbeat failure streak and records a new streak after recovery", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const stop = startClientLifecycle(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    for (let callCount = 2; callCount <= 5; callCount += 1) {
      await vi.advanceTimersByTimeAsync(session.heartbeatIntervalMs);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(callCount));
      await vi.waitFor(() => {
        const expectedDiagnosticCount = callCount === 2 || callCount === 3 || callCount === 4
          ? 1
          : 2;
        expect(recordClientDiagnostic).toHaveBeenCalledTimes(expectedDiagnosticCount);
      });
    }

    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        code: "CLIENT_LIFECYCLE_HEARTBEAT_FAILED",
        level: "warning",
        operation: "client-heartbeat",
        source: "global",
      }),
      expect.objectContaining({
        code: "CLIENT_LIFECYCLE_HEARTBEAT_FAILED",
        level: "warning",
        operation: "client-heartbeat",
        source: "global",
      }),
    ]);
    expect(recordClientDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      level: "warning",
      operation: "client-heartbeat",
      source: "global",
    });
    stop();
  });
});
