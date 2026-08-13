import { exportClientDiagnostics } from "./client-diagnostics";

/** Starts a local JSON download without allowing diagnostics failures to escape. */
export function downloadClientDiagnostics(): boolean {
  let objectUrl: string | null = null;
  let link: HTMLAnchorElement | null = null;
  try {
    const blob = new Blob([exportClientDiagnostics()], { type: "application/json;charset=utf-8" });
    objectUrl = URL.createObjectURL(blob);
    link = document.createElement("a");
    link.href = objectUrl;
    link.download = `tarkov-helper-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    return true;
  } catch {
    return false;
  } finally {
    try {
      link?.remove();
    } catch {
      // Cleanup is best-effort and must not break the recovery screen.
    }
    if (objectUrl !== null) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Cleanup is best-effort and must not break the recovery screen.
      }
    }
  }
}
