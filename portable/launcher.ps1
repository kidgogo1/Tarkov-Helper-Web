[CmdletBinding()]
param(
    [ValidateSet("Start", "Serve", "Stop")]
    [string]$Action = "Serve",
    [string]$Root,
    [ValidateRange(0, 65535)]
    [int]$Port = 41753,
    [switch]$NoBrowser,
    [ValidateRange(0, 2147483647)]
    [int]$MaxRequests = 0,
    [string]$ScreenshotFolder,
    [string]$StateDirectory
)

$ErrorActionPreference = "Stop"
$healthPath = "/.tarkov-helper-portable"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Join-Path $PSScriptRoot "app"
}

if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
    $StateDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "TarkovHelperWeb"
}

$trackerProtocolVersion = 1
$trackerEventLimit = 100
$trackerDebounceMilliseconds = 500
$trackerDiscoveryIntervalSeconds = 5
$trackerReconciliationIntervalSeconds = 5
$trackerFingerprintLimit = 2048
$trackerStartedAtUtc = [DateTime]::UtcNow
$trackerEvents = New-Object 'Collections.Generic.List[object]'
$trackerLatestCursor = [long]0
$screenshotWatcher = $null
$screenshotWatcherSources = @()
$screenshotWatcherErrorSource = $null
$screenshotPendingFiles = @{}
$screenshotFingerprints = @{}
$screenshotWatcherState = [pscustomobject]@{ state = "NOT_FOUND" }
$screenshotNextDiscoveryUtc = [DateTime]::MinValue
$screenshotNextReconciliationUtc = [DateTime]::MinValue

function Get-ScreenshotCandidates {
    $paths = New-Object 'Collections.Generic.List[string]'
    $knownPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $gameFolders = @("Escape from Tarkov", "Escape From Tarkov", "escape from tarkov")
    $koreanDocuments = ([string][char]0xBB38) + ([string][char]0xC11C)
    $documentFolders = @("Documents", $koreanDocuments, "My Documents")

    function Add-Candidate {
        param([string]$Candidate)
        if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
            try {
                $normalized = [IO.Path]::GetFullPath($Candidate)
                if ($knownPaths.Add($normalized)) {
                    $paths.Add($normalized)
                }
            } catch {
                # Ignore malformed environment-derived candidates.
            }
        }
    }

    $documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
    foreach ($gameFolder in $gameFolders) {
        Add-Candidate (Join-Path (Join-Path $documents $gameFolder) "Screenshots")
    }

    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    foreach ($documentFolder in $documentFolders) {
        foreach ($gameFolder in $gameFolders) {
            Add-Candidate (Join-Path (Join-Path (Join-Path $userProfile $documentFolder) $gameFolder) "Screenshots")
        }
    }

    foreach ($oneDriveVariable in @("OneDrive", "OneDriveConsumer", "OneDriveCommercial")) {
        $oneDrive = [Environment]::GetEnvironmentVariable($oneDriveVariable)
        if ([string]::IsNullOrWhiteSpace($oneDrive)) { continue }
        foreach ($documentFolder in $documentFolders) {
            foreach ($gameFolder in $gameFolders) {
                Add-Candidate (Join-Path (Join-Path (Join-Path $oneDrive $documentFolder) $gameFolder) "Screenshots")
            }
        }
        foreach ($gameFolder in $gameFolders) {
            Add-Candidate (Join-Path (Join-Path $oneDrive $gameFolder) "Screenshots")
        }
    }

    return $paths.ToArray()
}

function Get-ScreenshotSnapshot {
    param([Parameter(Mandatory = $true)][string]$FolderPath)

    $records = New-Object 'Collections.Generic.List[object]'
    foreach ($filePath in [IO.Directory]::EnumerateFiles($FolderPath, "*.png", [IO.SearchOption]::TopDirectoryOnly)) {
        try {
            $fileName = [IO.Path]::GetFileName($filePath)
            if (
                [string]::IsNullOrWhiteSpace($fileName) -or
                $fileName.Length -gt 255 -or
                -not [IO.Path]::GetExtension($fileName).Equals(".png", [StringComparison]::OrdinalIgnoreCase)
            ) {
                continue
            }
            $file = [IO.FileInfo]::new($filePath)
            $records.Add([pscustomobject]@{
                fileName = $fileName
                fingerprint = "$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
                lastWriteUtc = $file.LastWriteTimeUtc
            })
        } catch {
            # A file can disappear while the bounded snapshot is being collected.
        }
    }

    $snapshot = @{}
    foreach ($record in @($records | Sort-Object -Property lastWriteUtc -Descending | Select-Object -First $trackerFingerprintLimit)) {
        $snapshot[$record.fileName] = $record
    }
    return $snapshot
}

function Reconcile-ScreenshotWatcher {
    if ($null -eq $script:screenshotWatcher) { return }

    $snapshot = Get-ScreenshotSnapshot -FolderPath $script:screenshotWatcher.Path
    $now = [DateTime]::UtcNow
    foreach ($fileName in $snapshot.Keys) {
        $record = $snapshot[$fileName]
        $wasKnown = $script:screenshotFingerprints.ContainsKey($fileName)
        $hasChanged = -not $wasKnown -or $script:screenshotFingerprints[$fileName].fingerprint -cne $record.fingerprint
        if ($hasChanged -and $record.lastWriteUtc -ge $trackerStartedAtUtc) {
            $script:screenshotPendingFiles[$fileName] = $now
        }
    }
    $script:screenshotFingerprints = $snapshot
    $script:screenshotNextReconciliationUtc = $now.AddSeconds($trackerReconciliationIntervalSeconds)
}

function Stop-ScreenshotWatcher {
    foreach ($source in $script:screenshotWatcherSources) {
        Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
    }
    $script:screenshotWatcherSources = @()
    $script:screenshotWatcherErrorSource = $null
    $script:screenshotPendingFiles.Clear()
    if ($null -ne $script:screenshotWatcher) {
        $script:screenshotWatcher.EnableRaisingEvents = $false
        $script:screenshotWatcher.Dispose()
        $script:screenshotWatcher = $null
    }
}

