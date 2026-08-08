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

function nativeEventHeaders(token, extra = {}) {
  return {
    "x-tarkov-overlay": token,
    ...extra,
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

function scaleAwayFromZero(value) {
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}

function pixelsToDips(value, dpi) {
  return scaleAwayFromZero((value * 96) / dpi);
}

function screenPointToDips(value, monitorOrigin, dpi) {
  return monitorOrigin + pixelsToDips(value - monitorOrigin, dpi);
}

function dipsToPixels(value, dpi) {
  return scaleAwayFromZero((value * dpi) / 96);
}

test("native overlay recomputes requested DIP bounds after a DPI transition", { skip: process.platform !== "win32" }, async (t) => {
  const launcherSource = await readFile(launcherPath, "utf8");
  const bridgeSource = launcherSource.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert(bridgeSource, "Expected the native overlay C# bridge in launcher.ps1");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-native-dpi-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, "NativeOverlayBridge.cs");
  const probePath = path.join(temporaryRoot, "probe.ps1");
  await writeFile(sourcePath, bridgeSource, "utf8");
  await writeFile(
    probePath,
    String.raw`$source = Get-Content -Raw -LiteralPath $args[0]
Add-Type -TypeDefinition $source
$result = [ordered]@{
    at100 = [TarkovHelper.NativeOverlayBridge]::DipsToPixelsAtDpi(300, 96)
    at200 = [TarkovHelper.NativeOverlayBridge]::DipsToPixelsAtDpi(300, 192)
    backToDips = [TarkovHelper.NativeOverlayBridge]::PixelsToDipsAtDpi(600, 192)
}
$result | ConvertTo-Json -Compress`,
    "utf8",
  );

  const probe = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probePath, sourcePath],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), {
    at100: 300,
    at200: 600,
    backToDips: 300,
  });

  assert.match(
    launcherSource,
    /::ApplyCroppedDips\([\s\S]*?\$nextBoundsDip\.width,[\s\S]*?\$nextBoundsDip\.height[\s\S]*?\)/,
    "The live PowerShell path must pass requested DIPs into the bounded native reconvergence loop",
  );
});

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
        public uint privateValue;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo {
        public NativePoint reserved;
        public NativePoint maximumSize;
        public NativePoint maximumPosition;
        public NativePoint minimumTrackSize;
        public NativePoint maximumTrackSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo {
        public int size;
        public Rect monitor;
        public Rect work;
        public uint flags;
    }
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
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo information);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern int GetWindowRgn(IntPtr window, IntPtr region);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
    [DllImport("gdi32.dll")] private static extern int GetRgnBox(IntPtr region, out Rect rect);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll")] private static extern bool Thread32First(IntPtr snapshot, ref ThreadEntry entry);
    [DllImport("kernel32.dll")] private static extern bool Thread32Next(IntPtr snapshot, ref ThreadEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr window, int identifier, uint modifiers, uint virtualKey);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int identifier);

    [StructLayout(LayoutKind.Sequential)]
    private struct ThreadEntry {
        public uint size;
        public uint usage;
        public uint threadId;
        public uint ownerProcessId;
        public int basePriority;
        public int deltaPriority;
        public uint flags;
    }

    private static readonly WindowProcedure Procedure = HandleMessage;
    private static readonly List<IntPtr> PipWindows = new List<IntPtr>();
    private static readonly Dictionary<IntPtr, IntPtr> RenderWindows = new Dictionary<IntPtr, IntPtr>();
    private static readonly List<IntPtr> ExtraRenderWindows = new List<IntPtr>();
    private static IntPtr MainWindow;
    private static bool SabotageNextStyleChange;
    private static bool RejectNextExStyleChange;
    private static bool HotKeyBlocked;
    private static bool HotKeyProbeAvailable;

    private static bool RegisterTestHotKey(int identifier, uint modifiers, uint virtualKey) {
        return RegisterHotKey(IntPtr.Zero, identifier, modifiers | 0x4000u, virtualKey);
    }

    private static void BlockHotKey() {
        if (!HotKeyBlocked) HotKeyBlocked = RegisterTestHotKey(0x6601, 0x0001u | 0x0004u, 0xBBu);
    }

    private static void UnblockHotKey() {
        if (HotKeyBlocked) UnregisterHotKey(IntPtr.Zero, 0x6601);
        HotKeyBlocked = false;
    }

    private static void ProbeHotKeys() {
        var registered = new List<int>();
        if (RegisterTestHotKey(0x6611, 0x0001u | 0x0004u, 0xBBu)) registered.Add(0x6611);
        if (RegisterTestHotKey(0x6612, 0x0001u, 0x6Bu)) registered.Add(0x6612);
        if (RegisterTestHotKey(0x6613, 0x0001u, 0xBDu)) registered.Add(0x6613);
        if (RegisterTestHotKey(0x6614, 0x0001u, 0x6Du)) registered.Add(0x6614);
        HotKeyProbeAvailable = registered.Count == 4;
        foreach (int identifier in registered) UnregisterHotKey(IntPtr.Zero, identifier);
    }

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
        if (message == 0x0005 && RenderWindows.ContainsKey(window)) {
            int clientWidth = unchecked((ushort)(lParam.ToInt64() & 0xffff));
            int clientHeight = unchecked((ushort)((lParam.ToInt64() >> 16) & 0xffff));
            MoveWindow(RenderWindows[window], 7, 63, Math.Max(1, clientWidth - 14), Math.Max(1, clientHeight - 70), true);
        }
        if (message == 0x0024 && window != MainWindow && (unchecked((uint)GetWindowLong(window, -16)) & 0x00CF0000u) != 0) {
            MinMaxInfo limits = (MinMaxInfo)Marshal.PtrToStructure(lParam, typeof(MinMaxInfo));
            limits.minimumTrackSize.x = 800;
            limits.minimumTrackSize.y = 540;
            Marshal.StructureToPtr(limits, lParam, false);
            return IntPtr.Zero;
        }
        return DefWindowProc(window, message, wParam, lParam);
    }

    private static IntPtr Create(string title, uint style, uint exStyle, int offset) {
        IntPtr window = CreateWindowEx(exStyle, "Chrome_WidgetWin_1", title, style, -30000 + offset, -30000 + offset, 842, 607, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        ShowWindow(window, 5);
        return window;
    }

    private static IntPtr CreatePip(int offset) {
        IntPtr window = Create("Tarkov Helper Web", 0x16CC0000u, 0x00200108u, offset);
        Rect client;
        GetClientRect(window, out client);
        IntPtr renderer = CreateWindowEx(0, "Chrome_RenderWidgetHostHWND", "", 0x50000000u, 7, 63, Math.Max(1, client.right - 14), Math.Max(1, client.bottom - 70), window, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        ShowWindow(renderer, 5);
        IntPtr originalRegion = CreateRoundRectRgn(0, 0, 842, 607, 18, 18);
        if (SetWindowRgn(window, originalRegion, true) == 0) DeleteObject(originalRegion);
        RenderWindows[window] = renderer;
        return window;
    }

    private static void DuplicateRenderer() {
        if (PipWindows.Count != 1) return;
        IntPtr window = PipWindows[0];
        Rect client;
        GetClientRect(window, out client);
        IntPtr renderer = CreateWindowEx(0, "Chrome_RenderWidgetHostHWND", "", 0x50000000u, 7, 63, Math.Max(1, client.right - 14), Math.Max(1, client.bottom - 70), window, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        ShowWindow(renderer, 5);
        ExtraRenderWindows.Add(renderer);
    }

    private static void PostHotKey(int processId, int hotKeyId) {
        IntPtr snapshot = CreateToolhelp32Snapshot(0x00000004u, 0);
        if (snapshot == new IntPtr(-1)) return;
        try {
            var entry = new ThreadEntry { size = (uint)Marshal.SizeOf(typeof(ThreadEntry)) };
            if (!Thread32First(snapshot, ref entry)) return;
            do {
                if (entry.ownerProcessId == (uint)processId) {
                    PostThreadMessage(entry.threadId, 0x0312u, new IntPtr(hotKeyId), IntPtr.Zero);
                }
                entry.size = (uint)Marshal.SizeOf(typeof(ThreadEntry));
            } while (Thread32Next(snapshot, ref entry));
        } finally {
            CloseHandle(snapshot);
        }
    }

    private static string WindowJson(IntPtr window) {
        Rect rect;
        GetWindowRect(window, out rect);
        var monitor = new MonitorInfo { size = Marshal.SizeOf(typeof(MonitorInfo)) };
        GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor);
        Rect rendererRect;
        GetWindowRect(RenderWindows.ContainsKey(window) ? RenderWindows[window] : window, out rendererRect);
        IntPtr region = CreateRectRgn(0, 0, 0, 0);
        int regionType = GetWindowRgn(window, region);
        Rect regionBox;
        GetRgnBox(region, out regionBox);
        DeleteObject(region);
        return "{\"handle\":" + window.ToInt64() +
            ",\"dpi\":" + GetDpiForWindow(window) +
            ",\"monitor\":{\"left\":" + monitor.monitor.left + ",\"top\":" + monitor.monitor.top +
            ",\"width\":" + (monitor.monitor.right - monitor.monitor.left) +
            ",\"height\":" + (monitor.monitor.bottom - monitor.monitor.top) + "}" +
            ",\"style\":" + unchecked((uint)GetWindowLong(window, -16)) +
            ",\"exStyle\":" + unchecked((uint)GetWindowLong(window, -20)) +
            ",\"left\":" + rect.left + ",\"top\":" + rect.top +
            ",\"width\":" + (rect.right - rect.left) + ",\"height\":" + (rect.bottom - rect.top) +
            ",\"content\":{\"left\":" + rendererRect.left + ",\"top\":" + rendererRect.top +
            ",\"width\":" + (rendererRect.right - rendererRect.left) + ",\"height\":" + (rendererRect.bottom - rendererRect.top) + "}" +
            ",\"region\":{\"type\":" + regionType + ",\"left\":" + regionBox.left + ",\"top\":" + regionBox.top +
            ",\"width\":" + (regionBox.right - regionBox.left) + ",\"height\":" + (regionBox.bottom - regionBox.top) + "}}";
    }

    private static void WriteStatus(string statusPath) {
        var json = new StringBuilder();
        json.Append("{\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
        json.Append(",\"sabotage\":").Append(SabotageNextStyleChange ? "true" : "false");
        json.Append(",\"rejectExStyle\":").Append(RejectNextExStyleChange ? "true" : "false");
        json.Append(",\"extraRenderers\":").Append(ExtraRenderWindows.Count);
        json.Append(",\"hotKeyBlocked\":").Append(HotKeyBlocked ? "true" : "false");
        json.Append(",\"hotKeyProbeAvailable\":").Append(HotKeyProbeAvailable ? "true" : "false");
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
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) return 5;
        var windowClass = new WindowClass {
            procedure = Procedure,
            instance = GetModuleHandle(null),
            className = "Chrome_WidgetWin_1"
        };
        if (RegisterClass(ref windowClass) == 0) return 2;
        var renderClass = new WindowClass {
            procedure = Procedure,
            instance = GetModuleHandle(null),
            className = "Chrome_RenderWidgetHostHWND"
        };
        if (RegisterClass(ref renderClass) == 0) return 4;
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
                            PipWindows.Add(CreatePip(100 + PipWindows.Count * 10));
                        }
                    } else if (parts.Length >= 2 && parts[1] == "CLOSE") {
                        foreach (IntPtr window in PipWindows) DestroyWindow(window);
                        PipWindows.Clear();
                        RenderWindows.Clear();
                        ExtraRenderWindows.Clear();
                    } else if (parts.Length >= 2 && parts[1] == "DUPLICATE_RENDERER") {
                        DuplicateRenderer();
                    } else if (parts.Length >= 2 && parts[1] == "CLEAR_REGION" && PipWindows.Count == 1) {
                        SetWindowRgn(PipWindows[0], IntPtr.Zero, true);
                    } else if (parts.Length >= 6 && parts[1] == "MOVE" && PipWindows.Count == 1) {
                        MoveWindow(PipWindows[0], int.Parse(parts[2]), int.Parse(parts[3]), int.Parse(parts[4]), int.Parse(parts[5]), true);
                    } else if (parts.Length >= 2 && parts[1] == "BLOCK_HOTKEY") {
                        BlockHotKey();
                    } else if (parts.Length >= 2 && parts[1] == "UNBLOCK_HOTKEY") {
                        UnblockHotKey();
                    } else if (parts.Length >= 2 && parts[1] == "PROBE_HOTKEYS") {
                        ProbeHotKeys();
                    } else if (parts.Length >= 2 && parts[1] == "HOTKEY") {
                        PostHotKey(int.Parse(parts[2]), int.Parse(parts[3]));
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
        UnblockHotKey();
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

  const missingEventToken = await fetchAndDiscard(
    new URL("api/v1/native-overlay/events?after=0", url),
  );
  assert.equal(missingEventToken.status, 403);

  const crossSiteEventRead = await fetchAndDiscard(
    new URL("api/v1/native-overlay/events?after=0", url),
    {
      headers: nativeEventHeaders(session.token, {
        "sec-fetch-site": "cross-site",
      }),
    },
  );
  assert.equal(crossSiteEventRead.status, 403);

  const invalidEventCursor = await fetchAndDiscard(
    new URL("api/v1/native-overlay/events?after=-1", url),
    { headers: nativeEventHeaders(session.token) },
  );
  assert.equal(invalidEventCursor.status, 400);

  const emptyEventsResponse = await fetch(
    new URL("api/v1/native-overlay/events?after=0", url),
    { headers: nativeEventHeaders(session.token) },
  );
  assert.equal(emptyEventsResponse.status, 200);
  assert.deepEqual(await emptyEventsResponse.json(), {
    protocolVersion: 1,
    latestCursor: 0,
    events: [],
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
  async function command(action, ...values) {
    sequence += 1;
    await writeFile(controlPath, `${sequence}:${action}:${values.join(":")}`, "utf8");
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
  assert.equal(complete.body.globalHotkeysAvailable, true);
  assert.deepEqual(complete.body.bounds, {
    left: screenPointToDips(original.left, original.monitor.left, original.dpi),
    top: screenPointToDips(original.top, original.monitor.top, original.dpi),
    width: pixelsToDips(original.width, original.dpi),
    height: pixelsToDips(original.height, original.dpi),
  });
  assert.equal(
    complete.body.bounds.left - original.monitor.left,
    pixelsToDips(original.left - original.monitor.left, original.dpi),
  );
  assert.equal(
    complete.body.bounds.top - original.monitor.top,
    pixelsToDips(original.top - original.monitor.top, original.dpi),
  );
  assert(complete.body.bounds.left < original.monitor.left, "Negative offscreen X must stay on the same side of the monitor origin");
  assert(complete.body.bounds.top < original.monitor.top, "Negative offscreen Y must stay on the same side of the monitor origin");
  if (original.dpi > 96) {
    assert.notEqual(complete.body.bounds.left, original.left, "High-DPI absolute X must not remain an unscaled physical point");
    assert.notEqual(complete.body.bounds.top, original.top, "High-DPI absolute Y must not remain an unscaled physical point");
  }

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
    (status.pips[0].exStyle & 0x08000008) === 0x08000008 &&
    status.pips[0].region.type > 0,
  );
  assert.equal(lockedStatus.pips[0].exStyle & 0x00080020, 0x00080000);
  assert.deepEqual(locked.body.bounds, {
    left: screenPointToDips(original.left, original.monitor.left, original.dpi),
    top: screenPointToDips(original.top, original.monitor.top, original.dpi),
    width: pixelsToDips(original.content.width, original.dpi),
    height: pixelsToDips(original.content.height, original.dpi),
  });
  assert.deepEqual(lockedStatus.pips[0].region, {
    type: 2,
    left: original.left - lockedStatus.pips[0].left,
    top: original.top - lockedStatus.pips[0].top,
    width: original.content.width,
    height: original.content.height,
  });

  await command("HOTKEY", serverChild.pid, 0x54a1);
  const zoomInEvents = await waitFor(async () => {
    const response = await fetch(new URL("api/v1/native-overlay/events?after=0", url), {
      headers: nativeEventHeaders(session.token),
    });
    if (response.status !== 200) return null;
    const payload = await response.json();
    return payload.events.length > 0 ? payload : null;
  }, 5_000, "Timed out waiting for the native zoom-in hotkey event.");
  assert.deepEqual(zoomInEvents.events, [{ cursor: 1, action: "ZOOM_IN" }]);

  await command("HOTKEY", serverChild.pid, 0x54a4);
  const zoomOutEvents = await waitFor(async () => {
    const response = await fetch(new URL("api/v1/native-overlay/events?after=1", url), {
      headers: nativeEventHeaders(session.token),
    });
    if (response.status !== 200) return null;
    const payload = await response.json();
    return payload.events.length > 0 ? payload : null;
  }, 5_000, "Timed out waiting for the native zoom-out hotkey event.");
  assert.deepEqual(zoomOutEvents.events, [{ cursor: 2, action: "ZOOM_OUT" }]);

  await command("HOTKEY", serverChild.pid, 0x54a2);
  const numpadZoomInEvents = await waitFor(async () => {
    const response = await fetch(new URL("api/v1/native-overlay/events?after=2", url), {
      headers: nativeEventHeaders(session.token),
    });
    if (response.status !== 200) return null;
    const payload = await response.json();
    return payload.events.length > 0 ? payload : null;
  }, 5_000, "Timed out waiting for the numpad zoom-in hotkey event.");
  assert.deepEqual(numpadZoomInEvents.events, [{ cursor: 3, action: "ZOOM_IN" }]);

  await command("HOTKEY", serverChild.pid, 0x54a3);
  const mainRowZoomOutEvents = await waitFor(async () => {
    const response = await fetch(new URL("api/v1/native-overlay/events?after=3", url), {
      headers: nativeEventHeaders(session.token),
    });
    if (response.status !== 200) return null;
    const payload = await response.json();
    return payload.events.length > 0 ? payload : null;
  }, 5_000, "Timed out waiting for the main-row zoom-out hotkey event.");
  assert.deepEqual(mainRowZoomOutEvents.events, [{ cursor: 4, action: "ZOOM_OUT" }]);

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
    status.pips[0].style === lockedStatus.pips[0].style &&
    (status.pips[0].exStyle & 0x08080028) === 0x08080008 &&
    status.pips[0].region.width === lockedStatus.pips[0].region.width &&
    status.pips[0].region.height === lockedStatus.pips[0].region.height,
  );

  const clickThrough = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "CLICK_THROUGH",
    width: 300,
    height: 300,
  });
  assert.equal(clickThrough.status, 200, JSON.stringify(clickThrough.body));
  assert.deepEqual(clickThrough.body.bounds, {
    left: locked.body.bounds.left,
    top: locked.body.bounds.top,
    width: 300,
    height: 300,
  });
  const requestedPixels = dipsToPixels(300, original.dpi);
  const clickThroughStatus = await statusWhere((status) =>
    (status.pips[0].exStyle & 0x08080028) === 0x08080028 &&
    status.pips[0].region.width === requestedPixels &&
    status.pips[0].region.height === requestedPixels,
  );
  if (original.dpi === 192) {
    assert.equal(clickThroughStatus.pips[0].region.width, 600);
    assert.equal(clickThroughStatus.pips[0].region.height, 600);
  }

  const interactiveAgain = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "LOCKED",
    width: 360,
    height: 360,
  });
  assert.equal(interactiveAgain.status, 200, JSON.stringify(interactiveAgain.body));
  const resizedPixels = dipsToPixels(360, original.dpi);
  const resizedStatus = await statusWhere((status) =>
    status.pips[0].region.width === resizedPixels && status.pips[0].region.height === resizedPixels,
  );
  assert.equal(resizedStatus.pips[0].exStyle & 0x00080020, 0x00080000);
  assert.equal(resizedStatus.pips[0].style & 0x00cf0000, 0);
  assert.deepEqual(interactiveAgain.body.bounds, {
    left: locked.body.bounds.left,
    top: locked.body.bounds.top,
    width: 360,
    height: 360,
  });

  const unlocked = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "UNLOCKED",
  });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
  assert.deepEqual(unlocked.body.bounds, {
    left: screenPointToDips(original.left, original.monitor.left, original.dpi),
    top: screenPointToDips(original.top, original.monitor.top, original.dpi),
    width: pixelsToDips(original.width, original.dpi),
    height: pixelsToDips(original.height, original.dpi),
  });
  const restored = await statusWhere((status) =>
    status.pips[0].style === original.style &&
    status.pips[0].exStyle === original.exStyle &&
    status.pips[0].region.type === original.region.type &&
    status.pips[0].region.width === original.region.width &&
    status.pips[0].region.height === original.region.height,
  );
  assert.deepEqual(restored.pips[0].region, original.region);
  assert.equal(restored.pips[0].left, original.left);
  assert.equal(restored.pips[0].top, original.top);
  assert.equal(restored.pips[0].width, original.width);
  assert.equal(restored.pips[0].height, original.height);

  await command("MOVE", -29400, -29300, 900, 700);
  const movedUnlocked = await statusWhere((status) =>
    status.pips[0].left === -29400 &&
    status.pips[0].top === -29300 &&
    status.pips[0].width === 900 &&
    status.pips[0].height === 700,
  );
  const relockedAfterMove = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "LOCKED",
    width: 300,
    height: 300,
  });
  assert.equal(relockedAfterMove.status, 200, JSON.stringify(relockedAfterMove.body));
  const unlockedAfterMove = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "UNLOCKED",
  });
  assert.equal(unlockedAfterMove.status, 200, JSON.stringify(unlockedAfterMove.body));
  const movedRestored = await statusWhere((status) =>
    status.pips[0].style === movedUnlocked.pips[0].style &&
    status.pips[0].exStyle === movedUnlocked.pips[0].exStyle &&
    status.pips[0].left === movedUnlocked.pips[0].left &&
    status.pips[0].top === movedUnlocked.pips[0].top &&
    status.pips[0].width === movedUnlocked.pips[0].width &&
    status.pips[0].height === movedUnlocked.pips[0].height,
  );
  assert.deepEqual(movedRestored.pips[0].region, movedUnlocked.pips[0].region);

  const relockedForRestoreFailure = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: complete.body.overlayId,
    mode: "CLICK_THROUGH",
    width: 300,
    height: 300,
  });
  assert.equal(relockedForRestoreFailure.status, 200, JSON.stringify(relockedForRestoreFailure.body));
  assert.equal(relockedForRestoreFailure.body.bounds.width, 300);
  assert.equal(relockedForRestoreFailure.body.bounds.height, 300);
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

  await command("HOTKEY", serverChild.pid, 0x54a2);
  await waitFor(async () => {
    const response = await fetch(new URL("api/v1/native-overlay/events?after=0", url), {
      headers: nativeEventHeaders(session.token),
    });
    const payload = await response.json();
    return payload.events.length === 1 ? payload : null;
  }, 5_000, "Timed out waiting for the second overlay session hotkey event.");

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
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  await command("PROBE_HOTKEYS");
  await statusWhere((status) => status.hotKeyProbeAvailable === true);
  const staleEventsResponse = await fetch(
    new URL("api/v1/native-overlay/events?after=0", url),
    { headers: nativeEventHeaders(session.token) },
  );
  assert.equal(staleEventsResponse.status, 200);
  assert.deepEqual(await staleEventsResponse.json(), {
    protocolVersion: 1,
    latestCursor: 0,
    events: [],
  });
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
  const nullRegionBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  await statusWhere((status) => status.pips.length === 1);
  await command("CLEAR_REGION");
  const nullRegionOriginal = await statusWhere((status) => status.pips[0].region.type === 0);
  const nullRegionAttached = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: nullRegionBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(nullRegionAttached.status, 201, JSON.stringify(nullRegionAttached.body));
  const nullRegionLocked = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: nullRegionAttached.body.overlayId,
    mode: "LOCKED",
    width: 300,
    height: 300,
  });
  assert.equal(nullRegionLocked.status, 200, JSON.stringify(nullRegionLocked.body));
  await statusWhere((status) => status.pips[0].region.type === 2);
  const nullRegionUnlocked = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: nullRegionAttached.body.overlayId,
    mode: "UNLOCKED",
  });
  assert.equal(nullRegionUnlocked.status, 200, JSON.stringify(nullRegionUnlocked.body));
  const nullRegionRestored = await statusWhere((status) => status.pips[0].region.type === 0);
  assert.equal(nullRegionRestored.pips[0].left, nullRegionOriginal.pips[0].left);
  assert.equal(nullRegionRestored.pips[0].top, nullRegionOriginal.pips[0].top);
  assert.equal(nullRegionRestored.pips[0].width, nullRegionOriginal.pips[0].width);
  assert.equal(nullRegionRestored.pips[0].height, nullRegionOriginal.pips[0].height);
  const nullRegionDetached = await nativeRequest("DELETE", "api/v1/native-overlay/minimap", session.token, {
    overlayId: nullRegionAttached.body.overlayId,
  });
  assert.equal(nullRegionDetached.status, 204, JSON.stringify(nullRegionDetached.body));

  await command("CLOSE");
  await statusWhere((status) => status.pips.length === 0);
  const duplicateRendererBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  const duplicateRendererOriginal = await statusWhere((status) => status.pips.length === 1);
  const duplicateRendererAttached = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: duplicateRendererBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(duplicateRendererAttached.status, 201, JSON.stringify(duplicateRendererAttached.body));
  await command("DUPLICATE_RENDERER");
  await statusWhere((status) => status.extraRenderers === 1);
  const ambiguousRendererLock = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: duplicateRendererAttached.body.overlayId,
    mode: "LOCKED",
    width: 300,
    height: 300,
  });
  assert.equal(ambiguousRendererLock.status, 500, JSON.stringify(ambiguousRendererLock.body));
  const duplicateRendererAfter = await statusWhere((status) => status.pips.length === 1);
  assert.deepEqual(
    {
      style: duplicateRendererAfter.pips[0].style,
      exStyle: duplicateRendererAfter.pips[0].exStyle,
      left: duplicateRendererAfter.pips[0].left,
      top: duplicateRendererAfter.pips[0].top,
      width: duplicateRendererAfter.pips[0].width,
      height: duplicateRendererAfter.pips[0].height,
      region: duplicateRendererAfter.pips[0].region,
    },
    {
      style: duplicateRendererOriginal.pips[0].style,
      exStyle: duplicateRendererOriginal.pips[0].exStyle,
      left: duplicateRendererOriginal.pips[0].left,
      top: duplicateRendererOriginal.pips[0].top,
      width: duplicateRendererOriginal.pips[0].width,
      height: duplicateRendererOriginal.pips[0].height,
      region: duplicateRendererOriginal.pips[0].region,
    },
  );
  const duplicateRendererDetached = await nativeRequest("DELETE", "api/v1/native-overlay/minimap", session.token, {
    overlayId: duplicateRendererAttached.body.overlayId,
  });
  assert.equal(duplicateRendererDetached.status, 204, JSON.stringify(duplicateRendererDetached.body));

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
  await command("BLOCK_HOTKEY");
  await statusWhere((status) => status.hotKeyBlocked === true);
  const unavailableHotKeyBegin = await nativeRequest("POST", "api/v1/native-overlay/claims", session.token, {});
  await command("CREATE", 1);
  await statusWhere((status) => status.pips.length === 1);
  const unavailableHotKeyAttached = await nativeRequest("POST", "api/v1/native-overlay/minimap", session.token, {
    claimId: unavailableHotKeyBegin.body.claimId,
    windowTitle: session.windowTitle,
  });
  assert.equal(unavailableHotKeyAttached.status, 201, JSON.stringify(unavailableHotKeyAttached.body));
  assert.equal(unavailableHotKeyAttached.body.globalHotkeysAvailable, false);
  const unavailableHotKeyLocked = await nativeRequest("PATCH", "api/v1/native-overlay/minimap", session.token, {
    overlayId: unavailableHotKeyAttached.body.overlayId,
    mode: "LOCKED",
    width: 300,
    height: 300,
  });
  assert.equal(unavailableHotKeyLocked.status, 200, JSON.stringify(unavailableHotKeyLocked.body));
  assert.equal(unavailableHotKeyLocked.body.globalHotkeysAvailable, false);
  await statusWhere((status) =>
    status.pips.length === 1 &&
    (status.pips[0].exStyle & 0x08000000) === 0 &&
    status.pips[0].region.type === 2,
  );
  await command("HOTKEY", serverChild.pid, 0x54a2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const unavailableHotKeyEvents = await fetch(
    new URL("api/v1/native-overlay/events?after=0", url),
    { headers: nativeEventHeaders(session.token) },
  );
  assert.deepEqual(await unavailableHotKeyEvents.json(), {
    protocolVersion: 1,
    latestCursor: 0,
    events: [],
  });
  const unavailableHotKeyDetached = await nativeRequest("DELETE", "api/v1/native-overlay/minimap", session.token, {
    overlayId: unavailableHotKeyAttached.body.overlayId,
  });
  assert.equal(unavailableHotKeyDetached.status, 204, JSON.stringify(unavailableHotKeyDetached.body));
  await command("CLOSE");
  await statusWhere((status) => status.pips.length === 0);
  await command("UNBLOCK_HOTKEY");
  await statusWhere((status) => status.hotKeyBlocked === false);

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
  assert.deepEqual(shutdownRestored.pips[0].region, shutdownOriginal.pips[0].region);

  await command("PROBE_HOTKEYS");
  await statusWhere((status) => status.hotKeyProbeAvailable === true);

  await command("EXIT");
});
