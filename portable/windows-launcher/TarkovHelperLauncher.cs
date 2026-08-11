using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace TarkovHelperLauncher
{
    internal static class Program
    {
        private const string LauncherScriptName = "Tarkov Helper 실행.vbs";
        private const string WindowTitle = "Tarkov Helper";

        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);

        [STAThread]
        private static int Main()
        {
            try
            {
                string packageRoot = AppDomain.CurrentDomain.BaseDirectory;
                string launcherScript = Path.Combine(packageRoot, LauncherScriptName);
                if (!File.Exists(launcherScript))
                {
                    return Fail(2, "Tarkov Helper 실행 파일이 완전하지 않습니다. 패키지를 다시 압축 해제해 주세요.");
                }

                string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
                string powerShellPath = Path.Combine(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                string wscriptPath = Path.Combine(systemDirectory, "wscript.exe");
                if (!File.Exists(powerShellPath) || !File.Exists(wscriptPath))
                {
                    return Fail(3, "Tarkov Helper에 필요한 Windows 구성 요소를 찾을 수 없습니다.");
                }

                string workingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (String.IsNullOrWhiteSpace(workingDirectory) || !Directory.Exists(workingDirectory))
                {
                    workingDirectory = Path.GetTempPath();
                }
                if (String.IsNullOrWhiteSpace(workingDirectory) || !Directory.Exists(workingDirectory))
                {
                    workingDirectory = systemDirectory;
                }

                int parentId;
                long parentStartUtcTicks;
                using (Process current = Process.GetCurrentProcess())
                {
                    parentId = current.Id;
                    parentStartUtcTicks = current.StartTime.ToUniversalTime().Ticks;
                }

                string bootstrapLog = Path.Combine(workingDirectory, "TarkovHelperWeb", "launcher-bootstrap.log");
                string encodedCommand = BuildEncodedCommand(parentId, parentStartUtcTicks, wscriptPath, launcherScript, bootstrapLog);

                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = powerShellPath,
                    Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encodedCommand,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    ErrorDialog = false,
                };

                using (Process child = Process.Start(startInfo))
                {
                    if (child == null) return Fail(4, "Tarkov Helper를 시작하지 못했습니다. 문제 해결용 실행을 사용해 주세요.");
                }
                return 0;
            }
            catch
            {
                return Fail(1, "Tarkov Helper를 시작하지 못했습니다. 문제 해결용 실행을 사용해 주세요.");
            }
        }

        private static string BuildEncodedCommand(
            int parentId,
            long parentStartUtcTicks,
            string wscriptPath,
            string launcherScript,
            string bootstrapLog)
        {
            string encodedWscriptPath = Convert.ToBase64String(Encoding.UTF8.GetBytes(wscriptPath));
            string encodedLauncherScript = Convert.ToBase64String(Encoding.UTF8.GetBytes(launcherScript));
            string encodedBootstrapLog = Convert.ToBase64String(Encoding.UTF8.GetBytes(bootstrapLog));
            string command =
                "$ErrorActionPreference = 'Stop'; " +
                "$parentId = " + parentId.ToString(CultureInfo.InvariantCulture) + "; " +
                "$parentStartUtcTicks = " + parentStartUtcTicks.ToString(CultureInfo.InvariantCulture) + "; " +
                "$bootstrapLog = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedBootstrapLog + "')); " +
                "try { " +
                "$parent = [Diagnostics.Process]::GetProcessById($parentId); " +
                "try { if ($parent.StartTime.ToUniversalTime().Ticks -eq $parentStartUtcTicks) { " +
                "if (-not $parent.WaitForExit(30000)) { " +
                "$logDirectory = [IO.Path]::GetDirectoryName($bootstrapLog); " +
                "[void][IO.Directory]::CreateDirectory($logDirectory); " +
                "[IO.File]::AppendAllText($bootstrapLog, 'Launcher parent process did not exit within 30 seconds.' + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)); " +
                "exit 70 } } } " +
                "finally { $parent.Dispose() } " +
                "} catch [ArgumentException] { } " +
                "$wscriptPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedWscriptPath + "')); " +
                "$launcherScript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedLauncherScript + "')); " +
                "& $wscriptPath '//Nologo' $launcherScript; " +
                "if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }";
            return Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
        }

        private static int Fail(int exitCode, string message)
        {
            try
            {
                MessageBoxW(IntPtr.Zero, message, WindowTitle, 0x00000010U);
            }
            catch
            {
                // The numeric exit code remains available to automated callers if the desktop is unavailable.
            }
            return exitCode;
        }
    }
}