function Start-ScreenshotWatcher {
    Stop-ScreenshotWatcher

    try {
        $selectedFolder = $null
        if (-not [string]::IsNullOrWhiteSpace($ScreenshotFolder)) {
            $selectedFolder = [IO.Path]::GetFullPath($ScreenshotFolder)
        } else {
            $config = Read-PortableConfig
            if ($null -ne $config -and [IO.Directory]::Exists($config.screenshotFolder)) {
                $selectedFolder = [IO.Path]::GetFullPath([string]($config.screenshotFolder))
            }
            if ([string]::IsNullOrWhiteSpace($selectedFolder)) {
                $selectedFolder = Get-ScreenshotCandidates | Where-Object { [IO.Directory]::Exists($_) } | Select-Object -First 1
            }
        }

        if ([string]::IsNullOrWhiteSpace($selectedFolder) -or -not [IO.Directory]::Exists($selectedFolder)) {
            $script:screenshotWatcherState = [pscustomobject]@{ state = "NOT_FOUND" }
            $script:screenshotNextDiscoveryUtc = [DateTime]::UtcNow.AddSeconds($trackerDiscoveryIntervalSeconds)
            return
        }

        $watcher = [IO.FileSystemWatcher]::new($selectedFolder, "*.png")
        $watcher.IncludeSubdirectories = $false
        $watcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::CreationTime -bor [IO.NotifyFilters]::LastWrite
        $createdSource = "TarkovHelper.Screenshot.Created.$PID.$([Guid]::NewGuid().ToString('N'))"
        $changedSource = "TarkovHelper.Screenshot.Changed.$PID.$([Guid]::NewGuid().ToString('N'))"
        $renamedSource = "TarkovHelper.Screenshot.Renamed.$PID.$([Guid]::NewGuid().ToString('N'))"
        $errorSource = "TarkovHelper.Screenshot.Error.$PID.$([Guid]::NewGuid().ToString('N'))"
        Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $createdSource | Out-Null
        Register-ObjectEvent -InputObject $watcher -EventName Changed -SourceIdentifier $changedSource | Out-Null
        Register-ObjectEvent -InputObject $watcher -EventName Renamed -SourceIdentifier $renamedSource | Out-Null
        Register-ObjectEvent -InputObject $watcher -EventName Error -SourceIdentifier $errorSource | Out-Null
        $watcher.EnableRaisingEvents = $true

        $script:screenshotWatcher = $watcher
        $script:screenshotWatcherSources = @($createdSource, $changedSource, $renamedSource, $errorSource)
        $script:screenshotWatcherErrorSource = $errorSource
        $script:screenshotWatcherState = [pscustomobject]@{
            state = "WATCHING"
            folderPath = $selectedFolder
        }
        $script:screenshotNextDiscoveryUtc = [DateTime]::MaxValue
        Reconcile-ScreenshotWatcher
        Write-PortableConfig -ScreenshotFolderPath $selectedFolder
    } catch {
        Stop-ScreenshotWatcher
        $script:screenshotWatcherState = [pscustomobject]@{
            state = "ERROR"
            message = "The screenshot folder could not be monitored."
        }
        $script:screenshotNextDiscoveryUtc = [DateTime]::UtcNow.AddSeconds($trackerDiscoveryIntervalSeconds)
    }
}

function Add-ScreenshotEvent {
    param([string]$FileName)

    if ([string]::IsNullOrWhiteSpace($FileName) -or $FileName.Length -gt 255) { return }
    if ([IO.Path]::GetFileName($FileName) -ne $FileName) { return }
    if (-not [IO.Path]::GetExtension($FileName).Equals(".png", [StringComparison]::OrdinalIgnoreCase)) { return }

    $script:trackerLatestCursor++
    $script:trackerEvents.Add([pscustomobject]@{
        type = "SCREENSHOT_CREATED"
        sequence = $script:trackerLatestCursor
        fileName = $FileName
        detectedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    })
    while ($script:trackerEvents.Count -gt $trackerEventLimit) {
        $script:trackerEvents.RemoveAt(0)
    }
}

function Update-ScreenshotWatcher {
    $now = [DateTime]::UtcNow
    if ($script:screenshotWatcherState.state -ne "WATCHING") {
        if ($now -ge $script:screenshotNextDiscoveryUtc) {
            Start-ScreenshotWatcher
        }
        return
    }

    if ($null -eq $script:screenshotWatcher -or -not [IO.Directory]::Exists($script:screenshotWatcher.Path)) {
        Stop-ScreenshotWatcher
        $script:screenshotWatcherState = [pscustomobject]@{ state = "NOT_FOUND" }
        $script:screenshotNextDiscoveryUtc = $now.AddSeconds($trackerDiscoveryIntervalSeconds)
        return
    }

    $watcherError = $false
    if (-not [string]::IsNullOrWhiteSpace($script:screenshotWatcherErrorSource)) {
        foreach ($eventRecord in @(Get-Event -SourceIdentifier $script:screenshotWatcherErrorSource -ErrorAction SilentlyContinue)) {
            Remove-Event -EventIdentifier $eventRecord.EventIdentifier -ErrorAction SilentlyContinue
            $watcherError = $true
        }
    }
    if ($watcherError) {
        Stop-ScreenshotWatcher
        $script:screenshotWatcherState = [pscustomobject]@{
            state = "ERROR"
            message = "The screenshot folder could not be monitored."
        }
        $script:screenshotNextDiscoveryUtc = $now.AddSeconds($trackerDiscoveryIntervalSeconds)
        return
    }

    foreach ($source in $script:screenshotWatcherSources) {
        if ($source -eq $script:screenshotWatcherErrorSource) { continue }
        foreach ($eventRecord in @(Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
            try {
                $fullPath = [string]($eventRecord.SourceEventArgs.FullPath)
                $parentPath = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($fullPath))
                $watchRoot = [IO.Path]::GetFullPath($script:screenshotWatcher.Path)
                $fileName = [IO.Path]::GetFileName($fullPath)
                if (
                    $parentPath.Equals($watchRoot, [StringComparison]::OrdinalIgnoreCase) -and
                    [IO.Path]::GetExtension($fileName).Equals(".png", [StringComparison]::OrdinalIgnoreCase)
                ) {
                    $script:screenshotPendingFiles[$fileName] = [DateTime]::UtcNow
                }
            } finally {
                Remove-Event -EventIdentifier $eventRecord.EventIdentifier -ErrorAction SilentlyContinue
            }
        }
    }

    if ([DateTime]::UtcNow -ge $script:screenshotNextReconciliationUtc) {
        try {
            Reconcile-ScreenshotWatcher
        } catch {
            Stop-ScreenshotWatcher
            $script:screenshotWatcherState = [pscustomobject]@{
                state = "ERROR"
                message = "The screenshot folder could not be monitored."
            }
            $script:screenshotNextDiscoveryUtc = [DateTime]::UtcNow.AddSeconds($trackerDiscoveryIntervalSeconds)
            return
        }
    }

    $now = [DateTime]::UtcNow
    foreach ($fileName in @($script:screenshotPendingFiles.Keys)) {
        if (($now - $script:screenshotPendingFiles[$fileName]).TotalMilliseconds -lt $trackerDebounceMilliseconds) { continue }
        $script:screenshotPendingFiles.Remove($fileName)
        try {
            $filePath = Join-Path $script:screenshotWatcher.Path $fileName
            if ([IO.File]::Exists($filePath)) {
                $file = [IO.FileInfo]::new($filePath)
                $script:screenshotFingerprints[$fileName] = [pscustomobject]@{
                    fileName = $fileName
                    fingerprint = "$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
                    lastWriteUtc = $file.LastWriteTimeUtc
                }
            }
        } catch {
            # The filename-only event remains useful if the game has already moved the file.
        }
        Add-ScreenshotEvent -FileName $fileName
    }
}

