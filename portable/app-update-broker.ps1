[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [Parameter(Mandatory = $true)][string]$ExpectedPackageRoot,
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [ValidateRange(1, 65535)][int]$Port = 41753,
    [switch]$SkipRunOnce,
    [switch]$TestFailHealth,
    [ValidateSet("", "PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED", "ROLLING_BACK", "ROLLED_BACK")]
    [string]$TestCrashAfterPhase = "",
    [ValidateRange(0, 2147483647)][int]$WaitForProcessId = 0,
    [string]$WaitForProcessStartTimeUtc = "",
    [string]$ExpectedOldBuildIdentity = "",
    [string]$ExpectedCandidate = "",
    [string]$HandoffNonce = "",
    [string]$HandoffAckPath = "",
    [string]$HandoffCancelPath = "",
    [ValidateRange(0, 120000)][int]$TestHandoffVerifyDelayMilliseconds = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$healthPath = "/.tarkov-helper-portable"

$treeVerifierSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace TarkovHelperUpdateBrokerSupport
{
    public sealed class TreeRecord
    {
        public int FileCount { get; internal set; }
        public long Bytes { get; internal set; }
        public string TreeSha256 { get; internal set; }
    }

    public static class TreeVerifier
    {
        private static string Hex(byte[] bytes)
        {
            StringBuilder result = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return result.ToString();
        }

        private static void NoReparse(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("The update tree contains a reparse point.");
        }

        private static void Collect(string root, string directory, List<string> files)
        {
            NoReparse(directory);
            foreach (string child in Directory.GetDirectories(directory)) Collect(root, child, files);
            foreach (string child in Directory.GetFiles(directory))
            {
                NoReparse(child);
                files.Add(child);
            }
        }

        public static TreeRecord Verify(string rootPath, int expectedCount, long expectedBytes, string expectedHash)
        {
            string root = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar);
            if (!Directory.Exists(root)) throw new DirectoryNotFoundException("The update tree is missing.");
            List<string> files = new List<string>();
            Collect(root, root, files);
            files.Sort(delegate(string left, string right)
            {
                string leftRelative = left.Substring(root.Length + 1).Replace(Path.DirectorySeparatorChar, '/');
                string rightRelative = right.Substring(root.Length + 1).Replace(Path.DirectorySeparatorChar, '/');
                return StringComparer.Ordinal.Compare(leftRelative, rightRelative);
            });
            if (files.Count != expectedCount) throw new InvalidDataException("The staged file count changed.");
            long total = 0;
            StringBuilder manifest = new StringBuilder();
            foreach (string file in files)
            {
                FileInfo info = new FileInfo(file);
                total = checked(total + info.Length);
                byte[] digest;
                using (FileStream input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (SHA256 hash = SHA256.Create()) digest = hash.ComputeHash(input);
                string relative = file.Substring(root.Length + 1).Replace(Path.DirectorySeparatorChar, '/');
                manifest.Append(Hex(digest)).Append("  ").Append(info.Length.ToString(CultureInfo.InvariantCulture)).Append("  ").Append(relative).Append('\n');
            }
            byte[] treeDigest;
            using (SHA256 hash = SHA256.Create()) treeDigest = hash.ComputeHash(new UTF8Encoding(false, true).GetBytes(manifest.ToString()));
            string tree = Hex(treeDigest);
            if (total != expectedBytes || !String.Equals(tree, expectedHash, StringComparison.Ordinal))
                throw new InvalidDataException("The staged update tree changed after verification.");
            return new TreeRecord { FileCount = files.Count, Bytes = total, TreeSha256 = tree };
        }
    }
}
'@

Add-Type -TypeDefinition $treeVerifierSource -Language CSharp

function Get-UpdateDirectory {
    $directory = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) "app-update"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The update state directory is unsafe.") }
    return $directory
}

function Write-AtomicJson {
    param([string]$Path, [object]$Value)
    $bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $Value -Compress -Depth 10))
    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try {
        if ([IO.File]::Exists($Path)) {
            $backup = Join-Path $directory ("." + [IO.Path]::GetFileName($Path) + "." + [Guid]::NewGuid().ToString("N") + ".bak")
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) } finally { if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) } }
        } else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Read-BoundedJson {
    param([string]$Path, [int]$MaximumBytes = 1048576)
    $file = [IO.FileInfo]::new([IO.Path]::GetFullPath($Path))
    if (-not $file.Exists -or $file.Length -le 0 -or $file.Length -gt $MaximumBytes) { throw [IO.InvalidDataException]::new("The update state file is invalid.") }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { throw [IO.InvalidDataException]::new("The update state file has a BOM.") }
    return $utf8.GetString($bytes) | ConvertFrom-Json
}

function Assert-ExactObject {
    param([object]$Value, [string[]]$Properties, [string]$Label)
    $actual = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @("NoteProperty", "Property") } | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Properties.Count) { throw [IO.InvalidDataException]::new("$Label has an invalid shape.") }
    foreach ($property in $Properties) { if (-not ($actual -ccontains $property)) { throw [IO.InvalidDataException]::new("$Label has an invalid shape.") } }
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
    try {
        $hash = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $hash.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

function Get-VersionDocument {
    param([string]$Root)
    $value = Read-BoundedJson -Path (Join-Path $Root "app\version.json") -MaximumBytes 8192
    Assert-ExactObject -Value $value -Properties @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion") -Label "app/version.json"
    if ($value.schemaVersion -ne 1 -or $value.product -cne "tarkov-helper-web" -or $value.version -isnot [string] -or $value.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $value.commit -isnot [string] -or $value.commit -notmatch '^[0-9a-f]{40}$' -or $value.updaterProtocolVersion -ne 1) { throw [IO.InvalidDataException]::new("The package version identity is invalid.") }
    return $value
}

function Get-MutexName {
    $normalized = [IO.Path]::GetFullPath($StateDirectory).ToUpperInvariant()
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)) } finally { $hash.Dispose() }
    return "Local\TarkovHelperWebUpdateApply" + ([BitConverter]::ToString($bytes, 0, 12)).Replace("-", "")
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new(); $null = $builder.Append('"'); $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') { $null = $builder.Append([string]::new([char]92, (($slashes * 2) + 1))); $null = $builder.Append('"'); $slashes = 0; continue }
        if ($slashes -gt 0) { $null = $builder.Append([string]::new([char]92, $slashes)); $slashes = 0 }
        $null = $builder.Append($character)
    }
    if ($slashes -gt 0) { $null = $builder.Append([string]::new([char]92, ($slashes * 2))) }
    $null = $builder.Append('"'); return $builder.ToString()
}

