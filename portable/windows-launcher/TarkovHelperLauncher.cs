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
        private const string LauncherScriptName = "launcher.ps1";
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
                if (!File.Exists(powerShellPath))
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
                string encodedCommand = BuildEncodedCommand(parentId, parentStartUtcTicks, launcherScript, bootstrapLog);

                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = powerShellPath,
                    Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand " + encodedCommand,
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
            string launcherScript,
            string bootstrapLog)
        {
            string encodedLauncherScript = Convert.ToBase64String(Encoding.UTF8.GetBytes(launcherScript));
            string encodedBootstrapLog = Convert.ToBase64String(Encoding.UTF8.GetBytes(bootstrapLog));
            string command =
                "$ErrorActionPreference = 'Stop'; " +
                "$parentId = " + parentId.ToString(CultureInfo.InvariantCulture) + "; " +
                "$parentStartUtcTicks = " + parentStartUtcTicks.ToString(CultureInfo.InvariantCulture) + "; " +
                "$bootstrapLog = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedBootstrapLog + "')); " +
                "$launcherScript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedLauncherScript + "')); " +
                "$exitCode = 0; " +
                "try { " +
                "$parent = [Diagnostics.Process]::GetProcessById($parentId); " +
                "try { if ($parent.StartTime.ToUniversalTime().Ticks -eq $parentStartUtcTicks) { " +
                "if (-not $parent.WaitForExit(30000)) { " +
                "$exitCode = 70 } } } " +
                "finally { $parent.Dispose() } " +
                "} catch [ArgumentException] { } " +
                "catch { $exitCode = 70 } " +
                "if ($exitCode -eq 0) { " +
                "try { " +
                "& $launcherScript -Action Start; " +
                "$exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }; " +
                "if ($exitCode -ne 0) { " +
                "& $launcherScript -Action Stop; " +
                "$stopExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }; " +
                "if ($stopExitCode -eq 0) { " +
                "& $launcherScript -Action Start; " +
                "$exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE } " +
                "} } " +
                "} catch { $exitCode = 71 } " +
                "} " +
                "if ($exitCode -ne 0) { " +
                "try { " +
                "$logDirectory = [IO.Path]::GetDirectoryName($bootstrapLog); " +
                "[void][IO.Directory]::CreateDirectory($logDirectory); " +
                "$message = 'Launcher bootstrap failed with exit code ' + $exitCode + '.' + [Environment]::NewLine; " +
                "[IO.File]::AppendAllText($bootstrapLog, $message, [Text.UTF8Encoding]::new($false)) " +
                "} catch { } " +
                "try { " +
                "Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop; " +
                "[void][System.Windows.Forms.MessageBox]::Show(" +
                "'Tarkov Helper를 시작하지 못했습니다. 문제 해결용 실행.cmd를 실행해 자세한 오류를 확인하세요.', " +
                "'Tarkov Helper', " +
                "[System.Windows.Forms.MessageBoxButtons]::OK, " +
                "[System.Windows.Forms.MessageBoxIcon]::Error) " +
                "} catch { } " +
                "} " +
                "exit $exitCode";
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