function Get-ContentType {
    param([string]$Path)

    switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { return "text/html; charset=utf-8" }
        ".css" { return "text/css; charset=utf-8" }
        ".js" { return "text/javascript; charset=utf-8" }
        ".mjs" { return "text/javascript; charset=utf-8" }
        ".json" { return "application/json; charset=utf-8" }
        ".svg" { return "image/svg+xml; charset=utf-8" }
        ".png" { return "image/png" }
        ".webp" { return "image/webp" }
        ".jpg" { return "image/jpeg" }
        ".jpeg" { return "image/jpeg" }
        ".gif" { return "image/gif" }
        ".ico" { return "image/x-icon" }
        ".woff" { return "font/woff" }
        ".woff2" { return "font/woff2" }
        ".txt" { return "text/plain; charset=utf-8" }
        ".md" { return "text/markdown; charset=utf-8" }
        default { return "application/octet-stream" }
    }
}

function Read-RequestHeaders {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [int]$MaximumBytes = 16384,
        [int]$TimeoutMilliseconds = 5000
    )

    $buffer = New-Object byte[] $MaximumBytes
    $count = 0
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($count -lt $MaximumBytes) {
        $remaining = $TimeoutMilliseconds - [int]($stopwatch.ElapsedMilliseconds)
        if ($remaining -le 0) {
            throw [TimeoutException]::new("Timed out while reading request headers.")
        }
        if ($Stream.CanTimeout) {
            $Stream.ReadTimeout = [Math]::Max(1, $remaining)
        }
        try {
            $value = $Stream.ReadByte()
        } catch [IO.IOException] {
            throw [TimeoutException]::new("Timed out while reading request headers.", $_.Exception)
        }
        if ($value -lt 0) {
            return $null
        }
        $buffer[$count] = [byte]$value
        $count++
        if (
            $count -ge 4 -and
            $buffer[$count - 4] -eq 13 -and
            $buffer[$count - 3] -eq 10 -and
            $buffer[$count - 2] -eq 13 -and
            $buffer[$count - 1] -eq 10
        ) {
            return [Text.Encoding]::ASCII.GetString($buffer, 0, $count)
        }
    }

    throw [IO.InvalidDataException]::new("Request headers exceed $MaximumBytes bytes.")
}

function Read-RequestBody {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [ValidateRange(0, 8192)]
        [int]$Length
    )

    if ($Length -eq 0) { return New-Object byte[] 0 }
    $body = New-Object byte[] $Length
    $offset = 0
    while ($offset -lt $Length) {
        $read = $Stream.Read($body, $offset, $Length - $offset)
        if ($read -le 0) {
            throw [IO.EndOfStreamException]::new("The request body ended early.")
        }
        $offset += $read
    }
    return $body
}

function Send-Response {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$Reason,
        [Parameter(Mandatory = $true)]
        [string]$ContentType,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [byte[]]$Body,
        [switch]$HeadOnly,
        [string[]]$ExtraHeaders = @()
    )

    $securityHeaders = @(
        "X-Content-Type-Options: nosniff",
        "Cross-Origin-Resource-Policy: same-origin"
    )
    if ($ContentType.StartsWith("text/html", [StringComparison]::OrdinalIgnoreCase)) {
        $securityHeaders += @(
            "X-Frame-Options: DENY",
            "Content-Security-Policy: frame-ancestors 'none'"
        )
    }
    $headerLines = @(
        "HTTP/1.1 $StatusCode $Reason",
        "Content-Type: $ContentType",
        "Content-Length: $($Body.Length)",
        "Cache-Control: no-store",
        "Connection: close"
    ) + $securityHeaders + $ExtraHeaders
    $headerText = ($headerLines -join "`r`n") + "`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headerText)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
    $Stream.Flush()
}

function Send-TextResponse {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$Reason,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [switch]$HeadOnly,
        [string[]]$ExtraHeaders = @()
    )

    $body = [Text.Encoding]::UTF8.GetBytes($Message)
    Send-Response -Stream $Stream -StatusCode $StatusCode -Reason $Reason `
        -ContentType "text/plain; charset=utf-8" -Body $body -HeadOnly:$HeadOnly `
        -ExtraHeaders $ExtraHeaders
}

