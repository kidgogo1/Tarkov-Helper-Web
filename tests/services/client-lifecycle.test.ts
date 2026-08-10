import { afterEach, describe, expect, it, vi } from "vitest";

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
  });
});