function Get-JournalPath { return Join-Path (Get-UpdateDirectory) "apply-journal.json" }
function Get-StatusPath { return Join-Path (Get-UpdateDirectory) "status.json" }

function Write-Journal {
    param(
        [object]$Plan,
        [string]$Phase,
        [string]$BackupRoot,
        [string]$FailedRoot,
        [int]$ServerPid = 0,
        [string]$ServerProcessStartTimeUtc = ""
    )
    Write-AtomicJson -Path (Get-JournalPath) -Value ([ordered]@{
        schemaVersion = 1; candidateId = [string]$Plan.candidateId; phase = $Phase
        packageRoot = [string]$Plan.packageRoot; stageRoot = [string]$Plan.stageRoot; backupRoot = $BackupRoot; failedRoot = $FailedRoot
        currentVersion = [string]$Plan.currentVersion; latestVersion = [string]$Plan.latestVersion; port = $Port; serverPid = $ServerPid
        serverProcessStartTimeUtc = $ServerProcessStartTimeUtc
        updatedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    })
    if ($TestCrashAfterPhase -ceq $Phase) {
        # Test-only hard-stop after the durable phase write. Environment.Exit
        # bypasses the rollback catch and models abrupt broker termination.
        [Environment]::Exit(97)
    }
}

function Read-ApplyJournal {
    param([object]$Plan, [string]$BackupRoot, [string]$FailedRoot)
    $path = Get-JournalPath
    if (-not [IO.File]::Exists($path)) { return $null }
    $journal = Read-BoundedJson -Path $path -MaximumBytes 65536
    Assert-ExactObject -Value $journal -Properties @(
        "schemaVersion", "candidateId", "phase", "packageRoot", "stageRoot", "backupRoot", "failedRoot",
        "currentVersion", "latestVersion", "port", "serverPid", "serverProcessStartTimeUtc", "updatedAt"
    ) -Label "apply journal"
    $allowedPhases = @("PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED", "ROLLING_BACK", "ROLLED_BACK")
    if (
        $journal.schemaVersion -ne 1 -or $journal.candidateId -cne $Plan.candidateId -or
        $journal.phase -isnot [string] -or $journal.phase -notin $allowedPhases -or
        -not ([string]$journal.packageRoot).Equals([IO.Path]::GetFullPath([string]$Plan.packageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$journal.stageRoot).Equals([IO.Path]::GetFullPath([string]$Plan.stageRoot), [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$journal.backupRoot).Equals([IO.Path]::GetFullPath($BackupRoot), [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$journal.failedRoot).Equals([IO.Path]::GetFullPath($FailedRoot), [StringComparison]::OrdinalIgnoreCase) -or
        $journal.currentVersion -cne $Plan.currentVersion -or $journal.latestVersion -cne $Plan.latestVersion -or
        $journal.port -ne $Port -or $journal.serverPid -isnot [int] -or $journal.serverPid -lt 0 -or
        $journal.serverProcessStartTimeUtc -isnot [string] -or
        (($journal.serverPid -eq 0) -and $journal.serverProcessStartTimeUtc.Length -ne 0) -or
        (($journal.serverPid -gt 0) -and $journal.serverProcessStartTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T') -or
        $journal.updatedAt -isnot [string]
    ) { throw [IO.InvalidDataException]::new("The apply journal does not match the pending update.") }
    return $journal
}

function Write-Status {
    param([object]$Value)
    Write-AtomicJson -Path (Get-StatusPath) -Value $Value
}

function Write-BrokerLog {
    param([string]$Message)
    try {
        $line = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture) + " " + $Message + [Environment]::NewLine
        [IO.File]::AppendAllText((Join-Path (Get-UpdateDirectory) "broker.log"), $line, $utf8)
    } catch { }
}

function Test-SafeSibling {
    param([string]$Candidate, [string]$Parent, [string]$Pattern)
    $full = [IO.Path]::GetFullPath($Candidate)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    return $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full) -match $Pattern
}

function Remove-SafeTree {
    param([string]$Path, [string]$Parent, [string]$Pattern)
    if (-not [IO.Directory]::Exists($Path)) { return }
    if (-not (Test-SafeSibling -Candidate $Path -Parent $Parent -Pattern $Pattern) -or ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("Refusing to remove an unowned update directory.") }
    [IO.Directory]::Delete([IO.Path]::GetFullPath($Path), $true)
}

function Set-RecoveryRunOnce {
    param([object]$Plan)
    if ($SkipRunOnce) { return }
    $powershell = Join-Path $PSHOME "powershell.exe"
    if (-not [IO.File]::Exists($powershell)) { $powershell = "powershell.exe" }
    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath,
        "-PlanPath", $PlanPath, "-ExpectedPackageRoot", $ExpectedPackageRoot, "-StateDirectory", $StateDirectory, "-Port", [string]$Port
    )
    $command = (ConvertTo-ProcessArgument $powershell) + " " + (($arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join " ")
    $name = "TarkovHelperWebUpdate-" + ([string]$Plan.candidateId).Substring(0, 12)
    New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Force | Out-Null
    New-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name $name -Value $command -PropertyType String -Force | Out-Null
}

function Remove-RecoveryRunOnce {
    param([object]$Plan)
    if ($SkipRunOnce) { return }
    $name = "TarkovHelperWebUpdate-" + ([string]$Plan.candidateId).Substring(0, 12)
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name $name -Force -ErrorAction SilentlyContinue
}

function Read-Instance {
    $path = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) "instance.json"
    if (-not [IO.File]::Exists($path)) { return $null }
    $instance = Read-BoundedJson -Path $path -MaximumBytes 65536
    Assert-ExactObject -Value $instance -Properties @(
        "protocolVersion", "pid", "processStartTimeUtc", "port", "controlToken", "buildIdentity", "rootPath", "updateNonce", "startedAt"
    ) -Label "portable instance"
    if (
        $instance.protocolVersion -ne 1 -or $instance.pid -isnot [int] -or $instance.pid -le 0 -or
        $instance.processStartTimeUtc -isnot [string] -or $instance.processStartTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T' -or
        $instance.port -ne $Port -or $instance.controlToken -isnot [string] -or $instance.controlToken -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
        $instance.buildIdentity -isnot [string] -or $instance.buildIdentity -notmatch '^[0-9a-f]{64}$' -or
        $instance.rootPath -isnot [string] -or $instance.updateNonce -isnot [string] -or
        $instance.startedAt -isnot [string]
    ) { throw [IO.InvalidDataException]::new("The portable instance state is invalid.") }
    return $instance
}

function Get-RecordedProcess {
    param([int]$ProcessId, [string]$ProcessStartTimeUtc)
    if ($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ProcessStartTimeUtc)) { return $null }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        if ($process.HasExited) { return $null }
        $recorded = [DateTime]::Parse($ProcessStartTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $recorded).TotalMilliseconds) -ge 1000) { return $null }
        return $process
    } catch { return $null }
}