function Send-JsonResponse {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$Reason,
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [switch]$HeadOnly
    )

    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 8
    $body = [Text.Encoding]::UTF8.GetBytes($json)
    Send-Response -Stream $Stream -StatusCode $StatusCode -Reason $Reason `
        -ContentType "application/json; charset=utf-8" -Body $body -HeadOnly:$HeadOnly
}

function Get-QueryParameters {
    param([string]$RequestTarget)

    $result = @{}
    $queryIndex = $RequestTarget.IndexOf("?")
    if ($queryIndex -lt 0 -or $queryIndex -eq $RequestTarget.Length - 1) { return $result }

    foreach ($pair in $RequestTarget.Substring($queryIndex + 1).Split("&")) {
        if ([string]::IsNullOrEmpty($pair)) { continue }
        $separator = $pair.IndexOf("=")
        $rawName = if ($separator -lt 0) { $pair } else { $pair.Substring(0, $separator) }
        $rawValue = if ($separator -lt 0) { "" } else { $pair.Substring($separator + 1) }
        if ($rawName -match "%(?![0-9A-Fa-f]{2})" -or $rawValue -match "%(?![0-9A-Fa-f]{2})") {
            throw [ArgumentException]::new("Malformed query string.")
        }
        $name = [Uri]::UnescapeDataString($rawName.Replace("+", " "))
        $value = [Uri]::UnescapeDataString($rawValue.Replace("+", " "))
        if ($result.ContainsKey($name)) {
            throw [ArgumentException]::new("Duplicate query parameter.")
        }
        $result[$name] = $value
    }

    return $result
}

function Get-TrackerEventsPayload {
    param([string]$RequestTarget)

    $query = Get-QueryParameters -RequestTarget $RequestTarget
    foreach ($name in $query.Keys) {
        if ($name -ne "afterCursor" -and $name -ne "pageSize") {
            throw [ArgumentException]::new("Unknown query parameter.")
        }
    }

    $afterCursor = [long]0
    if ($query.ContainsKey("afterCursor")) {
        if ($query["afterCursor"] -notmatch "^\d{1,19}$" -or -not [long]::TryParse($query["afterCursor"], [ref]$afterCursor)) {
            throw [ArgumentException]::new("afterCursor must be a non-negative integer.")
        }
    }

    $pageSize = 50
    if ($query.ContainsKey("pageSize")) {
        if ($query["pageSize"] -notmatch "^\d{1,3}$" -or -not [int]::TryParse($query["pageSize"], [ref]$pageSize)) {
            throw [ArgumentException]::new("pageSize must be an integer.")
        }
    }
    if ($pageSize -lt 1 -or $pageSize -gt 100) {
        throw [ArgumentException]::new("pageSize must be between 1 and 100.")
    }
    if ($afterCursor -gt $script:trackerLatestCursor) {
        throw [ArgumentException]::new("afterCursor is ahead of the latest cursor.")
    }

    $earliestSequence = if ($script:trackerEvents.Count -gt 0) {
        [long]$script:trackerEvents[0].sequence
    } else {
        $script:trackerLatestCursor + 1
    }
    $isResetRequired = $script:trackerEvents.Count -gt 0 -and $afterCursor -lt ($earliestSequence - 1)
    $available = @($script:trackerEvents | Where-Object { [long]$_.sequence -gt $afterCursor })
    $data = @($available | Select-Object -First $pageSize)
    $nextCursor = if ($data.Count -gt 0) { [long]$data[$data.Count - 1].sequence } else { $afterCursor }

    return [pscustomobject]@{
        protocolVersion = $trackerProtocolVersion
        data = $data
        pagination = [pscustomobject]@{
            afterCursor = $afterCursor
            nextCursor = $nextCursor
            hasMore = $available.Count -gt $data.Count
            isResetRequired = [bool]$isResetRequired
        }
    }
}

function Initialize-StateDirectory {
    try {
        $normalized = [IO.Path]::GetFullPath($StateDirectory)
        [IO.Directory]::CreateDirectory($normalized) | Out-Null
        return $normalized
    } catch {
        throw [IO.IOException]::new("The local runtime directory could not be created.", $_.Exception)
    }
}

function Write-PortableLog {
    param([string]$Message)

    try {
        $directory = Initialize-StateDirectory
        $logPath = Join-Path $directory "server.log"
        if ([IO.File]::Exists($logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1048576) {
            $previousLog = Join-Path $directory "server.previous.log"
            if ([IO.File]::Exists($previousLog)) { Remove-Item -LiteralPath $previousLog -Force }
            Move-Item -LiteralPath $logPath -Destination $previousLog
        }
        $line = "{0} {1}{2}" -f [DateTime]::UtcNow.ToString("o"), $Message, [Environment]::NewLine
        [IO.File]::AppendAllText($logPath, $line, [Text.Encoding]::UTF8)
    } catch {
        # Logging must not prevent startup or shutdown.
    }
}

function Get-RandomToken {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-InstancePath {
    return Join-Path (Initialize-StateDirectory) "instance.json"
}

function Get-ConfigPath {
    return Join-Path (Initialize-StateDirectory) "config.json"
}

function Read-PortableConfig {
    try {
        $configPath = Get-ConfigPath
        if (-not [IO.File]::Exists($configPath)) { return $null }
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (
            $null -eq $config -or
            $config.protocolVersion -ne 1 -or
            $config.screenshotFolder -isnot [string] -or
            [string]::IsNullOrWhiteSpace($config.screenshotFolder)
        ) {
            return $null
        }
        $normalized = [IO.Path]::GetFullPath([string]($config.screenshotFolder))
        return [pscustomobject]@{
            protocolVersion = 1
            screenshotFolder = $normalized
        }
    } catch {
        return $null
    }
}

function Write-PortableConfig {
    param([Parameter(Mandatory = $true)][string]$ScreenshotFolderPath)

    $configPath = Get-ConfigPath
    $temporaryPath = "$configPath.$PID.tmp"
    $value = [pscustomobject]@{
        protocolVersion = 1
        screenshotFolder = [IO.Path]::GetFullPath($ScreenshotFolderPath)
    }
    $json = ConvertTo-Json -InputObject $value -Compress
    $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temporaryPath, $json, $utf8WithoutBom)
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
}

function Read-PortableInstance {
    try {
        $instancePath = Get-InstancePath
        if (-not [IO.File]::Exists($instancePath)) { return $null }
        $instance = Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (
            $null -eq $instance -or
            $instance.protocolVersion -ne 1 -or
            $instance.pid -isnot [int] -or
            $instance.port -isnot [int] -or
            $instance.port -lt 1 -or
            $instance.port -gt 65535 -or
            $instance.controlToken -isnot [string] -or
            $instance.controlToken -notmatch "^[A-Za-z0-9_-]{40,}$" -or
            $instance.buildIdentity -isnot [string] -or
            $instance.buildIdentity -notmatch "^[0-9a-f:]{64,129}$" -or
            $instance.rootPath -isnot [string] -or
            [string]::IsNullOrWhiteSpace($instance.rootPath) -or
            $instance.processStartTimeUtc -isnot [string] -or
            [string]::IsNullOrWhiteSpace($instance.processStartTimeUtc)
        ) {
            return $null
        }
        return $instance
    } catch {
        return $null
    }
}

function Get-AppBuildIdentity {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    $normalizedRoot = [IO.Path]::GetFullPath($AppRoot)
    $index = Join-Path $normalizedRoot "index.html"
    if (-not [IO.File]::Exists($index)) {
        throw [IO.FileNotFoundException]::new("The app directory must contain index.html.", $index)
    }

    $appIdentity = $null
    $packageInfoPath = Join-Path (Split-Path -Parent $normalizedRoot) "PACKAGE_INFO.txt"
    if ([IO.File]::Exists($packageInfoPath)) {
        $packageInfo = Get-Content -LiteralPath $packageInfoPath -Raw
        $treeHashMatch = [Text.RegularExpressions.Regex]::Match(
            $packageInfo,
            "(?m)^App tree SHA-256: ([0-9a-f]{64})$"
        )
        if ($treeHashMatch.Success) {
            $appIdentity = $treeHashMatch.Groups[1].Value
        }
    }

    if ([string]::IsNullOrWhiteSpace($appIdentity)) {
        $identityHashes = @((Get-FileHash -LiteralPath $index -Algorithm SHA256).Hash.ToLowerInvariant())
        $dataPath = Join-Path $normalizedRoot "data\tarkov-data.json"
        if ([IO.File]::Exists($dataPath)) {
            $identityHashes += (Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $appIdentity = $identityHashes -join ":"
    }

    $launcherIdentity = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $identityHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $combinedIdentity = $identityHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($appIdentity + ":" + $launcherIdentity))
    } finally {
        $identityHasher.Dispose()
    }
    return ([BitConverter]::ToString($combinedIdentity)).Replace("-", "").ToLowerInvariant()
}

function Write-PortableInstance {
    param([Parameter(Mandatory = $true)][object]$Instance)

    $instancePath = Get-InstancePath
    $temporaryPath = "$instancePath.$PID.tmp"
    $json = ConvertTo-Json -InputObject $Instance -Compress -Depth 5
    $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temporaryPath, $json, $utf8WithoutBom)
    Move-Item -LiteralPath $temporaryPath -Destination $instancePath -Force
}

function Remove-OwnedInstance {
    param([int]$ProcessId, [string]$ControlToken)

    try {
        $instancePath = Get-InstancePath
        $instance = Read-PortableInstance
        if ($null -ne $instance -and $instance.pid -eq $ProcessId -and $instance.controlToken -eq $ControlToken) {
            Remove-Item -LiteralPath $instancePath -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # A stale state file is safer than deleting an unverified one.
    }
}

function Get-StateMutexName {
    param([string]$Purpose)

    $normalized = [IO.Path]::GetFullPath($StateDirectory).ToUpperInvariant()
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))
    } finally {
        $hasher.Dispose()
    }
    $suffix = ([BitConverter]::ToString($hash, 0, 12)).Replace("-", "")
    return "Local\TarkovHelperWeb$Purpose$suffix"
}

function Invoke-PortableLoopbackRequest {
    param(
        [ValidateRange(1, 65535)]
        [int]$RequestPort,
        [ValidateSet("GET", "POST")]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$RequestPath,
        [Parameter(Mandatory = $true)]
        [string]$ControlToken,
        [ValidateRange(100, 10000)]
        [int]$TimeoutMilliseconds = 2000
    )

    if (-not $RequestPath.StartsWith("/")) {
        throw [ArgumentException]::new("The loopback request path must be absolute.")
    }

    $origin = "http://127.0.0.1:$RequestPort"
    $request = [Net.HttpWebRequest]::Create([Uri]::new($origin + $RequestPath))
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.Method = $Method
    $request.Headers["X-Tarkov-Control"] = $ControlToken
    $request.ServicePoint.Expect100Continue = $false

    if ($Method -eq "POST") {
        $body = [Text.Encoding]::UTF8.GetBytes("{}")
        $request.ContentType = "application/json"
        $request.ContentLength = $body.Length
        $request.Headers["Origin"] = $origin
        $requestStream = $request.GetRequestStream()
        try {
            $requestStream.Write($body, 0, $body.Length)
        } finally {
            $requestStream.Dispose()
        }
    }

    $response = $null
    $responseStream = $null
    $memory = [IO.MemoryStream]::new()
    try {
        $response = [Net.HttpWebResponse]$request.GetResponse()
        if ($response.ContentLength -gt 8192) {
            throw [IO.InvalidDataException]::new("The loopback response is too large.")
        }
        $responseStream = $response.GetResponseStream()
        $buffer = New-Object byte[] 1024
        while ($true) {
            $read = $responseStream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            if (($memory.Length + $read) -gt 8192) {
                throw [IO.InvalidDataException]::new("The loopback response is too large.")
            }
            $memory.Write($buffer, 0, $read)
        }
        return [pscustomobject]@{
            StatusCode = [int]($response.StatusCode)
            Body = [Text.Encoding]::UTF8.GetString($memory.ToArray())
        }
    } finally {
        if ($null -ne $responseStream) { $responseStream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $memory.Dispose()
    }
}

function Test-PortableInstance {
    param([object]$Instance)

    if (-not (Test-RecordedProcessIdentity -Instance $Instance)) { return $false }
    try {
        $process = Get-Process -Id ([int]($Instance.pid)) -ErrorAction Stop
        if ($process.HasExited) { return $false }
        $response = Invoke-PortableLoopbackRequest -RequestPort ([int]($Instance.port)) `
            -Method "GET" -RequestPath $healthPath -ControlToken ([string]($Instance.controlToken))
        $expectedHealth = "tarkov-helper-web-portable-v1:$($Instance.buildIdentity):authenticated"
        return $response.StatusCode -eq 200 -and $response.Body.Equals($expectedHealth, [StringComparison]::Ordinal)
    } catch {
        return $false
    }
}

