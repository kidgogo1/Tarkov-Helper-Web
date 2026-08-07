import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");
const syntheticLockDirectory = path.join(
  os.tmpdir(),
  "tarkov-helper-native-overlay-synthetic.lock",
);

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireSyntheticBrowserLock(timeoutMs = 60_000) {
  const ownerPath = path.join(syntheticLockDirectory, "owner.json");
  const ownerToken = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let invalidOwnerObservedAt = null;
  let invalidOwnerKey = null;

  while (Date.now() < deadline) {
    let createdDirectory = false;
    try {
      await mkdir(syntheticLockDirectory);
      createdDirectory = true;
      await writeFile(
        ownerPath,
        JSON.stringify({ processId: process.pid, ownerToken }),
        "utf8",
      );
      return async () => {
        const releaseDeadline = Date.now() + 5_000;
        let lastReleaseError = null;
        while (Date.now() < releaseDeadline) {
          try {
            const owner = JSON.parse(await readFile(ownerPath, "utf8"));
            if (owner.processId !== process.pid || owner.ownerToken !== ownerToken) return;
            await rm(syntheticLockDirectory, { recursive: true, force: true });
            return;
          } catch (error) {
            if (error?.code === "ENOENT") return;
            lastReleaseError = error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Failed to release the synthetic browser test lock.", {
          cause: lastReleaseError,
        });
      };
    } catch (error) {
      if (createdDirectory) {
        await rm(syntheticLockDirectory, { recursive: true, force: true }).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
    }

    let owner = null;
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
    } catch {
      // The winner may still be writing owner.json. Allow a bounded grace period.
    }
    if (
      Number.isInteger(owner?.processId) &&
      owner.processId > 0 &&
      isProcessAlive(owner.processId)
    ) {
      invalidOwnerObservedAt = null;
      invalidOwnerKey = null;
    } else {
      const observedKey = `${owner?.processId ?? "invalid"}:${owner?.ownerToken ?? "invalid"}`;
      if (invalidOwnerKey !== observedKey) {
        invalidOwnerKey = observedKey;
        invalidOwnerObservedAt = Date.now();
      }
      if (Date.now() - invalidOwnerObservedAt >= 2_000) {
        let latestOwner = null;
        try {
          latestOwner = JSON.parse(await readFile(ownerPath, "utf8"));
        } catch {
          // A missing/partial owner remains stale only if no live owner appeared.
        }
        const latestKey = `${latestOwner?.processId ?? "invalid"}:${latestOwner?.ownerToken ?? "invalid"}`;
        if (
          latestKey === invalidOwnerKey &&
          (!Number.isInteger(latestOwner?.processId) ||
            latestOwner.processId <= 0 ||
            !isProcessAlive(latestOwner.processId))
        ) {
          await rm(syntheticLockDirectory, { recursive: true, force: true });
        }
        invalidOwnerObservedAt = null;
        invalidOwnerKey = null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for the synthetic browser test lock.");
}

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for launcher URL.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:(\d+)\/)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ url: match[1], port: Number(match[2]) });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Launcher exited before startup with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

async function startServer(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-native-overlay-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await writeFile(
    path.join(appRoot, "index.html"),
    "<!doctype html><title>Tarkov Helper Web</title><main>overlay test</main>",
    "utf8",
  );

  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Action",
      "Serve",
      "-Root",
      appRoot,
      "-Port",
      "0",
      "-NoBrowser",
      "-StateDirectory",
      stateDirectory,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const location = await waitForUrl(child);
  await waitFor(async () => {
    try {
      const response = await fetch(new URL(".tarkov-helper-portable", location.url));
      await response.arrayBuffer();
      return response.status === 200;
    } catch {
      return false;
    }
  }, 5_000, "Timed out waiting for the portable overlay API.");
  return { child, temporaryRoot, ...location };
}

function mutationHeaders(url, token) {
  return {
    "content-type": "application/json",
    origin: new URL(url).origin,
    "x-tarkov-overlay": token,
  };
}