function Remove-StaleInstance {
    param([object]$Expected)
    $path = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) "instance.json"
    if (-not [IO.File]::Exists($path)) { return }
    $current = Read-Instance
    if ($null -ne $current -and $current.pid -eq $Expected.pid -and $current.controlToken -ceq $Expected.controlToken -and $current.processStartTimeUtc -ceq $Expected.processStartTimeUtc) {
        [IO.File]::Delete($path)
    }
}

function Invoke-Health {
    param([object]$Instance, [string]$ExpectedRoot, [string]$ExpectedNonce)
    if ($null -eq $Instance -or $Instance.pid -isnot [int] -or $Instance.port -ne $Port -or $Instance.controlToken -isnot [string] -or $Instance.controlToken -notmatch '^[A-Za-z0-9_-]{40,64}$' -or $Instance.buildIdentity -isnot [string] -or $Instance.updateNonce -cne $ExpectedNonce -or -not ([string]$Instance.rootPath).Equals((Join-Path $ExpectedRoot "app"), [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($null -eq (Get-RecordedProcess -ProcessId ([int]$Instance.pid) -ProcessStartTimeUtc ([string]$Instance.processStartTimeUtc))) { return $false }
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port$healthPath")
        $request.Proxy = $null; $request.AllowAutoRedirect = $false; $request.KeepAlive = $false; $request.Timeout = 2000; $request.ReadWriteTimeout = 2000
        $request.Headers["X-Tarkov-Control"] = [string]$Instance.controlToken
        $response = [Net.HttpWebResponse]$request.GetResponse()
        try {
            if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 512) { return $false }
            $reader = [IO.StreamReader]::new($response.GetResponseStream(), $utf8, $false, 512, $false)
            try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
            return $body -ceq ("tarkov-helper-web-portable-v1:" + [string]$Instance.buildIdentity + ":authenticated")
        } finally { $response.Dispose() }
    } catch { return $false }
}

function Start-Server {
    param([string]$Root, [string]$Nonce, [string]$Label)
    $launcher = Join-Path $Root "launcher.ps1"
    if (-not [IO.File]::Exists($launcher)) { throw [IO.FileNotFoundException]::new("The staged launcher is missing.", $launcher) }
    $powershell = Join-Path $PSHOME "powershell.exe"; if (-not [IO.File]::Exists($powershell)) { $powershell = "powershell.exe" }
    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $launcher,
        "-Action", "Serve", "-Root", (Join-Path $Root "app"), "-Port", [string]$Port, "-NoBrowser", "-StateDirectory", $StateDirectory, "-UpdateNonce", $Nonce
    )
    $argumentLine = ($arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join " "
    $directory = Get-UpdateDirectory
    $out = Join-Path $directory ("$Label.stdout.log"); $error = Join-Path $directory ("$Label.stderr.log")
    return Start-Process -FilePath $powershell -ArgumentList $argumentLine -WorkingDirectory $StateDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $error
}

function Wait-Healthy {
    param([Diagnostics.Process]$Process, [string]$Root, [string]$Nonce, [int]$Seconds = 20, [switch]$IgnoreInjectedFailure)
    if ($TestFailHealth -and -not $IgnoreInjectedFailure) { return $false }
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $instance = Read-Instance
        if ($null -ne $instance -and $instance.pid -eq $Process.Id -and (Invoke-Health -Instance $instance -ExpectedRoot $Root -ExpectedNonce $Nonce)) { return $true }
        if ($Process.HasExited) { Write-BrokerLog "Server process $($Process.Id) exited before health verification."; return $false }
        Start-Sleep -Milliseconds 100
    }
    Write-BrokerLog "Server process $($Process.Id) did not pass health verification before timeout."
    return $false
}

function Stop-RecordedServer {
    param([object]$Instance, [string]$Root, [string]$Nonce)
    if (-not (Invoke-Health -Instance $Instance -ExpectedRoot $Root -ExpectedNonce $Nonce)) {
        throw [Security.SecurityException]::new("A running local process could not be authenticated as the owned update server.")
    }
    $process = Get-RecordedProcess -ProcessId ([int]$Instance.pid) -ProcessStartTimeUtc ([string]$Instance.processStartTimeUtc)
    if ($null -eq $process) { throw [Security.SecurityException]::new("The owned update server process identity changed.") }
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/v1/control/shutdown")
        $request.Proxy = $null; $request.AllowAutoRedirect = $false; $request.KeepAlive = $false; $request.Timeout = 3000; $request.Method = "POST"; $request.ContentType = "application/json"
        $request.Headers["Origin"] = "http://127.0.0.1:$Port"; $request.Headers["X-Tarkov-Control"] = [string]$Instance.controlToken
        $body = $utf8.GetBytes("{}"); $request.ContentLength = $body.Length
        $requestStream = $request.GetRequestStream(); try { $requestStream.Write($body, 0, $body.Length) } finally { $requestStream.Dispose() }
        $response = $request.GetResponse(); $response.Dispose()
    } catch {
        Write-BrokerLog "Authenticated shutdown request failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline -and $null -ne (Get-RecordedProcess -ProcessId ([int]$Instance.pid) -ProcessStartTimeUtc ([string]$Instance.processStartTimeUtc))) {
        Start-Sleep -Milliseconds 100
    }
    $process = Get-RecordedProcess -ProcessId ([int]$Instance.pid) -ProcessStartTimeUtc ([string]$Instance.processStartTimeUtc)
    if ($null -ne $process) {
        $process.Kill()
        $null = $process.WaitForExit(5000)
    }
    if ($null -ne (Get-RecordedProcess -ProcessId ([int]$Instance.pid) -ProcessStartTimeUtc ([string]$Instance.processStartTimeUtc))) {
        throw [InvalidOperationException]::new("The authenticated update server did not stop.")
    }
    Remove-StaleInstance -Expected $Instance
}