function Test-RecordedProcessIdentity {
    param([object]$Instance)

    if ($null -eq $Instance) { return $false }
    try {
        $process = Get-Process -Id ([int]($Instance.pid)) -ErrorAction Stop
        if ($process.HasExited) { return $false }
        $recordedStart = [DateTime]::Parse(
            [string]($Instance.processStartTimeUtc),
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        ).ToUniversalTime()
        $actualStart = $process.StartTime.ToUniversalTime()
        return [Math]::Abs(($actualStart - $recordedStart).TotalMilliseconds) -lt 1000
    } catch {
        return $false
    }
}

function Open-PortableBrowser {
    param([string]$Url)

    if ($NoBrowser) { return }
    try {
        [Diagnostics.Process]::Start($Url) | Out-Null
    } catch {
        Write-PortableLog "The default browser could not be opened."
    }
}

function ConvertTo-ProcessArgument {
    param([string]$Value)

    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $builder = [Text.StringBuilder]::new()
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            $null = $builder.Append([string]::new([char]92, (($backslashes * 2) + 1)))
            $null = $builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            $null = $builder.Append([string]::new([char]92, $backslashes))
            $backslashes = 0
        }
        $null = $builder.Append($character)
    }
    if ($backslashes -gt 0) {
        $null = $builder.Append([string]::new([char]92, ($backslashes * 2)))
    }
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Stop-SpawnedPortableChild {
    param([Diagnostics.Process]$Process)

    if ($null -eq $Process) { return }
    try {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            $Process.Kill()
            $null = $Process.WaitForExit(5000)
        }
    } catch {
        Write-PortableLog "A failed background server child could not be terminated."
    }

    try {
        $instance = Read-PortableInstance
        if (
            $null -ne $instance -and
            $instance.pid -eq $Process.Id -and
            -not (Test-RecordedProcessIdentity -Instance $instance)
        ) {
            Remove-OwnedInstance -ProcessId ([int]($instance.pid)) -ControlToken ([string]($instance.controlToken))
        }
    } catch {
        # Preserve any state that cannot be tied safely to the failed child.
    }
}

