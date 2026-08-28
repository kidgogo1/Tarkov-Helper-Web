import { describe, expect, it, vi } from "vitest";

import { fetchJsonWithRetry } from "../../scripts/fetch-json-with-retry.mjs";

function response(status, payload, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "retry-after" ? retryAfter ?? null : null },
    json: async () => payload,
  };
}

describe("data refresh HTTP retries", () => {
  it("retries 5xx and 429 responses before returning JSON", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(429, undefined, "0"))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const waitImpl = vi.fn().mockResolvedValue(undefined);

    await expect(fetchJsonWithRetry("https://example.test/tasks", {
      fetchImpl,
      waitImpl,
      timeoutMs: 1_000,
    })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(waitImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent client error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404));

    await expect(fetchJsonWithRetry("https://example.test/missing", {
      fetchImpl,
      waitImpl: vi.fn(),
    })).rejects.toThrow("HTTP 404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports the failing URL after transient attempts are exhausted", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection reset"));

    await expect(fetchJsonWithRetry("https://example.test/tasks", {
      attempts: 2,
      fetchImpl,
      waitImpl: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow("https://example.test/tasks failed after 2 attempts");
  });

  it("aborts an individual attempt that exceeds its timeout", async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    await expect(fetchJsonWithRetry("https://example.test/slow", {
      attempts: 1,
      timeoutMs: 5,
      fetchImpl,
    })).rejects.toThrow("timed out after 5ms");
  });
});