function Get-IdentityIfPresent {
    param([string]$Root)
    if (-not [IO.Directory]::Exists($Root)) { return $null }
    if (([IO.File]::GetAttributes($Root) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("An update package root is a reparse point.") }
    return Get-VersionDocument $Root
}

function Test-Identity {
    param([object]$Identity, [string]$Version, [string]$Commit)
    return $null -ne $Identity -and $Identity.version -ceq $Version -and $Identity.commit -ceq $Commit
}

function Get-ProcessStartTimeText {
    param([Diagnostics.Process]$Process)
    return $Process.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
}

function Test-LiveHandoffCancellation {
    param(
        [string]$Path,
        [object]$Plan,
        [string]$PackageRoot,
        [string]$BrokerProcessStartTimeUtc
    )

    if (-not [IO.File]::Exists($Path)) { return $false }
    $cancel = Read-BoundedJson -Path $Path -MaximumBytes 65536
    Assert-ExactObject -Value $cancel -Properties @(
        "schemaVersion", "state", "handoffNonce", "candidateId", "packageRoot", "port",
        "oldProcessId", "oldProcessStartTimeUtc", "brokerPid", "brokerProcessStartTimeUtc"
    ) -Label "live update cancellation"
    if (
        $cancel.schemaVersion -ne 1 -or
        $cancel.state -cne "CANCEL" -or
        $cancel.handoffNonce -cne $HandoffNonce -or
        $cancel.candidateId -cne [string]$Plan.candidateId -or
        -not ([string]$cancel.packageRoot).Equals($PackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $cancel.port -ne $Port -or
        $cancel.oldProcessId -ne $WaitForProcessId -or
        $cancel.oldProcessStartTimeUtc -cne $WaitForProcessStartTimeUtc -or
        $cancel.brokerPid -ne $PID -or
        $cancel.brokerProcessStartTimeUtc -cne $BrokerProcessStartTimeUtc
    ) {
        throw [Security.SecurityException]::new("The live update cancellation identity is invalid.")
    }
    return $true
}

function Invoke-LiveHandoff {
    param(
        [object]$Plan,
        [string]$PackageRoot,
        [string]$StageRoot,
        [object]$Journal
    )

    $requested =
        $WaitForProcessId -gt 0 -or
        -not [string]::IsNullOrWhiteSpace($WaitForProcessStartTimeUtc) -or
        -not [string]::IsNullOrWhiteSpace($ExpectedOldBuildIdentity) -or
        -not [string]::IsNullOrWhiteSpace($ExpectedCandidate) -or
        -not [string]::IsNullOrWhiteSpace($HandoffNonce) -or
        -not [string]::IsNullOrWhiteSpace($HandoffAckPath) -or
        -not [string]::IsNullOrWhiteSpace($HandoffCancelPath)
    if (-not $requested) { return }
    if (
        $WaitForProcessId -le 0 -or
        [string]::IsNullOrWhiteSpace($WaitForProcessStartTimeUtc) -or
        [string]::IsNullOrWhiteSpace($ExpectedOldBuildIdentity) -or
        [string]::IsNullOrWhiteSpace($ExpectedCandidate) -or
        [string]::IsNullOrWhiteSpace($HandoffNonce) -or
        [string]::IsNullOrWhiteSpace($HandoffAckPath) -or
        [string]::IsNullOrWhiteSpace($HandoffCancelPath)
    ) {
        throw [Security.SecurityException]::new("The live update handoff is incomplete.")
    }
    if (
        $WaitForProcessStartTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T' -or
        $ExpectedOldBuildIdentity -notmatch '^[0-9a-f]{64}$' -or
        $ExpectedCandidate -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
        $HandoffNonce -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
        $Plan.candidateId -cne $ExpectedCandidate -or
        $null -ne $Journal
    ) {
        throw [Security.SecurityException]::new("The live update handoff identity is invalid.")
    }

    $updateDirectory = [IO.Path]::GetFullPath((Get-UpdateDirectory))
    $expectedAckPath = Join-Path $updateDirectory ("handoff-" + $HandoffNonce + ".json")
    if (-not ([IO.Path]::GetFullPath($HandoffAckPath)).Equals($expectedAckPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw [Security.SecurityException]::new("The live update acknowledgement path is invalid.")
    }
    $expectedCancelPath = Join-Path $updateDirectory ("handoff-" + $HandoffNonce + ".cancel.json")
    if (-not ([IO.Path]::GetFullPath($HandoffCancelPath)).Equals($expectedCancelPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw [Security.SecurityException]::new("The live update cancellation path is invalid.")
    }
    $expectedBrokerPath = Join-Path $updateDirectory ("broker-" + [string]$Plan.brokerSha256 + ".ps1")
    if (-not ([IO.Path]::GetFullPath($PSCommandPath)).Equals($expectedBrokerPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw [Security.SecurityException]::new("The live update broker is not running from trusted state storage.")
    }

    $brokerProcess = Get-Process -Id $PID -ErrorAction Stop
    $brokerProcessStartTimeUtc = Get-ProcessStartTimeText $brokerProcess
    if (Test-LiveHandoffCancellation -Path $expectedCancelPath -Plan $Plan -PackageRoot $PackageRoot -BrokerProcessStartTimeUtc $brokerProcessStartTimeUtc) {
        throw [OperationCanceledException]::new("The live update handoff was cancelled before acknowledgement.")
    }

    $rootIdentity = Get-VersionDocument $PackageRoot
    if ($rootIdentity.version -cne $Plan.currentVersion -or $rootIdentity.commit -cne $Plan.currentCommit) {
        throw [IO.InvalidDataException]::new("The live update source package changed before handoff.")
    }
    if ($TestHandoffVerifyDelayMilliseconds -gt 0) {
        Start-Sleep -Milliseconds $TestHandoffVerifyDelayMilliseconds
    }
    if (Test-LiveHandoffCancellation -Path $expectedCancelPath -Plan $Plan -PackageRoot $PackageRoot -BrokerProcessStartTimeUtc $brokerProcessStartTimeUtc) {
        throw [OperationCanceledException]::new("The live update handoff was cancelled during verification.")
    }
    $null = [TarkovHelperUpdateBrokerSupport.TreeVerifier]::Verify(
        $StageRoot,
        [int]$Plan.fileCount,
        [long]$Plan.unpackedBytes,
        [string]$Plan.treeSha256
    )
    if (Test-LiveHandoffCancellation -Path $expectedCancelPath -Plan $Plan -PackageRoot $PackageRoot -BrokerProcessStartTimeUtc $brokerProcessStartTimeUtc) {
        throw [OperationCanceledException]::new("The live update handoff was cancelled after verification.")
    }

    $instance = Read-Instance
    if (
        $null -eq $instance -or
        $instance.pid -ne $WaitForProcessId -or
        $instance.processStartTimeUtc -cne $WaitForProcessStartTimeUtc -or
        $instance.buildIdentity -cne $ExpectedOldBuildIdentity -or
        -not ([string]$instance.rootPath).Equals((Join-Path $PackageRoot "app"), [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw [Security.SecurityException]::new("The running server could not be authenticated for live update handoff.")
    }
    try {
        $oldProcess = Get-Process -Id $WaitForProcessId -ErrorAction Stop
    } catch {
        throw [Security.SecurityException]::new("The live update source process identity changed.", $_.Exception)
    }
    if ($oldProcess.HasExited -or (Get-ProcessStartTimeText $oldProcess) -cne $WaitForProcessStartTimeUtc) {
        throw [Security.SecurityException]::new("The live update source process identity changed.")
    }

    Write-AtomicJson -Path $expectedAckPath -Value ([ordered]@{
        schemaVersion = 1
        state = "READY"
        handoffNonce = $HandoffNonce
        candidateId = [string]$Plan.candidateId
        packageRoot = $PackageRoot
        port = $Port
        oldProcessId = $WaitForProcessId
        oldProcessStartTimeUtc = $WaitForProcessStartTimeUtc
        oldBuildIdentity = $ExpectedOldBuildIdentity
        brokerPid = $PID
        brokerProcessStartTimeUtc = $brokerProcessStartTimeUtc
    })

    # The launcher can cancel this exact helper if writing the 202 response
    # fails. Once the response succeeds, keep the durable handoff alive for as
    # long as the exact old process needs to finish overlay and listener cleanup.
    # A fixed timeout could otherwise expire just before a slow shutdown exits,
    # leaving neither the old server nor the update broker running.
    while (-not $oldProcess.WaitForExit(100)) {
        if (Test-LiveHandoffCancellation -Path $expectedCancelPath -Plan $Plan -PackageRoot $PackageRoot -BrokerProcessStartTimeUtc $brokerProcessStartTimeUtc) {
            throw [OperationCanceledException]::new("The acknowledged live update handoff was cancelled.")
        }
    }
    if (Test-LiveHandoffCancellation -Path $expectedCancelPath -Plan $Plan -PackageRoot $PackageRoot -BrokerProcessStartTimeUtc $brokerProcessStartTimeUtc) {
        throw [OperationCanceledException]::new("The live update handoff was cancelled as the source process exited.")
    }
}

function Complete-Commit {
    param(
        [object]$Plan,
        [string]$BackupRoot,
        [string]$FailedRoot,
        [string]$ExistingPhase,
        [int]$ServerPid,
        [string]$ServerProcessStartTimeUtc
    )
    if ($ExistingPhase -notin @("HEALTHY", "COMMITTED")) {
        Write-Journal -Plan $Plan -Phase "HEALTHY" -BackupRoot $BackupRoot -FailedRoot $FailedRoot -ServerPid $ServerPid -ServerProcessStartTimeUtc $ServerProcessStartTimeUtc
    }
    Write-Status ([ordered]@{
        state = "UPDATED"; currentVersion = [string]$Plan.latestVersion; previousVersion = [string]$Plan.currentVersion
        updatedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    })
    if ($ExistingPhase -cne "COMMITTED") {
        Write-Journal -Plan $Plan -Phase "COMMITTED" -BackupRoot $BackupRoot -FailedRoot $FailedRoot -ServerPid $ServerPid -ServerProcessStartTimeUtc $ServerProcessStartTimeUtc
    }
    $candidatePath = Join-Path (Get-UpdateDirectory) "candidate.json"
    if ([IO.File]::Exists($candidatePath)) { [IO.File]::Delete($candidatePath) }
    $journalPath = Get-JournalPath
    if ([IO.File]::Exists($journalPath)) { [IO.File]::Delete($journalPath) }
    # pending.json is the launcher's transaction trigger. Delete it last so a
    # crash during cleanup always leaves a replayable transaction, never a stale
    # journal that can poison the next candidate.
    if ([IO.File]::Exists([IO.Path]::GetFullPath($PlanPath))) { [IO.File]::Delete([IO.Path]::GetFullPath($PlanPath)) }
    Remove-RecoveryRunOnce -Plan $Plan
}

function Complete-Rollback {
    param(
        [object]$Plan,
        [string]$PackageRoot,
        [string]$StageRoot,
        [string]$BackupRoot,
        [string]$FailedRoot,
        [string]$Parent,
        [string]$EscapedLeaf,
        [object]$HealthyOldInstance
    )
    $oldServer = $null
    $instance = $HealthyOldInstance
    if ($null -eq $instance) {
        $oldServer = Start-Server -Root $PackageRoot -Nonce ([string]$Plan.healthNonce) -Label "update-rollback"
        if (-not (Wait-Healthy -Process $oldServer -Root $PackageRoot -Nonce ([string]$Plan.healthNonce) -IgnoreInjectedFailure)) {
            throw [InvalidOperationException]::new("The restored server failed its health check.")
        }
        $instance = Read-Instance
    }
    Write-Journal -Plan $Plan -Phase "ROLLED_BACK" -BackupRoot $BackupRoot -FailedRoot $FailedRoot -ServerPid ([int]$instance.pid) -ServerProcessStartTimeUtc ([string]$instance.processStartTimeUtc)
    Write-Status ([ordered]@{
        state = "ERROR"; currentVersion = [string]$Plan.currentVersion; operation = "APPLY"; code = "APPLY_FAILED"
        message = "The update failed and the previous version was restored."
    })
    $candidatePath = Join-Path (Get-UpdateDirectory) "candidate.json"
    if ([IO.File]::Exists($candidatePath)) { [IO.File]::Delete($candidatePath) }
    if ([IO.Directory]::Exists($StageRoot)) {
        Remove-SafeTree -Path $StageRoot -Parent $Parent -Pattern ("^\." + $EscapedLeaf + "\.update-stage-[A-Za-z0-9_-]{40,64}$")
    }
    if ([IO.Directory]::Exists($FailedRoot)) {
        # The failed signed tree is useful only until the authenticated old
        # server is healthy. Remove it before clearing the transaction trigger
        # so repeated failures cannot accumulate unbounded package-sized trees.
        Remove-SafeTree -Path $FailedRoot -Parent $Parent -Pattern ("^\." + $EscapedLeaf + "\.update-failed-[A-Za-z0-9_-]{40,64}$")
    }
    $journalPath = Get-JournalPath
    if ([IO.File]::Exists($journalPath)) { [IO.File]::Delete($journalPath) }
    if ([IO.File]::Exists([IO.Path]::GetFullPath($PlanPath))) { [IO.File]::Delete([IO.Path]::GetFullPath($PlanPath)) }
    Remove-RecoveryRunOnce -Plan $Plan
}

$mutex = [Threading.Mutex]::new($false, (Get-MutexName))
$hasMutex = $false
$newServer = $null
$plan = $null
$backupRoot = $null
$failedRoot = $null
$packageRoot = $null
$stageRoot = $null
$parent = $null
$escapedLeaf = $null
$canReconcile = $false
try {
    try { $hasMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasMutex = $true }
    if (-not $hasMutex) { exit 12 }
    $plan = Read-BoundedJson -Path $PlanPath -MaximumBytes 65536
    Assert-ExactObject -Value $plan -Properties @("schemaVersion", "state", "candidateId", "packageRoot", "stageRoot", "stateDirectory", "port", "currentVersion", "currentCommit", "latestVersion", "latestCommit", "treeSha256", "fileCount", "unpackedBytes", "brokerSha256", "healthNonce", "stagedAt") -Label "pending update"
    if (
        $plan.schemaVersion -ne 1 -or $plan.state -cne "READY_TO_RESTART" -or
        $plan.candidateId -isnot [string] -or $plan.candidateId -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
        $plan.healthNonce -isnot [string] -or $plan.healthNonce -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
        $plan.port -ne $Port -or
        $plan.treeSha256 -isnot [string] -or $plan.treeSha256 -notmatch '^[0-9a-f]{64}$' -or
        $plan.brokerSha256 -isnot [string] -or $plan.brokerSha256 -notmatch '^[0-9a-f]{64}$' -or
        $plan.currentVersion -isnot [string] -or $plan.currentVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
        $plan.latestVersion -isnot [string] -or $plan.latestVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
        $plan.currentVersion -ceq $plan.latestVersion -or
        $plan.currentCommit -isnot [string] -or $plan.currentCommit -notmatch '^[0-9a-f]{40}$' -or
        $plan.latestCommit -isnot [string] -or $plan.latestCommit -notmatch '^[0-9a-f]{40}$' -or
        $plan.fileCount -isnot [int] -or $plan.fileCount -lt 1 -or $plan.fileCount -gt 10000 -or
        (-not (($plan.unpackedBytes -is [long]) -or ($plan.unpackedBytes -is [int]))) -or
        [long]$plan.unpackedBytes -lt 1 -or [long]$plan.unpackedBytes -gt 1073741824 -or
        $plan.stagedAt -isnot [string]
    ) { throw [IO.InvalidDataException]::new("The pending update plan is invalid.") }
    $packageRoot = [IO.Path]::GetFullPath($ExpectedPackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $stateRoot = [IO.Path]::GetFullPath($StateDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not ([string]$plan.packageRoot).Equals($packageRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([string]$plan.stateDirectory).Equals($stateRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFullPath($PlanPath)).Equals([IO.Path]::GetFullPath((Join-Path (Get-UpdateDirectory) "pending.json")), [StringComparison]::OrdinalIgnoreCase) -or (Get-Sha256 $PSCommandPath) -cne [string]$plan.brokerSha256) { throw [Security.SecurityException]::new("The pending update is not bound to this broker and package.") }
    $parent = Split-Path -Parent $packageRoot; $leaf = [IO.Path]::GetFileName($packageRoot); $escapedLeaf = [Regex]::Escape($leaf)
    if (
        ([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not (Test-SafeSibling -Candidate ([string]$plan.stageRoot) -Parent $parent -Pattern ("^\." + $escapedLeaf + "\.update-stage-[A-Za-z0-9_-]{40,64}$")) -or
        $stateRoot.Equals($packageRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $stateRoot.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    ) { throw [IO.IOException]::new("The staged update is not a safe sibling of the package.") }
    $stageRoot = [IO.Path]::GetFullPath([string]$plan.stageRoot)
    $backupRoot = Join-Path $parent ("." + $leaf + ".update-backup")
    $failedRoot = Join-Path $parent ("." + $leaf + ".update-failed-" + [string]$plan.candidateId)
    $journal = Read-ApplyJournal -Plan $plan -BackupRoot $backupRoot -FailedRoot $failedRoot
    Invoke-LiveHandoff -Plan $plan -PackageRoot $packageRoot -StageRoot $stageRoot -Journal $journal
    $canReconcile = $true
    Set-RecoveryRunOnce -Plan $plan
    Write-Status ([ordered]@{ state = "APPLYING"; currentVersion = [string]$plan.currentVersion; latestVersion = [string]$plan.latestVersion; startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture) })
    if ($null -eq $journal) {
        Write-Journal -Plan $plan -Phase "PREPARED" -BackupRoot $backupRoot -FailedRoot $failedRoot
        $journal = Read-ApplyJournal -Plan $plan -BackupRoot $backupRoot -FailedRoot $failedRoot
    }

    $rootIdentity = Get-IdentityIfPresent $packageRoot
    $backupIdentity = Get-IdentityIfPresent $backupRoot
    $rootIsOld = Test-Identity -Identity $rootIdentity -Version ([string]$plan.currentVersion) -Commit ([string]$plan.currentCommit)
    $rootIsNew = Test-Identity -Identity $rootIdentity -Version ([string]$plan.latestVersion) -Commit ([string]$plan.latestCommit)
    $backupIsOld = Test-Identity -Identity $backupIdentity -Version ([string]$plan.currentVersion) -Commit ([string]$plan.currentCommit)
    if ($null -ne $rootIdentity -and -not $rootIsOld -and -not $rootIsNew) { throw [IO.InvalidDataException]::new("The installed package identity is outside the update transaction.") }
    $staleBackup = $null -ne $backupIdentity -and -not $backupIsOld
    if ($staleBackup -and -not ($rootIsOld -and [IO.Directory]::Exists($stageRoot) -and [string]$journal.phase -eq "PREPARED")) {
        throw [IO.InvalidDataException]::new("The rollback package identity is outside the update transaction.")
    }

    if ([IO.Directory]::Exists($stageRoot)) {
        $null = [TarkovHelperUpdateBrokerSupport.TreeVerifier]::Verify($stageRoot, [int]$plan.fileCount, [long]$plan.unpackedBytes, [string]$plan.treeSha256)
    } elseif ($rootIsNew) {
        $null = [TarkovHelperUpdateBrokerSupport.TreeVerifier]::Verify($packageRoot, [int]$plan.fileCount, [long]$plan.unpackedBytes, [string]$plan.treeSha256)
    } elseif ($journal.phase -notin @("ROLLING_BACK", "ROLLED_BACK")) {
        throw [IO.DirectoryNotFoundException]::new("Neither the staged nor applied update tree is available.")
    }
    if ($staleBackup) {
        # A previous transaction may have left the fixed backup sibling behind.
        # Only discard it when the current package is still the authenticated old
        # tree and the new staged tree has already passed verification. An active
        # journal or a missing old root remains fail-closed above.
        Remove-SafeTree -Path $backupRoot -Parent $parent -Pattern ("^\." + $escapedLeaf + "\.update-backup$")
        $backupIdentity = $null
        $backupIsOld = $false
    }

    $instance = Read-Instance
    if ($null -eq $instance -and $journal.serverPid -gt 0 -and $journal.phase -in @("NEW_STARTED", "HEALTHY", "COMMITTED", "ROLLING_BACK")) {
        $recorded = Get-RecordedProcess -ProcessId ([int]$journal.serverPid) -ProcessStartTimeUtc ([string]$journal.serverProcessStartTimeUtc)
        if ($null -ne $recorded) {
            $deadline = [DateTime]::UtcNow.AddSeconds(5)
            while ($null -eq $instance -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 100
                $instance = Read-Instance
            }
            if ($null -eq $instance) { throw [Security.SecurityException]::new("The interrupted server did not publish authenticated instance state.") }
        }
    }
    if ($null -ne $instance) {
        $recorded = Get-RecordedProcess -ProcessId ([int]$instance.pid) -ProcessStartTimeUtc ([string]$instance.processStartTimeUtc)
        if ($null -eq $recorded) {
            Remove-StaleInstance -Expected $instance
            $instance = $null
        } elseif (-not (Invoke-Health -Instance $instance -ExpectedRoot $packageRoot -ExpectedNonce ([string]$plan.healthNonce))) {
            throw [Security.SecurityException]::new("The running process could not be authenticated as this update transaction.")
        } elseif ($journal.phase -in @("ROLLING_BACK", "ROLLED_BACK")) {
            if ($rootIsOld) {
                Complete-Rollback -Plan $plan -PackageRoot $packageRoot -StageRoot $stageRoot -BackupRoot $backupRoot -FailedRoot $failedRoot -Parent $parent -EscapedLeaf $escapedLeaf -HealthyOldInstance $instance
                exit 10
            }
            if ($rootIsNew -and $backupIsOld) {
                Stop-RecordedServer -Instance $instance -Root $packageRoot -Nonce ([string]$plan.healthNonce)
                $instance = $null
                throw [InvalidOperationException]::new("Continuing the interrupted update rollback.")
            }
            throw [IO.InvalidDataException]::new("The interrupted rollback trees are not recoverable.")
        } elseif ($rootIsNew -and $backupIsOld) {
            $null = [TarkovHelperUpdateBrokerSupport.TreeVerifier]::Verify($packageRoot, [int]$plan.fileCount, [long]$plan.unpackedBytes, [string]$plan.treeSha256)
            Complete-Commit -Plan $plan -BackupRoot $backupRoot -FailedRoot $failedRoot -ExistingPhase ([string]$journal.phase) -ServerPid ([int]$instance.pid) -ServerProcessStartTimeUtc ([string]$instance.processStartTimeUtc)
            exit 0
        } elseif ($rootIsOld) {
            Stop-RecordedServer -Instance $instance -Root $packageRoot -Nonce ([string]$plan.healthNonce)
            $instance = $null
        } else {
            throw [IO.InvalidDataException]::new("The running update server does not match a recoverable package tree.")
        }
    }

    if ($journal.phase -in @("ROLLING_BACK", "ROLLED_BACK")) {
        throw [InvalidOperationException]::new("Continuing the interrupted update rollback.")
    }

    if ($rootIsOld -and [IO.Directory]::Exists($stageRoot)) {
        Remove-SafeTree -Path $backupRoot -Parent $parent -Pattern ("^\." + $escapedLeaf + "\.update-backup$")
        [IO.Directory]::Move($packageRoot, $backupRoot)
        Write-Journal -Plan $plan -Phase "OLD_MOVED" -BackupRoot $backupRoot -FailedRoot $failedRoot
        $rootIdentity = $null; $rootIsOld = $false; $backupIsOld = $true
    }
    if (-not [IO.Directory]::Exists($packageRoot) -and [IO.Directory]::Exists($backupRoot) -and [IO.Directory]::Exists($stageRoot)) {
        [IO.Directory]::Move($stageRoot, $packageRoot)
        Write-Journal -Plan $plan -Phase "NEW_MOVED" -BackupRoot $backupRoot -FailedRoot $failedRoot
        $rootIdentity = Get-IdentityIfPresent $packageRoot
        $rootIsNew = Test-Identity -Identity $rootIdentity -Version ([string]$plan.latestVersion) -Commit ([string]$plan.latestCommit)
    }
    $newIdentity = Get-VersionDocument $packageRoot
    if ($newIdentity.version -cne $plan.latestVersion -or $newIdentity.commit -cne $plan.latestCommit -or -not [IO.Directory]::Exists($backupRoot)) { throw [IO.InvalidDataException]::new("The package swap did not produce the expected version pair.") }
    $oldIdentity = Get-VersionDocument $backupRoot
    if ($oldIdentity.version -cne $plan.currentVersion -or $oldIdentity.commit -cne $plan.currentCommit) { throw [IO.InvalidDataException]::new("The retained rollback package does not match the previous version.") }
    $null = [TarkovHelperUpdateBrokerSupport.TreeVerifier]::Verify($packageRoot, [int]$plan.fileCount, [long]$plan.unpackedBytes, [string]$plan.treeSha256)

    $newServer = Start-Server -Root $packageRoot -Nonce ([string]$plan.healthNonce) -Label "update-new"
    $newServerStart = Get-ProcessStartTimeText $newServer
    Write-Journal -Plan $plan -Phase "NEW_STARTED" -BackupRoot $backupRoot -FailedRoot $failedRoot -ServerPid $newServer.Id -ServerProcessStartTimeUtc $newServerStart
    if (-not (Wait-Healthy -Process $newServer -Root $packageRoot -Nonce ([string]$plan.healthNonce))) { throw [InvalidOperationException]::new("The updated server failed its authenticated health check.") }
    Complete-Commit -Plan $plan -BackupRoot $backupRoot -FailedRoot $failedRoot -ExistingPhase "NEW_STARTED" -ServerPid $newServer.Id -ServerProcessStartTimeUtc $newServerStart
    exit 0
} catch {
    Write-BrokerLog "Apply failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    if ($null -eq $plan -or -not $canReconcile) { exit 20 }
    try {
        Write-Status ([ordered]@{ state = "ROLLING_BACK"; currentVersion = [string]$plan.currentVersion; latestVersion = [string]$plan.latestVersion; startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture) })
        $serverPid = 0; $serverStart = ""
        if ($null -ne $newServer) { $serverPid = $newServer.Id; $serverStart = Get-ProcessStartTimeText $newServer }
        elseif ($null -ne $journal -and $journal.serverPid -gt 0) { $serverPid = [int]$journal.serverPid; $serverStart = [string]$journal.serverProcessStartTimeUtc }
        Write-Journal -Plan $plan -Phase "ROLLING_BACK" -BackupRoot $backupRoot -FailedRoot $failedRoot -ServerPid $serverPid -ServerProcessStartTimeUtc $serverStart

        $rollbackInstance = Read-Instance
        $expectedServerProcess = $null
        if ($null -ne $newServer) {
            $expectedServerProcess = $newServer
        } elseif ($serverPid -gt 0) {
            $expectedServerProcess = Get-RecordedProcess -ProcessId $serverPid -ProcessStartTimeUtc $serverStart
        }
        if ($null -eq $rollbackInstance -and $null -ne $expectedServerProcess -and -not $expectedServerProcess.HasExited) {
            $instanceDeadline = [DateTime]::UtcNow.AddSeconds(5)
            while ($null -eq $rollbackInstance -and [DateTime]::UtcNow -lt $instanceDeadline -and -not $expectedServerProcess.HasExited) {
                Start-Sleep -Milliseconds 100
                $rollbackInstance = Read-Instance
            }
            if ($null -eq $rollbackInstance -and -not $expectedServerProcess.HasExited) {
                # This exact process was started and journaled by this transaction,
                # but failed before publishing the authenticated instance record.
                $expectedServerProcess.Kill()
                $null = $expectedServerProcess.WaitForExit(5000)
            }
        }
        if ($null -ne $rollbackInstance) {
            $rollbackProcess = Get-RecordedProcess -ProcessId ([int]$rollbackInstance.pid) -ProcessStartTimeUtc ([string]$rollbackInstance.processStartTimeUtc)
            if ($null -eq $rollbackProcess) {
                Remove-StaleInstance -Expected $rollbackInstance
                $rollbackInstance = $null
            } elseif ((Invoke-Health -Instance $rollbackInstance -ExpectedRoot $packageRoot -ExpectedNonce ([string]$plan.healthNonce))) {
                Stop-RecordedServer -Instance $rollbackInstance -Root $packageRoot -Nonce ([string]$plan.healthNonce)
                $rollbackInstance = $null
            } else {
                throw [Security.SecurityException]::new("Rollback refused to stop an unauthenticated process.")
            }
        }

        $rootIdentity = Get-IdentityIfPresent $packageRoot
        if (Test-Identity -Identity $rootIdentity -Version ([string]$plan.latestVersion) -Commit ([string]$plan.latestCommit)) {
            if ([IO.Directory]::Exists($failedRoot)) { throw [IO.IOException]::new("The failed update evidence path is already occupied.") }
            [IO.Directory]::Move($packageRoot, $failedRoot)
        }
        if (-not [IO.Directory]::Exists($packageRoot) -and [IO.Directory]::Exists($backupRoot)) { [IO.Directory]::Move($backupRoot, $packageRoot) }
        $restored = Get-VersionDocument $packageRoot
        if ($restored.version -cne $plan.currentVersion -or $restored.commit -cne $plan.currentCommit) { throw [IO.InvalidDataException]::new("The rollback tree is not the previous package.") }
        Complete-Rollback -Plan $plan -PackageRoot $packageRoot -StageRoot $stageRoot -BackupRoot $backupRoot -FailedRoot $failedRoot -Parent $parent -EscapedLeaf $escapedLeaf -HealthyOldInstance $null
        exit 10
    } catch {
        Write-BrokerLog "Rollback failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
        try { Write-Status ([ordered]@{ state = "ERROR"; currentVersion = [string]$plan.currentVersion; operation = "ROLLBACK"; code = "ROLLBACK_FAILED"; message = "The update could not restore the previous version automatically." }) } catch { }
        exit 11
    }
} finally {
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