function Start-PortableBroker {
    $mutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Control"))
    $hasMutex = $false
    $child = $null
    $keepChild = $false
    try {
        try {
            $hasMutex = $mutex.WaitOne(10000)
        } catch [Threading.AbandonedMutexException] {
            $hasMutex = $true
        }
        if (-not $hasMutex) {
            [Console]::Error.WriteLine("Tarkov Helper startup is already in progress.")
            return 2
        }

        $expectedRootPath = [IO.Path]::GetFullPath($Root)
        $expectedBuildIdentity = Get-AppBuildIdentity -AppRoot $expectedRootPath
        $instancePath = Get-InstancePath
        $stateExists = [IO.File]::Exists($instancePath)
        $existing = Read-PortableInstance
        if ($stateExists -and $null -eq $existing) {
            [Console]::Error.WriteLine("The Tarkov Helper instance state is invalid and was preserved; startup cannot continue safely.")
            return 2
        }
        if ($null -ne $existing -and (Test-RecordedProcessIdentity -Instance $existing)) {
            $isAuthenticated = $false
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                if (Test-PortableInstance -Instance $existing) {
                    $isAuthenticated = $true
                    break
                }
                if ($attempt -lt 3) { Start-Sleep -Milliseconds 200 }
            }
            if (-not $isAuthenticated) {
                [Console]::Error.WriteLine("The running Tarkov Helper instance could not be authenticated. Its state was preserved; try again or use Tarkov Helper Stop before restarting.")
                return 2
            }

            $existingRootPath = [string]($existing.rootPath)
            if (
                $existing.buildIdentity -cne $expectedBuildIdentity -or
                -not $existingRootPath.Equals($expectedRootPath, [StringComparison]::OrdinalIgnoreCase)
            ) {
                [Console]::Error.WriteLine("A different Tarkov Helper build is already running. Use Tarkov Helper Stop, then restart this build.")
                return 2
            }
            $existingUrl = "http://127.0.0.1:$($existing.port)/"
            [Console]::Out.WriteLine("TARKOV_HELPER_URL=$existingUrl")
            [Console]::Out.WriteLine("Tarkov Helper is already running.")
            Open-PortableBrowser -Url $existingUrl
            return 0
        }

        if ($null -ne $existing -and -not (Test-RecordedProcessIdentity -Instance $existing)) {
            Remove-Item -LiteralPath $instancePath -Force -ErrorAction SilentlyContinue
        }

        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not [IO.File]::Exists($powershellPath)) { $powershellPath = "powershell.exe" }
        $serveArguments = @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", $PSCommandPath,
            "-Action", "Serve",
            "-Root", $Root,
            "-Port", [string]$Port,
            "-NoBrowser",
            "-StateDirectory", $StateDirectory
        )
        if (-not [string]::IsNullOrWhiteSpace($ScreenshotFolder)) {
            $serveArguments += @("-ScreenshotFolder", $ScreenshotFolder)
        }
        $argumentLine = ($serveArguments | ForEach-Object { ConvertTo-ProcessArgument -Value ([string]$_) }) -join " "
        $directory = Initialize-StateDirectory
        $serveOut = Join-Path $directory "server.stdout.log"
        $serveError = Join-Path $directory "server.stderr.log"
        $child = Start-Process -FilePath $powershellPath -ArgumentList $argumentLine `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $serveOut -RedirectStandardError $serveError

        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 100
            $instance = Read-PortableInstance
            if (
                $null -ne $instance -and
                $instance.pid -eq $child.Id -and
                $instance.buildIdentity -ceq $expectedBuildIdentity -and
                ([string]($instance.rootPath)).Equals($expectedRootPath, [StringComparison]::OrdinalIgnoreCase) -and
                (Test-PortableInstance -Instance $instance)
            ) {
                $url = "http://127.0.0.1:$($instance.port)/"
                $keepChild = $true
                [Console]::Out.WriteLine("TARKOV_HELPER_URL=$url")
                [Console]::Out.WriteLine("Tarkov Helper started in the background.")
                Open-PortableBrowser -Url $url
                return 0
            }
            if ($child.HasExited) { break }
        }

        [Console]::Error.WriteLine("Tarkov Helper could not start. See server.log in the local runtime directory.")
        Write-PortableLog "Background server startup failed."
        return 2
    } catch {
        [Console]::Error.WriteLine("Tarkov Helper could not start.")
        Write-PortableLog "Background server startup failed: $($_.Exception.GetType().Name)"
        return 2
    } finally {
        if ($null -ne $child -and -not $keepChild) {
            Stop-SpawnedPortableChild -Process $child
        }
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Stop-PortableBroker {
    $mutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Control"))
    $hasMutex = $false
    try {
        try {
            $hasMutex = $mutex.WaitOne(15000)
        } catch [Threading.AbandonedMutexException] {
            $hasMutex = $true
        }
        if (-not $hasMutex) {
            [Console]::Error.WriteLine("Tarkov Helper startup or shutdown is already in progress.")
            return 2
        }

        $instancePath = Get-InstancePath
        $stateExists = [IO.File]::Exists($instancePath)
        $instance = Read-PortableInstance
        if ($null -eq $instance) {
            if ($stateExists) {
                [Console]::Error.WriteLine("The Tarkov Helper instance state is invalid and was preserved; it cannot be authenticated safely.")
                return 2
            }
            return 0
        }

        try {
            $response = Invoke-PortableLoopbackRequest -RequestPort ([int]($instance.port)) `
                -Method "POST" -RequestPath "/api/v1/control/shutdown" `
                -ControlToken ([string]($instance.controlToken)) -TimeoutMilliseconds 3000
            if ($response.StatusCode -ne 204) { throw "Unexpected shutdown response." }

            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ([DateTime]::UtcNow -lt $deadline) {
                if (-not (Test-RecordedProcessIdentity -Instance $instance)) {
                    Remove-OwnedInstance -ProcessId ([int]($instance.pid)) -ControlToken ([string]($instance.controlToken))
                    return 0
                }
                Start-Sleep -Milliseconds 100
            }
            [Console]::Error.WriteLine("Tarkov Helper did not stop in time.")
            return 2
        } catch {
            if (-not (Test-RecordedProcessIdentity -Instance $instance)) {
                Remove-OwnedInstance -ProcessId ([int]($instance.pid)) -ControlToken ([string]($instance.controlToken))
                return 0
            }
            [Console]::Error.WriteLine("The recorded Tarkov Helper instance could not be authenticated and was not terminated: $($_.Exception.Message)")
            return 2
        }
    } finally {
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($Action -eq "Start") {
    exit (Start-PortableBroker)
}
if ($Action -eq "Stop") {
    exit (Stop-PortableBroker)
}

try {
    $rootPath = [IO.Path]::GetFullPath($Root)
} catch {
    [Console]::Error.WriteLine("Invalid app directory: $Root")
    exit 2
}

$indexPath = Join-Path $rootPath "index.html"
if (-not [IO.File]::Exists($indexPath)) {
    [Console]::Error.WriteLine("The app directory must contain index.html: $rootPath")
    exit 2
}

$buildIdentity = Get-AppBuildIdentity -AppRoot $rootPath
$healthResponse = "tarkov-helper-web-portable-v1:$buildIdentity"
$controlToken = Get-RandomToken

$serveMutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Serve"))
$hasServeMutex = $false
try {
    try {
        $hasServeMutex = $serveMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $hasServeMutex = $true
    }
    if (-not $hasServeMutex) {
        $existing = Read-PortableInstance
        if (
            $Port -ne 0 -and
            $null -ne $existing -and
            $existing.port -eq $Port -and
            $existing.buildIdentity -ceq $buildIdentity -and
            ([string]($existing.rootPath)).Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -and
            (Test-PortableInstance -Instance $existing)
        ) {
            $existingUrl = "http://127.0.0.1:$Port/"
            [Console]::Out.WriteLine("TARKOV_HELPER_URL=$existingUrl")
            [Console]::Out.WriteLine("Tarkov Helper is already running.")
            [Console]::Out.Flush()
            Open-PortableBrowser -Url $existingUrl
            exit 0
        }
        [Console]::Error.WriteLine("Another Tarkov Helper server already owns this local runtime state.")
        exit 2
    }
} catch {
    if ($hasServeMutex) { $serveMutex.ReleaseMutex() }
    $serveMutex.Dispose()
    throw
}

$rootPrefix = $rootPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$handledRequests = 0
$shutdownRequested = $false
$ownsInstanceState = $false

try {
    try {
        $listener.Start()
    } catch [Net.Sockets.SocketException] {
        if ($Port -eq 0) {
            throw
        }

        $existingUrl = "http://127.0.0.1:$Port/"
        $existingServerMatches = $false
        $reuseFailure = "The listener could not be authenticated."
        try {
            $existing = Read-PortableInstance
            if ($null -eq $existing) { throw "No valid instance state was found." }
            if ($existing.port -ne $Port) { throw "The recorded instance uses a different port." }
            if ($existing.buildIdentity -cne $buildIdentity) { throw "The recorded instance uses a different build." }
            if (-not ([string]($existing.rootPath)).Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
                throw "The recorded instance uses a different app directory (recorded '$([string]($existing.rootPath))', requested '$rootPath')."
            }
            if (-not (Test-PortableInstance -Instance $existing)) { throw "The recorded process or authenticated health check did not match." }
            $existingServerMatches = $true
        } catch {
            $reuseFailure = $_.Exception.Message
            $existingServerMatches = $false
        }
        if (-not $existingServerMatches) {
            [Console]::Error.WriteLine("Local port $Port is already used by another program.")
            [Console]::Error.WriteLine("Close that program and run Tarkov Helper again.")
            [Console]::Error.WriteLine("Details: $reuseFailure")
            exit 2
        }
        [Console]::Out.WriteLine("TARKOV_HELPER_URL=$existingUrl")
        [Console]::Out.WriteLine("Tarkov Helper is already running.")
        [Console]::Out.Flush()
        Open-PortableBrowser -Url $existingUrl
        exit 0
    }
    $boundPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $url = "http://127.0.0.1:$boundPort/"

    try {
        $processStartTime = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        Write-PortableInstance -Instance ([pscustomobject]@{
            protocolVersion = 1
            pid = $PID
            processStartTimeUtc = $processStartTime
            port = $boundPort
            controlToken = $controlToken
            buildIdentity = $buildIdentity
            rootPath = $rootPath
            startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        })
        $ownsInstanceState = $true
        Write-PortableLog "Server started on loopback port $boundPort."
    } catch {
        [Console]::Error.WriteLine("The local runtime state could not be written.")
        Write-PortableLog "Runtime state initialization failed."
        exit 2
    }

    Start-ScreenshotWatcher

    [Console]::Out.WriteLine("TARKOV_HELPER_URL=$url")
    [Console]::Out.WriteLine("Tarkov Helper is running locally.")
    [Console]::Out.WriteLine("Keep this window open. Press Ctrl+C to stop.")
    [Console]::Out.Flush()

    Open-PortableBrowser -Url $url

    while (-not $shutdownRequested -and ($MaxRequests -eq 0 -or $handledRequests -lt $MaxRequests)) {
        while (-not $listener.Pending()) {
            Update-ScreenshotWatcher
            Start-Sleep -Milliseconds 100
        }
        $client = $listener.AcceptTcpClient()
        $stream = $null
        try {
            $client.ReceiveTimeout = 10000
            $client.SendTimeout = 10000
            $stream = $client.GetStream()
            try {
                $requestHeaders = Read-RequestHeaders -Stream $stream
            } catch [IO.InvalidDataException] {
                Send-TextResponse -Stream $stream -StatusCode 431 -Reason "Request Header Fields Too Large" -Message "Request Header Fields Too Large"
                continue
            } catch [TimeoutException] {
                Send-TextResponse -Stream $stream -StatusCode 408 -Reason "Request Timeout" -Message "Request Timeout"
                continue
            }

            if ($null -eq $requestHeaders) {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                continue
            }

            $requestLines = $requestHeaders.Split(@("`r`n"), [StringSplitOptions]::None)
            $requestLine = $requestLines[0]
            if ([string]::IsNullOrWhiteSpace($requestLine) -or $requestLine.Length -gt 8192) {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                continue
            }

            $hostHeaders = @()
            $originHeaders = @()
            $controlHeaders = @()
            $contentLengthHeaders = @()
            $contentTypeHeaders = @()
            $transferEncodingHeaders = @()
            $malformedHeader = $false
            for ($index = 1; $index -lt $requestLines.Length; $index++) {
                $headerLine = $requestLines[$index]
                if ($headerLine.Length -eq 0) { break }
                $separator = $headerLine.IndexOf(":")
                if ($separator -le 0) {
                    $malformedHeader = $true
                    break
                }
                $headerName = $headerLine.Substring(0, $separator).Trim()
                $headerValue = $headerLine.Substring($separator + 1).Trim()
                if ($headerName.Equals("Host", [StringComparison]::OrdinalIgnoreCase)) {
                    $hostHeaders += $headerValue
                }
                if ($headerName.Equals("Origin", [StringComparison]::OrdinalIgnoreCase)) {
                    $originHeaders += $headerValue
                }
                if ($headerName.Equals("X-Tarkov-Control", [StringComparison]::OrdinalIgnoreCase)) {
                    $controlHeaders += $headerValue
                }
                if ($headerName.Equals("Content-Length", [StringComparison]::OrdinalIgnoreCase)) {
                    $contentLengthHeaders += $headerValue
                }
                if ($headerName.Equals("Content-Type", [StringComparison]::OrdinalIgnoreCase)) {
                    $contentTypeHeaders += $headerValue
                }
                if ($headerName.Equals("Transfer-Encoding", [StringComparison]::OrdinalIgnoreCase)) {
                    $transferEncodingHeaders += $headerValue
                }
            }

            if ($malformedHeader) {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                continue
            }

            $expectedHost = "127.0.0.1:$boundPort"
            if ($hostHeaders.Count -ne 1 -or $hostHeaders[0] -ne $expectedHost) {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                continue
            }

            $requestParts = $requestLine.Split(" ")
            if ($requestParts.Length -ne 3) {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                continue
            }

            $method = $requestParts[0].ToUpperInvariant()
            $requestTarget = $requestParts[1]
            $headOnly = $method -eq "HEAD"
            $requestPath = $requestTarget.Split("?", 2)[0]

            if ($method -eq "POST" -and $requestPath -eq "/api/v1/control/shutdown") {
                $contentLength = 0
                if (
                    $transferEncodingHeaders.Count -ne 0 -or
                    $contentLengthHeaders.Count -gt 1 -or
                    ($contentLengthHeaders.Count -eq 1 -and (
                        $contentLengthHeaders[0] -notmatch "^\d{1,5}$" -or
                        -not [int]::TryParse($contentLengthHeaders[0], [ref]$contentLength)
                    ))
                ) {
                    Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                    continue
                }
                if ($contentLength -gt 8192) {
                    Send-TextResponse -Stream $stream -StatusCode 413 -Reason "Content Too Large" -Message "Content Too Large"
                    continue
                }
                if (
                    $contentLength -gt 0 -and
                    ($contentTypeHeaders.Count -ne 1 -or -not $contentTypeHeaders[0].StartsWith("application/json", [StringComparison]::OrdinalIgnoreCase))
                ) {
                    Send-TextResponse -Stream $stream -StatusCode 415 -Reason "Unsupported Media Type" -Message "Unsupported Media Type"
                    continue
                }
                try {
                    $null = Read-RequestBody -Stream $stream -Length $contentLength
                } catch {
                    Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request"
                    continue
                }
                $expectedOrigin = "http://127.0.0.1:$boundPort"
                if (
                    $originHeaders.Count -ne 1 -or
                    $originHeaders[0] -ne $expectedOrigin -or
                    $controlHeaders.Count -ne 1 -or
                    $controlHeaders[0] -cne $controlToken
                ) {
                    Send-TextResponse -Stream $stream -StatusCode 403 -Reason "Forbidden" -Message "Forbidden"
                    continue
                }

                Send-Response -Stream $stream -StatusCode 204 -Reason "No Content" `
                    -ContentType "application/json; charset=utf-8" -Body (New-Object byte[] 0)
                $shutdownRequested = $true
                continue
            }
            if ($method -ne "GET" -and -not $headOnly) {
                Send-TextResponse -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                    -Message "Method Not Allowed" -ExtraHeaders @("Allow: GET, HEAD")
                continue
            }

            if ($requestPath -eq "/api/v1/local-tracker/status") {
                Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -HeadOnly:$headOnly -Value ([pscustomobject]@{
                    protocolVersion = $trackerProtocolVersion
                    screenshotWatcher = $script:screenshotWatcherState
                    latestCursor = $script:trackerLatestCursor
                })
                continue
            }
            if ($requestPath -eq "/api/v1/local-tracker/events") {
                try {
                    $eventsPayload = Get-TrackerEventsPayload -RequestTarget $requestTarget
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -HeadOnly:$headOnly -Value $eventsPayload
                } catch [ArgumentException] {
                    Send-JsonResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -HeadOnly:$headOnly -Value ([pscustomobject]@{
                        error = [pscustomobject]@{
                            code = "INVALID_QUERY"
                            message = $_.Exception.Message
                        }
                    })
                }
                continue
            }
            if ($requestPath -eq $healthPath) {
                $healthBody = if ($controlHeaders.Count -eq 1 -and $controlHeaders[0] -ceq $controlToken) {
                    "$healthResponse`:authenticated"
                } else {
                    $healthResponse
                }
                Send-TextResponse -Stream $stream -StatusCode 200 -Reason "OK" `
                    -Message $healthBody -HeadOnly:$headOnly
                continue
            }

            if (-not $requestTarget.StartsWith("/")) {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request" -HeadOnly:$headOnly
                continue
            }

            $encodedPath = $requestPath
            try {
                if ($encodedPath -match "%(?![0-9A-Fa-f]{2})") {
                    throw "Malformed percent escape"
                }
                $decodedPath = [Uri]::UnescapeDataString($encodedPath)
                if (
                    $decodedPath.IndexOf([char]0) -ge 0 -or
                    $decodedPath.Contains("\") -or
                    $decodedPath.Contains(":")
                ) {
                    throw "Unsupported path character"
                }
                $relativePath = $decodedPath.TrimStart("/".ToCharArray())
                if ([string]::IsNullOrEmpty($relativePath)) {
                    $relativePath = "index.html"
                }
                $relativePath = $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
                $candidatePath = [IO.Path]::GetFullPath((Join-Path $rootPath $relativePath))
            } catch {
                Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Bad Request" -HeadOnly:$headOnly
                continue
            }

            if (-not $candidatePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                Send-TextResponse -Stream $stream -StatusCode 403 -Reason "Forbidden" -Message "Forbidden" -HeadOnly:$headOnly
                continue
            }

            if (-not [IO.File]::Exists($candidatePath)) {
                Send-TextResponse -Stream $stream -StatusCode 404 -Reason "Not Found" -Message "Not Found" -HeadOnly:$headOnly
                continue
            }

            $body = [IO.File]::ReadAllBytes($candidatePath)
            Send-Response -Stream $stream -StatusCode 200 -Reason "OK" `
                -ContentType (Get-ContentType -Path $candidatePath) -Body $body -HeadOnly:$headOnly
        } catch {
            try {
                if ($null -ne $stream -and $stream.CanWrite) {
                    Send-TextResponse -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Message "Internal Server Error"
                }
            } catch {
                # The client may already have disconnected.
            }
        } finally {
            $client.Dispose()
            $handledRequests++
            Update-ScreenshotWatcher
        }
    }
} finally {
    Stop-ScreenshotWatcher
    $listener.Stop()
    if ($ownsInstanceState) {
        Remove-OwnedInstance -ProcessId $PID -ControlToken $controlToken
        Write-PortableLog "Server stopped."
    }
    if ($hasServeMutex) { $serveMutex.ReleaseMutex() }
    $serveMutex.Dispose()
}
