import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
  installGlobalDiagnosticHandlers,
  recordClientDiagnostic,
} from "../../src/services/client-diagnostics";

describe("client diagnostics", () => {
  beforeEach(() => {
    localStorage.clear();
    clearClientDiagnostics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearClientDiagnostics();
  });

  it("redacts private paths, URL queries, headers, opaque tokens, and control characters", () => {
    const token = "A".repeat(43);

    recordClientDiagnostic({
      code: "UPDATE_FAILED",
      error: new Error(
        `C:\\Users\\private-user\\Downloads\\update.zip\r\n` +
          `https://example.test/update.json?token=secret#part opaque=${token} ` +
          `Authorization: Bearer ${token} Cookie: session=secret X-Tarkov-Token: ${token}`,
      ),
      source: "update",
    });

    const [entry] = getClientDiagnosticSnapshot().entries;
    expect(entry.message).not.toContain("private-user");
    expect(entry.message).not.toContain("secret");
    expect(entry.message).not.toContain(token);
    expect(entry.message).not.toContain("\r");
    expect(entry.message).not.toContain("\n");
    expect(entry.message).toBe("[REDACTED_PATH]");
  });

  it("strips URL credentials, queries, and fragments without hiding the safe origin path", () => {
    recordClientDiagnostic({
      code: "URL_SECRET",
      message: "https://user:pass@example.test/update.json?token=secret#part",
      source: "update",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("https://example.test/update.json");
    expect(message).not.toMatch(/user|pass|token|secret|part/);
  });

  it("redacts short secrets carried by known sensitive field names", () => {
    recordClientDiagnostic({
      code: "SHORT_SECRETS",
      message: "token=shortsecret nonce: tiny apiKey='abc123' claimId=claim overlayId: overlay candidateId=candidate " +
        "secret=hidden password=pw healthNonce=health updateNonce=update controlToken=control leaseToken=lease api_key=key",
      source: "update",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).not.toMatch(/shortsecret|tiny|abc123|claim|overlay|candidate|hidden|\bpw\b|health|update|control|lease|\bkey\b/);
    expect(message).toBe("[REDACTED]");
  });

  it("redacts complete multi-value cookie header lines", () => {
    recordClientDiagnostic({
      code: "COOKIE_HEADER",
      message: "Cookie: first=one; second=two; third=three\r\nsafe suffix",
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("[REDACTED_HEADER]");
    expect(message).not.toMatch(/first|second|third|one|two|three/);
  });

  it("redacts quoted sensitive values containing spaces", () => {
    recordClientDiagnostic({
      code: "QUOTED_SECRET",
      message: `token="short secret" password='two words' safe`,
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("[REDACTED]");
    expect(message).not.toMatch(/short|secret|two|words/);
  });

  it.each([
    ['{"password":"hunter2"}', "hunter2"],
    ['{"apiKey":"abc123"}', "abc123"],
  ])("redacts a quoted JSON sensitive key from %s", (input, secret) => {
    recordClientDiagnostic({
      code: "JSON_SECRET",
      message: input,
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).not.toContain(secret);
    expect(message).toBe("{[REDACTED]");
  });

  it("redacts an opaque value surrounded by non-word token characters", () => {
    const opaque = `--${"A".repeat(39)}--`;
    recordClientDiagnostic({
      code: "OPAQUE_SECRET",
      message: opaque,
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("[REDACTED]");
    expect(message).not.toContain("A".repeat(8));
  });

  it("redacts opaque credentials longer than 64 characters", () => {
    const opaque = "Z".repeat(100);
    recordClientDiagnostic({
      code: "LONG_OPAQUE_SECRET",
      message: `credential ${opaque} trailing`,
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("credential [REDACTED] trailing");
    expect(message).not.toContain("Z".repeat(8));
  });

  it("fails closed on unterminated sensitive values and header continuations", () => {
    recordClientDiagnostic({
      code: "UNTERMINATED_SECRET",
      message: `safe password="hunter2 secret-suffix`,
      source: "global",
    });
    recordClientDiagnostic({
      code: "HEADER_CONTINUATION",
      message: "safe Authorization: Bearer first\r\n refreshCredential=LEAKME",
      source: "global",
    });

    const [secret, header] = getClientDiagnosticSnapshot().entries;
    expect(secret.message).toBe("safe [REDACTED]");
    expect(header.message).toBe("safe [REDACTED_HEADER]");
    expect(JSON.stringify([secret, header])).not.toMatch(/hunter2|secret-suffix|first|LEAKME/);
  });

  it("does not retain an opaque credential cut by the raw input bound", () => {
    const collapsiblePrefix = "\u0085".repeat(16_370);
    const boundaryCredential = `--${"B".repeat(39)}--`;
    expect(collapsiblePrefix).toHaveLength(16_370);

    recordClientDiagnostic({
      code: "BOUNDARY_SECRET",
      message: collapsiblePrefix + boundaryCredential + " trailing",
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).not.toContain("B".repeat(8));
    expect(message).toContain("[TRUNCATED]");
  });

  it("drops a long quoted secret whose closing quote falls beyond the raw bound", () => {
    const input = "\u0085".repeat(16_184) + `password="FIRSTPART ${"S".repeat(500)}"`;

    recordClientDiagnostic({
      code: "BOUNDARY_QUOTED_SECRET",
      message: input,
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("[TRUNCATED]");
    expect(message).not.toMatch(/FIRSTPART|SSSSSSSSSS/);
  });

  it("pre-bounds very large errors before sanitizing and storing them", () => {
    recordClientDiagnostic({
      code: "HUGE_ERROR",
      message: `token=short ${"x".repeat(100 * 1024)}`,
      source: "global",
    });

    const [entry] = getClientDiagnosticSnapshot().entries;
    expect(entry.message.length).toBeLessThanOrEqual(500);
    expect(entry.message).not.toContain("short");
  });

  it("redacts file URLs and Windows paths written with forward slashes from stacks", () => {
    const error = new Error("failed");
    error.stack = "Error: failed\n at file:///C:/Users/Alice/private/app.js:10:2\n at C:/Users/Alice/private/other.js:3:1";

    recordClientDiagnostic({ code: "STACK_PATH", error, source: "global" });

    const stack = getClientDiagnosticSnapshot().entries[0].stack ?? "";
    expect(stack).not.toContain("Alice");
    expect(stack).not.toContain("file:///");
    expect(stack).toBe("Error: failed at [REDACTED_PATH]");
  });

  it("aggressively redacts Windows paths containing spaces in messages and stacks", () => {
    const error = new Error("C:\\Users\\John Doe\\private\\update.zip could not open");
    error.stack = "Error: failed\n at C:/Users/John Doe/private/app.js:10:2";

    recordClientDiagnostic({ code: "SPACED_PATH", error, source: "global" });

    const [entry] = getClientDiagnosticSnapshot().entries;
    expect(entry.message).toBe("[REDACTED_PATH]");
    expect(entry.stack).toContain("[REDACTED_PATH]");
    expect(JSON.stringify(entry)).not.toMatch(/John|Doe|private/);
  });

  it("redacts the complete suffix of user paths containing apostrophes", () => {
    recordClientDiagnostic({
      code: "APOSTROPHE_PATH",
      message: "C:\\Users\\Alice's PC\\secret-folder\\file.txt failed",
      source: "global",
    });

    const message = getClientDiagnosticSnapshot().entries[0].message;
    expect(message).toBe("[REDACTED_PATH]");
    expect(message).not.toMatch(/Alice|PC|secret-folder|file\.txt/);
  });

  it("aggregates duplicate events and bounds the persisted ring to 100 entries and 64 KiB", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    recordClientDiagnostic({ code: "SAME", message: "same failure", source: "react" });
    vi.setSystemTime(new Date("2026-08-13T00:01:00.000Z"));
    recordClientDiagnostic({ code: "SAME", message: "same failure", source: "react" });

    const duplicate = getClientDiagnosticSnapshot().entries[0];
    expect(duplicate.count).toBe(2);
    expect(duplicate.occurredAt).toBe("2026-08-13T00:00:00.000Z");
    expect(duplicate.lastOccurredAt).toBe("2026-08-13T00:01:00.000Z");

    for (let index = 0; index < 125; index += 1) {
      recordClientDiagnostic({
        code: `FAILURE_${index}`,
        message: `${index}-${"x".repeat(700)}`,
        source: "global",
      });
    }

    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.entries.length).toBeLessThanOrEqual(100);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.entries)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(new TextEncoder().encode(
      localStorage.getItem("tarkov-helper:client-diagnostics:v1") ?? "",
    ).byteLength).toBeLessThanOrEqual(64 * 1024);
    const diagnosticStorageBytes = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith("tarkov-helper:client-diagnostics:v1")))
      .reduce((total, key) => total + new TextEncoder().encode(localStorage.getItem(key) ?? "").byteLength, 0);
    expect(diagnosticStorageBytes).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.entries.some((entry) => entry.code === "FAILURE_124")).toBe(true);
    vi.useRealTimers();
  });

  it("enforces the ring budget on a first-run empty storage without an explicit clear", async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import("../../src/services/client-diagnostics");
    for (let index = 0; index < 125; index += 1) {
      fresh.recordClientDiagnostic({
        code: `FRESH_${index}`,
        message: `${index}-${"x".repeat(700)}`,
        source: "global",
      });
    }
    const diagnosticKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith("tarkov-helper:client-diagnostics:v1")));
    const totalBytes = diagnosticKeys.reduce(
      (total, key) => total + new TextEncoder().encode(localStorage.getItem(key) ?? "").byteLength,
      0,
    );
    expect(fresh.getClientDiagnosticSnapshot().entries.length).toBeLessThanOrEqual(100);
    expect(totalBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("moves a repeated full-ring entry to the newest position before eviction", () => {
    for (let index = 0; index < 100; index += 1) {
      recordClientDiagnostic({ code: `RING_${index}`, message: `failure ${index}`, source: "global" });
    }

    recordClientDiagnostic({ code: "RING_0", message: "failure 0", source: "global" });
    recordClientDiagnostic({ code: "RING_100", message: "failure 100", source: "global" });

    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.entries).toHaveLength(100);
    expect(snapshot.entries.some((entry) => entry.code === "RING_0" && entry.count === 2)).toBe(true);
    expect(snapshot.entries.some((entry) => entry.code === "RING_1")).toBe(false);
    expect(snapshot.entries.at(-1)?.code).toBe("RING_100");
  });

  it("falls back to memory and never throws when localStorage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => {
      recordClientDiagnostic({ code: "QUOTA", message: "still retained", source: "global" });
    }).not.toThrow();

    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.persistence).toBe("memory");
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].code).toBe("QUOTA");
  });

  it("flushes bounded memory diagnostics after storage becomes writable again", async () => {
    const nativeSetItem = Storage.prototype.setItem;
    let blockWrites = true;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (blockWrites) throw new DOMException("Storage blocked", "SecurityError");
      return nativeSetItem.call(this, key, value);
    });
    for (let index = 0; index < 125; index += 1) {
      recordClientDiagnostic({ code: `MEMORY_${index}`, message: "temporary", source: "global" });
    }
    expect(getClientDiagnosticSnapshot()).toMatchObject({ persistence: "memory" });
    expect(getClientDiagnosticSnapshot().entries.length).toBeLessThanOrEqual(100);

    blockWrites = false;
    expect(getClientDiagnosticSnapshot()).toMatchObject({ persistence: "localStorage" });
    setItem.mockRestore();
    vi.resetModules();
    const reloaded = await import("../../src/services/client-diagnostics");
    expect(reloaded.getClientDiagnosticSnapshot().entries.some((entry) => entry.code === "MEMORY_124")).toBe(true);
  });

  it("does not serialize arbitrary or cyclic rejection objects", () => {
    const rejection: { secret: string; self?: unknown } = { secret: "must-not-leak" };
    rejection.self = rejection;

    expect(() => recordClientDiagnostic({
      code: "UNHANDLED_REJECTION",
      error: rejection,
      source: "global",
    })).not.toThrow();

    const [entry] = getClientDiagnosticSnapshot().entries;
    expect(entry.message).toBe("세부 정보를 안전하게 기록할 수 없는 오류");
    expect(JSON.stringify(entry)).not.toContain("must-not-leak");
  });

  it("stays fail-open for hostile proxy rejection reasons", () => {
    const rejection = new Proxy({}, {
      has() {
        throw new Error("hostile proxy");
      },
    });

    expect(() => recordClientDiagnostic({
      code: "UNHANDLED_REJECTION",
      error: rejection,
      source: "global",
    })).not.toThrow();
  });

  it("ignores AbortError and expected static 404 diagnostics", () => {
    const aborted = recordClientDiagnostic({
      code: "UNHANDLED_REJECTION",
      error: new DOMException("Aborted", "AbortError"),
      source: "global",
    });
    const staticMissing = recordClientDiagnostic({
      code: "OPTIONAL_RESOURCE_NOT_FOUND",
      error: new Error("GET /assets/optional-pack.json returned 404 Not Found"),
      source: "optional-resource",
    });

    expect(aborted).toBe(false);
    expect(staticMissing).toBe(false);
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });

  it("retains update failures that happen to contain a 404 response", () => {
    recordClientDiagnostic({
      code: "REQUEST_FAILED",
      error: new Error("GET /api/v1/app-update/status returned 404 Not Found"),
      source: "update",
    });

    expect(getClientDiagnosticSnapshot().entries).toHaveLength(1);
  });

  it("installs global listeners once, ignores resource errors, and cleans up by reference", () => {
    const stopFirst = installGlobalDiagnosticHandlers(window);
    const stopSecond = installGlobalDiagnosticHandlers(window);

    const firstError = new ErrorEvent("error", { error: new Error("render loop"), message: "render loop" });
    window.dispatchEvent(firstError);
    expect(firstError.defaultPrevented).toBe(false);
    expect(getClientDiagnosticSnapshot().entries[0].count).toBe(1);

    const image = document.createElement("img");
    document.body.append(image);
    image.dispatchEvent(new ErrorEvent("error", { error: new Error("image failed"), message: "image failed" }));
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(1);

    stopFirst();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("render loop"), message: "render loop" }));
    expect(getClientDiagnosticSnapshot().entries[0].count).toBe(2);

    stopSecond();
    const afterCleanup = new ErrorEvent("error", { cancelable: true, message: "render loop" });
    afterCleanup.preventDefault();
    window.dispatchEvent(afterCleanup);
    expect(getClientDiagnosticSnapshot().entries[0].count).toBe(2);
  });

  it("rejects oversized or structurally untrusted persisted diagnostics", async () => {
    localStorage.setItem(
      "tarkov-helper:client-diagnostics:v1",
      JSON.stringify({
        schemaVersion: 1,
        entries: [{
          schemaVersion: 1,
          occurredAt: "2026-08-13T00:00:00.000Z",
          lastOccurredAt: "2026-08-13T00:00:00.000Z",
          level: "error",
          source: "global",
          code: "INJECTED",
          message: "safe-looking",
          appVersion: "1.0.31",
          count: 1,
          secret: "must not be exported",
        }],
      }),
    );

    // Force a new lazy load without relying on private module state.
    vi.resetModules();
    const diagnostics = await import("../../src/services/client-diagnostics");
    expect(diagnostics.getClientDiagnosticSnapshot().entries).toHaveLength(0);

    localStorage.setItem("tarkov-helper:client-diagnostics:v1", "x".repeat(64 * 1024 + 1));
    vi.resetModules();
    const oversizedDiagnostics = await import("../../src/services/client-diagnostics");
    expect(oversizedDiagnostics.getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });

  it("rejects persisted timestamps unless they round-trip as strict ISO UTC", async () => {
    localStorage.setItem(
      "tarkov-helper:client-diagnostics:v1",
      JSON.stringify({
        schemaVersion: 1,
        entries: [{
          schemaVersion: 1,
          occurredAt: "Thu, 13 Aug 2026 01:02:03 GMT (LEAK)",
          lastOccurredAt: "2026-08-13T01:02:03.000Z",
          level: "error",
          source: "global",
          code: "INJECTED_TIMESTAMP",
          message: "safe-looking",
          appVersion: "1.0.31",
          count: 1,
        }],
      }),
    );

    vi.resetModules();
    const diagnostics = await import("../../src/services/client-diagnostics");
    expect(diagnostics.getClientDiagnosticSnapshot().entries).toHaveLength(0);
    expect(diagnostics.exportClientDiagnostics()).not.toContain("LEAK");
  });

  it("merges sequential writes from independent module instances", async () => {
    localStorage.clear();
    vi.resetModules();
    const first = await import("../../src/services/client-diagnostics");
    first.getClientDiagnosticSnapshot();
    vi.resetModules();
    const second = await import("../../src/services/client-diagnostics");
    second.getClientDiagnosticSnapshot();

    first.recordClientDiagnostic({ code: "FIRST_TAB", message: "first", source: "global" });
    second.recordClientDiagnostic({ code: "SECOND_TAB", message: "second", source: "global" });

    expect(second.getClientDiagnosticSnapshot().entries.map((entry) => entry.code)).toEqual([
      "FIRST_TAB",
      "SECOND_TAB",
    ]);
  });

  it("does not orphan a first-run event when two modules initialize from an empty snapshot", async () => {
    localStorage.clear();
    vi.resetModules();
    const first = await import("../../src/services/client-diagnostics");
    first.getClientDiagnosticSnapshot();
    const nativeGetItem = Storage.prototype.getItem;
    let hideInitialManifest = true;
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (hideInitialManifest && key === "tarkov-helper:client-diagnostics:v1") {
        hideInitialManifest = false;
        return null;
      }
      return nativeGetItem.call(this, key);
    });
    vi.resetModules();
    const second = await import("../../src/services/client-diagnostics");
    second.getClientDiagnosticSnapshot();
    getItem.mockRestore();

    first.recordClientDiagnostic({ code: "FIRST_COLD_TAB", message: "first", source: "global" });
    second.recordClientDiagnostic({ code: "SECOND_COLD_TAB", message: "second", source: "global" });
    expect(first.getClientDiagnosticSnapshot().entries.map((entry) => entry.code)).toEqual([
      "FIRST_COLD_TAB",
      "SECOND_COLD_TAB",
    ]);
  });

  it("converges same-diagnostic counts after independent writers race on a stale snapshot", async () => {
    localStorage.clear();
    vi.resetModules();
    const first = await import("../../src/services/client-diagnostics");
    first.getClientDiagnosticSnapshot();
    vi.resetModules();
    const second = await import("../../src/services/client-diagnostics");
    second.getClientDiagnosticSnapshot();

    first.recordClientDiagnostic({ code: "SAME_TAB_FAILURE", message: "same", source: "global" });
    const competingEventKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .find((key) => key?.startsWith("tarkov-helper:client-diagnostics:v1:event:"));
    expect(competingEventKey).toBeTruthy();
    const nativeGetItem = Storage.prototype.getItem;
    let hideCompetingWrite = true;
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (hideCompetingWrite && key === competingEventKey) {
        hideCompetingWrite = false;
        return null;
      }
      return nativeGetItem.call(this, key);
    });
    second.recordClientDiagnostic({ code: "SAME_TAB_FAILURE", message: "same", source: "global" });
    getItem.mockRestore();

    expect(first.getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({ code: "SAME_TAB_FAILURE", count: 2 }),
    ]);
    expect(second.getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({ code: "SAME_TAB_FAILURE", count: 2 }),
    ]);
  });

  it("does not let a stale module resurrect entries after another module clears them", async () => {
    localStorage.clear();
    vi.resetModules();
    const clearingModule = await import("../../src/services/client-diagnostics");
    clearingModule.recordClientDiagnostic({ code: "DELETED", message: "old", source: "global" });
    vi.resetModules();
    const staleModule = await import("../../src/services/client-diagnostics");
    staleModule.getClientDiagnosticSnapshot();

    expect(clearingModule.clearClientDiagnostics()).toBe(true);
    staleModule.recordClientDiagnostic({ code: "AFTER_CLEAR", message: "new", source: "global" });

    expect(staleModule.getClientDiagnosticSnapshot().entries.map((entry) => entry.code)).toEqual([
      "AFTER_CLEAR",
    ]);
  });

  it("preserves a new-generation event when stale-generation cleanup resumes", async () => {
    localStorage.clear();
    vi.resetModules();
    const staleModule = await import("../../src/services/client-diagnostics");
    staleModule.recordClientDiagnostic({ code: "OLD_GENERATION", message: "old", source: "global" });
    vi.resetModules();
    const clearingModule = await import("../../src/services/client-diagnostics");

    const nativeGetItem = Storage.prototype.getItem;
    let switchedGeneration = false;
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      const value = nativeGetItem.call(this, key);
      if (!switchedGeneration && key.includes(":event:")) {
        switchedGeneration = true;
        clearingModule.clearClientDiagnostics();
        clearingModule.recordClientDiagnostic({ code: "NEW_GENERATION", message: "new", source: "global" });
      }
      return value;
    });

    staleModule.recordClientDiagnostic({ code: "STALE_WRITE", message: "stale", source: "global" });
    getItem.mockRestore();

    expect(clearingModule.getClientDiagnosticSnapshot().entries.map((entry) => entry.code)).toContain("NEW_GENERATION");
  });

  it("uses non-colliding generations without randomUUID across independent modules", async () => {
    const randomUuid = Object.getOwnPropertyDescriptor(Crypto.prototype, "randomUUID");
    Object.defineProperty(Crypto.prototype, "randomUUID", { configurable: true, value: undefined });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    try {
      localStorage.clear();
      vi.resetModules();
      const first = await import("../../src/services/client-diagnostics");
      first.clearClientDiagnostics();
      const firstManifest = localStorage.getItem("tarkov-helper:client-diagnostics:v1");
      vi.resetModules();
      const second = await import("../../src/services/client-diagnostics");
      second.clearClientDiagnostics();
      const secondManifest = localStorage.getItem("tarkov-helper:client-diagnostics:v1");

      expect(firstManifest).not.toBe(secondManifest);
    } finally {
      vi.useRealTimers();
      if (randomUuid) Object.defineProperty(Crypto.prototype, "randomUUID", randomUuid);
      else delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
    }
  });

  it("keeps visible entries when persistent deletion fails instead of pretending they were cleared", () => {
    recordClientDiagnostic({ code: "STILL_PRESENT", message: "failure", source: "global" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    expect(clearClientDiagnostics()).toBe(false);
    expect(getClientDiagnosticSnapshot()).toMatchObject({
      persistence: "localStorage",
      entries: [expect.objectContaining({ code: "STILL_PRESENT" })],
    });
  });

  it("does not pretend to clear when browser storage is inaccessible", () => {
    recordClientDiagnostic({ code: "INACCESSIBLE_CLEAR", message: "failure", source: "global" });
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage blocked", "SecurityError"); },
    });
    try {
      expect(clearClientDiagnostics()).toBe(false);
      expect(getClientDiagnosticSnapshot().entries).toEqual([
        expect.objectContaining({ code: "INACCESSIBLE_CLEAR" }),
      ]);
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    }
    expect(getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({ code: "INACCESSIBLE_CLEAR" }),
    ]);
  });

  it("keeps a logical clear successful when obsolete event cleanup is blocked", () => {
    recordClientDiagnostic({ code: "TO_CLEAR", message: "old", source: "global" });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("File locked", "InvalidStateError");
    });

    expect(clearClientDiagnostics()).toBe(true);
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });

  it("keeps a committed clear successful when diagnostic-key enumeration is blocked", () => {
    recordClientDiagnostic({ code: "ENUMERATION_CLEAR", message: "old", source: "global" });
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    expect(clearClientDiagnostics()).toBe(true);
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });

  it("removes malformed diagnostic event keys during a logical clear", () => {
    const malformedKey = "tarkov-helper:client-diagnostics:v1:event:legacy:raw";
    localStorage.setItem(malformedKey, "private raw legacy content");
    expect(clearClientDiagnostics()).toBe(true);
    expect(localStorage.getItem(malformedKey)).toBeNull();
  });

  it("records unhandled string rejections without cancelling browser handling", () => {
    const stop = installGlobalDiagnosticHandlers(window);
    const event = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(event, "reason", { value: "promise failed" });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(getClientDiagnosticSnapshot().entries[0]).toMatchObject({
      code: "UNHANDLED_REJECTION",
      message: "promise failed",
      source: "global",
    });
    stop();
  });
});