async function fetchAndDiscard(input, init) {
  const response = await fetch(input, init);
  await response.arrayBuffer();
  return response;
}

async function waitFor(
  check,
  timeoutMs = 10_000,
  timeoutMessage = "Timed out waiting for synthetic Win32 state.",
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(timeoutMessage);
}

async function compileSyntheticBrowser(temporaryRoot) {
  const sourcePath = path.join(temporaryRoot, "SyntheticBrowser.cs");
  const compilePath = path.join(temporaryRoot, "compile.ps1");
  const executablePath = path.join(temporaryRoot, "msedge.exe");
  await writeFile(sourcePath, String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SyntheticBrowser {
    private delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass {
        public uint style;
        public WindowProcedure procedure;
        public int classExtra;
        public int windowExtra;
        public IntPtr instance;
        public IntPtr icon;
        public IntPtr cursor;
        public IntPtr background;
        public string menuName;
        public string className;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr window;
        public uint value;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct StyleStruct { public uint styleOld, styleNew; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClass(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowEx(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    private static readonly WindowProcedure Procedure = HandleMessage;
    private static readonly List<IntPtr> PipWindows = new List<IntPtr>();
    private static IntPtr MainWindow;
    private static bool SabotageNextStyleChange;
    private static bool RejectNextExStyleChange;

    private static IntPtr HandleMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam) {
        if (message == 0x007C && RejectNextExStyleChange && wParam.ToInt64() == -20) {
            RejectNextExStyleChange = false;
            StyleStruct styles = (StyleStruct)Marshal.PtrToStructure(lParam, typeof(StyleStruct));
            styles.styleNew = styles.styleOld;
            Marshal.StructureToPtr(styles, lParam, false);
        }
        if (message == 0x007D && SabotageNextStyleChange && window != MainWindow) {
            SabotageNextStyleChange = false;
            PipWindows.Remove(window);
            DestroyWindow(window);
        }
        return DefWindowProc(window, message, wParam, lParam);
    }

    private static IntPtr Create(string title, uint style, uint exStyle, int offset) {
        IntPtr window = CreateWindowEx(exStyle, "Chrome_WidgetWin_1", title, style, -30000 + offset, -30000 + offset, 420, 360, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        ShowWindow(window, 5);
        return window;
    }

    private static string WindowJson(IntPtr window) {
        Rect rect;
        GetWindowRect(window, out rect);
        return "{\"handle\":" + window.ToInt64() +
            ",\"style\":" + unchecked((uint)GetWindowLong(window, -16)) +
            ",\"exStyle\":" + unchecked((uint)GetWindowLong(window, -20)) +
            ",\"left\":" + rect.left + ",\"top\":" + rect.top +
            ",\"width\":" + (rect.right - rect.left) + ",\"height\":" + (rect.bottom - rect.top) + "}";
    }

    private static void WriteStatus(string statusPath) {
        var json = new StringBuilder();
        json.Append("{\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
        json.Append(",\"sabotage\":").Append(SabotageNextStyleChange ? "true" : "false");
        json.Append(",\"rejectExStyle\":").Append(RejectNextExStyleChange ? "true" : "false");
        json.Append(",\"main\":").Append(WindowJson(MainWindow));
        json.Append(",\"pips\":[");
        for (int index = 0; index < PipWindows.Count; index++) {
            if (index > 0) json.Append(',');
            json.Append(WindowJson(PipWindows[index]));
        }
        json.Append("]}");
        File.WriteAllText(statusPath, json.ToString(), new UTF8Encoding(false));
    }

    public static int Main(string[] args) {
        var windowClass = new WindowClass {
            procedure = Procedure,
            instance = GetModuleHandle(null),
            className = "Chrome_WidgetWin_1"
        };
        if (RegisterClass(ref windowClass) == 0) return 2;
        MainWindow = Create("Synthetic Edge Main", 0x16CF0000u, 0x00200100u, 0);
        if (MainWindow == IntPtr.Zero) return 3;

        string lastCommand = "";
        bool running = true;
        while (running) {
            Message message;
            while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            try {
                string command = File.Exists(args[0]) ? File.ReadAllText(args[0]) : "";
                if (command != lastCommand) {
                    lastCommand = command;
                    string[] parts = command.Split(':');
                    if (parts.Length >= 2 && parts[1] == "CREATE") {
                        int count = int.Parse(parts[2]);
                        for (int index = 0; index < count; index++) {
                            PipWindows.Add(Create("Tarkov Helper Web", 0x16CC0000u, 0x00200108u, 100 + PipWindows.Count * 10));
                        }
                    } else if (parts.Length >= 2 && parts[1] == "CLOSE") {
                        foreach (IntPtr window in PipWindows) DestroyWindow(window);
                        PipWindows.Clear();
                    } else if (parts.Length >= 2 && parts[1] == "SABOTAGE") {
                        SabotageNextStyleChange = true;
                    } else if (parts.Length >= 2 && parts[1] == "REJECT_EXSTYLE") {
                        RejectNextExStyleChange = true;
                    } else if (parts.Length >= 2 && parts[1] == "EXIT") {
                        running = false;
                    }
                }
                WriteStatus(args[1]);
            } catch { }
            Thread.Sleep(40);
        }
        foreach (IntPtr window in PipWindows) DestroyWindow(window);
        DestroyWindow(MainWindow);
        return 0;
    }
}
`, "utf8");
  await writeFile(
    compilePath,
    `$source = Get-Content -LiteralPath '${sourcePath.replaceAll("'", "''")}' -Raw\n` +
      `Add-Type -TypeDefinition $source -OutputAssembly '${executablePath.replaceAll("'", "''")}' -OutputType ConsoleApplication\n`,
    "utf8",
  );
  const compiled = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", compilePath],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  return executablePath;
}

async function readSyntheticStatus(statusPath) {
  try {
    return JSON.parse(await readFile(statusPath, "utf8"));
  } catch {
    return null;
  }
}

test("native overlay API is same-origin, token authenticated, and fail-closed", { skip: process.platform !== "win32" }, async (t) => {
  const { url } = await startServer(t);

  const sessionResponse = await fetch(new URL("api/v1/native-overlay/session", url));
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get("access-control-allow-origin"), null);
  const session = await sessionResponse.json();
  assert.deepEqual(Object.keys(session).sort(), [
    "capability",
    "protocolVersion",
    "sizeLimits",
    "token",
    "windowTitle",
  ]);
  assert.equal(session.protocolVersion, 1);
  assert.equal(session.capability, "WINDOWS_DOCUMENT_PIP");
  assert.match(session.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(session.windowTitle, "Tarkov Helper Web");
  assert.deepEqual(session.sizeLimits, {
    minWidth: 240,
    minHeight: 240,
    maxWidth: 1000,
    maxHeight: 1000,
  });

  // Authentication probes stay bodyless: the server intentionally rejects them
  // before parsing a payload, so there must be no unread request bytes at close.
  const missingOrigin = await fetchAndDiscard(new URL("api/v1/native-overlay/claims", url), {
    method: "POST",
    headers: {
      "x-tarkov-overlay": session.token,
    },
  });
  assert.equal(missingOrigin.status, 403);

  const wrongToken = await fetchAndDiscard(new URL("api/v1/native-overlay/claims", url), {
    method: "POST",
    headers: {
      origin: new URL(url).origin,
      "x-tarkov-overlay": "A".repeat(43),
    },
  });
  assert.equal(wrongToken.status, 403);

  const unknownField = await fetch(new URL("api/v1/native-overlay/claims", url), {
    method: "POST",
    headers: mutationHeaders(url, session.token),
    body: JSON.stringify({ hwnd: 1234 }),
  });
  const unknownFieldBody = await unknownField.text();
  assert.equal(unknownField.status, 422, unknownFieldBody);

  const beginResponse = await fetch(new URL("api/v1/native-overlay/claims", url), {
    method: "POST",
    headers: mutationHeaders(url, session.token),
    body: "{}",
  });
  const beginResponseBody = await beginResponse.text();
  assert.equal(beginResponse.status, 201, beginResponseBody);
  const claim = JSON.parse(beginResponseBody);
  assert.deepEqual(Object.keys(claim).sort(), ["claimId", "expiresAt", "protocolVersion"]);
  assert.match(claim.claimId, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(Number.isNaN(Date.parse(claim.expiresAt)), false);

  const invalidTitle = await fetchAndDiscard(new URL("api/v1/native-overlay/minimap", url), {
    method: "POST",
    headers: mutationHeaders(url, session.token),
    body: JSON.stringify({
      claimId: claim.claimId,
      windowTitle: "Calculator",
    }),
  });
  assert.equal(invalidTitle.status, 422);

  const invalidBounds = await fetchAndDiscard(new URL("api/v1/native-overlay/minimap", url), {
    method: "PATCH",
    headers: mutationHeaders(url, session.token),
    body: JSON.stringify({
      overlayId: "Y".repeat(43),
      width: 239,
      height: 420.5,
      mode: "CLICK_THROUGH",
    }),
  });
  assert.equal(invalidBounds.status, 422);

  const invalidMode = await fetchAndDiscard(new URL("api/v1/native-overlay/minimap", url), {
    method: "PATCH",
    headers: mutationHeaders(url, session.token),
    body: JSON.stringify({
      overlayId: "Y".repeat(43),
      mode: "TRANSPARENT_OR_WHATEVER",
    }),
  });
  assert.equal(invalidMode.status, 422);

  const lowercaseMode = await fetchAndDiscard(new URL("api/v1/native-overlay/minimap", url), {
    method: "PATCH",
    headers: mutationHeaders(url, session.token),
    body: JSON.stringify({
      overlayId: "Y".repeat(43),
      mode: "locked",
    }),
  });
  assert.equal(lowercaseMode.status, 422);

  const fabricatedClaim = await fetchAndDiscard(new URL("api/v1/native-overlay/minimap", url), {
    method: "POST",
    headers: mutationHeaders(url, session.token),
    body: JSON.stringify({
      claimId: "Z".repeat(43),
      windowTitle: "Tarkov Helper Web",
    }),
  });
  assert.equal(fabricatedClaim.status, 404);
});

test("native overlay claims only a unique new synthetic browser PiP and restores its Win32 state", { skip: process.platform !== "win32" }, async (t) => {
  const { child: serverChild, url, temporaryRoot } = await startServer(t);
  const syntheticRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-synthetic-browser-"));
  const executablePath = await compileSyntheticBrowser(syntheticRoot);
  const controlPath = path.join(syntheticRoot, "synthetic-control.txt");
  const statusPath = path.join(syntheticRoot, "synthetic-status.json");
  const releaseSyntheticBrowserLock = await acquireSyntheticBrowserLock();
  let syntheticBrowser;
  try {
    syntheticBrowser = spawn(executablePath, [controlPath, statusPath], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    await releaseSyntheticBrowserLock();
    throw error;
  }
  t.after(async () => {
    try {
      if (syntheticBrowser.exitCode === null) {
        syntheticBrowser.kill();
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2_000);
          syntheticBrowser.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await rm(syntheticRoot, { recursive: true, force: true });
    } finally {
      await releaseSyntheticBrowserLock();
    }
  });

  let sequence = 0;
  async function command(action, count = 0) {
    sequence += 1;
    await writeFile(controlPath, `${sequence}:${action}:${count}`, "utf8");
  }
  async function statusWhere(predicate) {
    return waitFor(async () => {
      const status = await readSyntheticStatus(statusPath);
      return status && predicate(status) ? status : null;
    });
  }
  async function nativeRequest(method, pathname, token, body) {
    const response = await fetch(new URL(pathname, url), {
      method,
      headers: mutationHeaders(url, token),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  }

  const initialStatus = await statusWhere((status) => status.pips.length === 0);
  assert(initialStatus.main.left < -20_000, "Synthetic test window must remain off all monitors");
  const session = await (await fetch(new URL("api/v1/native-overlay/session", url))).json();

  const begin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  await command("CREATE", 1);
  const created = await statusWhere((status) => status.pips.length === 1);
  const original = { ...created.pips[0] };
  assert(original.left < -20_000, "Synthetic PiP must remain off all monitors");

  const complete = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: begin.body.claimId,
    windowTitle: session.windowTitle,
  });
  const serverLog = await readFile(path.join(temporaryRoot, "state", "server.log"), "utf8");
  assert.equal(complete.status, 201, `${JSON.stringify(complete.body)}\n${serverLog}`);
  assert.equal(complete.body.mode, "UNLOCKED");

  await command("REJECT_EXSTYLE");
  await statusWhere((status) => status.rejectExStyle === true);
  const rejectedLock = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "LOCKED",
  });
  assert.equal(rejectedLock.status, 500, JSON.stringify(rejectedLock.body));
  const rolledBack = await statusWhere((status) =>
    status.rejectExStyle === false &&
    status.pips[0].style === original.style &&
    status.pips[0].exStyle === original.exStyle &&
    status.pips[0].width === original.width &&
    status.pips[0].height === original.height,
  );
  assert.equal(rolledBack.pips[0].left, original.left);
  assert.equal(rolledBack.pips[0].top, original.top);

  const locked = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "LOCKED",
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));
  const lockedStatus = await statusWhere((status) =>
    (status.pips[0].style & 0x00cf0000) === 0 &&
    (status.pips[0].exStyle & 0x08000008) === 0x08000008,
  );
  assert.equal(lockedStatus.pips[0].exStyle & 0x00080020, 0);
  assert.deepEqual(locked.body.bounds, {
    left: original.left,
    top: original.top,
    width: original.width,
    height: original.height,
  });

  await command("REJECT_EXSTYLE");
  await statusWhere((status) => status.rejectExStyle === true);
  const rejectedResize = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "CLICK_THROUGH",
    width: 300,
    height: 300,
  });
  assert.equal(rejectedResize.status, 500, JSON.stringify(rejectedResize.body));
  await statusWhere((status) =>
    status.rejectExStyle === false &&
    (status.pips[0].style & 0x00cf0000) === 0 &&
    (status.pips[0].exStyle & 0x08080028) === 0x08000008 &&
    status.pips[0].width === original.width &&
    status.pips[0].height === original.height,
  );

  const clickThrough = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "CLICK_THROUGH",
  });
  assert.equal(clickThrough.status, 200, JSON.stringify(clickThrough.body));
  assert.deepEqual(clickThrough.body.bounds, {
    left: original.left,
    top: original.top,
    width: original.width,
    height: original.height,
  });
  await statusWhere((status) =>
    (status.pips[0].exStyle & 0x08080028) === 0x08080028,
  );

  const interactiveAgain = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "LOCKED",
    width: 360,
    height: 360,
  });
  assert.equal(interactiveAgain.status, 200, JSON.stringify(interactiveAgain.body));
  const resizedStatus = await statusWhere((status) =>
    status.pips[0].width === 360 && status.pips[0].height === 360,
  );
  assert.equal(resizedStatus.pips[0].exStyle & 0x00080020, 0);

  const unlocked = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "UNLOCKED",
  });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
  assert.deepEqual(unlocked.body.bounds, {
    left: original.left,
    top: original.top,
    width: 360,
    height: 360,
  });
  const restored = await statusWhere((status) =>
    status.pips[0].style === original.style &&
    status.pips[0].exStyle === original.exStyle &&
    status.pips[0].width === 360 &&
    status.pips[0].height === 360,
  );
  assert.equal(restored.pips[0].left, original.left);
  assert.equal(restored.pips[0].top, original.top);

  const relockedForRestoreFailure = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "CLICK_THROUGH",
  });
  assert.equal(relockedForRestoreFailure.status, 200, JSON.stringify(relockedForRestoreFailure.body));
  assert.deepEqual(relockedForRestoreFailure.body.bounds, {
    left: original.left,
    top: original.top,
    width: 360,
    height: 360,
  });
  await command("SABOTAGE");
  await statusWhere((status) => status.sabotage === true);
  const failedDetach = await nativeRequest("DELETE", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
  });
  assert.equal(failedDetach.status, 500, JSON.stringify(failedDetach.body));
  const detached = await nativeRequest("DELETE", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
  });
  assert.equal(detached.status, 204, JSON.stringify(detached.body));

  await statusWhere((status) => status.pips.length === 0);
  const liveBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  await statusWhere((status) => status.pips.length === 1);
  const liveComplete = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: liveBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(liveComplete.status, 201, JSON.stringify(liveComplete.body));

  const conflictBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  await statusWhere((status) => status.pips.length === 2);
  const liveConflict = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: conflictBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(liveConflict.status, 409);
  assert.equal(liveConflict.body.error.code, "OVERLAY_ALREADY_ATTACHED");

  await command("CLOSE");
  await statusWhere((status) => status.pips.length === 0);
  const staleBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  await statusWhere((status) => status.pips.length === 1);
  const staleRecovered = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: staleBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(staleRecovered.status, 201, JSON.stringify(staleRecovered.body));
  await nativeRequest("DELETE", "api/v1/native-overlay/minimap", session.token, {
    overlayId: staleRecovered.body.overlayId,
  });

  await command("CLOSE");
  await statusWhere((status) => status.pips.length === 0);
  const ambiguousBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 2);
  const ambiguousOriginal = await statusWhere((status) => status.pips.length === 2);
  const ambiguous = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: ambiguousBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.error.code, "AMBIGUOUS_WINDOW");
  const ambiguousAfter = await statusWhere((status) => status.pips.length === 2);
  assert.deepEqual(
    ambiguousAfter.pips.map(({ style, exStyle }) => ({ style, exStyle })),
    ambiguousOriginal.pips.map(({ style, exStyle }) => ({ style, exStyle })),
  );

  await command("CLOSE");
  await statusWhere((status) => status.pips.length === 0);
  const shutdownBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  const shutdownOriginal = await statusWhere((status) => status.pips.length === 1);
  const shutdownAttached = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: shutdownBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  const shutdownClickThrough = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: shutdownAttached.body.overlayId,
    mode: "CLICK_THROUGH",
  });
  assert.equal(shutdownClickThrough.status, 200, JSON.stringify(shutdownClickThrough.body));
  await statusWhere((status) => (status.pips[0].exStyle & 0x00080020) === 0x00080020);

  const instance = JSON.parse(await readFile(path.join(temporaryRoot, "state", "instance.json"), "utf8"));
  const shutdownResponse = await fetch(new URL("api/v1/control/shutdown", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
      "x-tarkov-control": instance.controlToken,
    },
    body: "{}",
  });
  assert.equal(shutdownResponse.status, 204);
  await new Promise((resolve, reject) => {
    if (serverChild.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Server did not exit after authenticated shutdown.")), 5_000);
    serverChild.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const shutdownRestored = await statusWhere((status) =>
    status.pips.length === 1 &&
    status.pips[0].style === shutdownOriginal.pips[0].style &&
    status.pips[0].exStyle === shutdownOriginal.pips[0].exStyle &&
    status.pips[0].width === shutdownOriginal.pips[0].width &&
    status.pips[0].height === shutdownOriginal.pips[0].height,
  );
  assert.equal(shutdownRestored.pips[0].left, shutdownOriginal.pips[0].left);
  assert.equal(shutdownRestored.pips[0].top, shutdownOriginal.pips[0].top);

  await command("EXIT");
});
