import { beforeEach, describe, expect, it, vi } from "vitest";

import { downloadClientDiagnostics } from "../../src/services/client-diagnostic-download";
import { clearClientDiagnostics, recordClientDiagnostic } from "../../src/services/client-diagnostics";

describe("client diagnostic download", () => {
  beforeEach(() => {
    localStorage.clear();
    clearClientDiagnostics();
    recordClientDiagnostic({ code: "DOWNLOAD", message: "failure", source: "global" });
  });

  it("never throws when object URL cleanup fails", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:diagnostics") });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(() => {
        throw new Error("revoke blocked");
      }),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    expect(() => downloadClientDiagnostics()).not.toThrow();

    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  });
});
