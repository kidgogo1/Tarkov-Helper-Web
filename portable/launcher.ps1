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
$nativeOverlayProtocolVersion = 1
$nativeOverlayWindowTitle = "Tarkov Helper Web"
$nativeOverlayClaimLifetimeSeconds = 15
$nativeOverlayMinimumSize = 240
$nativeOverlayMaximumSize = 1000
$nativeOverlayClaims = @{}
$nativeOverlayRecord = $null
$nativeOverlayNextReconciliationUtc = [DateTime]::MinValue

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

function Send-JsonError {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$Reason,
        [Parameter(Mandatory = $true)]
        [string]$Code,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Send-JsonResponse -Stream $Stream -StatusCode $StatusCode -Reason $Reason -Value ([pscustomobject]@{
        error = [pscustomobject]@{
            code = $Code
            message = $Message
        }
    })
}

function Read-JsonRequestObject {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ContentLengthHeaders,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ContentTypeHeaders,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$TransferEncodingHeaders
    )

    $contentLength = 0
    if (
        $TransferEncodingHeaders.Count -ne 0 -or
        $ContentLengthHeaders.Count -ne 1 -or
        $ContentLengthHeaders[0] -notmatch "^\d{1,4}$" -or
        -not [int]::TryParse([string]($ContentLengthHeaders[0]), [ref]$contentLength) -or
        $contentLength -lt 2 -or
        $contentLength -gt 8192 -or
        $ContentTypeHeaders.Count -ne 1 -or
        [string]($ContentTypeHeaders[0]) -notmatch "(?i)^application/json(?:\s*;\s*charset=utf-8)?$"
    ) {
        throw [IO.InvalidDataException]::new("A bounded application/json request body is required.")
    }

    $bytes = Read-RequestBody -Stream $Stream -Length $contentLength
    try {
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $json = $strictUtf8.GetString($bytes)
        $value = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    } catch {
        throw [IO.InvalidDataException]::new("The JSON request body is malformed.", $_.Exception)
    }
    if ($null -eq $value -or $value -isnot [pscustomobject]) {
        throw [IO.InvalidDataException]::new("The JSON request body must be an object.")
    }
    return $value
}

function Assert-JsonObjectShape {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Value,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$AllowedProperties,
        [AllowEmptyCollection()]
        [string[]]$RequiredProperties = @()
    )

    $properties = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($property in $properties) {
        if ($AllowedProperties -notcontains $property) {
            throw [ArgumentException]::new("The request contains an unsupported property.")
        }
    }
    foreach ($property in $RequiredProperties) {
        if ($properties -notcontains $property) {
            throw [ArgumentException]::new("The request is missing a required property.")
        }
    }
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

function Initialize-NativeOverlayBridge {
    if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
        throw [PlatformNotSupportedException]::new("Native overlays are available only on Windows.")
    }
    if ($null -ne ("TarkovHelper.NativeOverlayBridge" -as [type])) {
        [TarkovHelper.NativeOverlayBridge]::EnablePerMonitorDpiAwareness()
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace TarkovHelper {
    public sealed class NativeWindowInfo {
        public long Handle { get; set; }
        public int ProcessId { get; set; }
        public string Title { get; set; }
        public string ClassName { get; set; }
        public long Style { get; set; }
        public long ExStyle { get; set; }
        public int Left { get; set; }
        public int Top { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool IsVisible { get; set; }
    }

    public sealed class NativeContentInfo {
        public int Left { get; set; }
        public int Top { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
    }

    public sealed class NativePointInfo {
        public int X { get; set; }
        public int Y { get; set; }
    }

    public sealed class NativeHotKeyEvent {
        public long Cursor { get; set; }
        public string Action { get; set; }
    }

    public sealed class NativeHotKeyEventsPayload {
        public long LatestCursor { get; set; }
        public NativeHotKeyEvent[] Events { get; set; }
    }

    public static class NativeOverlayBridge {
        private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
        private delegate bool EnumChildWindowsProc(IntPtr window, IntPtr parameter);

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct MonitorInfo {
            public int Size;
            public Rect Monitor;
            public Rect Work;
            public uint Flags;
        }

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr parent, EnumChildWindowsProc callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumCount);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumCount);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
        private static extern int GetWindowLong32(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
        private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
        private static extern int SetWindowLong32(IntPtr window, int index, int value);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
        [DllImport("kernel32.dll")]
        private static extern void SetLastError(uint errorCode);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr window,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags
        );
        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowRgn(IntPtr window, IntPtr region);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern uint GetRegionData(IntPtr region, uint length, byte[] data);
        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern int GetRgnBox(IntPtr region, out Rect rect);
        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr ExtCreateRegion(IntPtr transform, uint length, byte[] data);
        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr value);
        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo information);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr window, int identifier, uint modifiers, uint virtualKey);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr window, int identifier);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetMessage(out NativeMessage message, IntPtr window, uint minimum, uint maximum);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeMessage {
            public IntPtr Window;
            public uint Message;
            public IntPtr WParam;
            public IntPtr LParam;
            public uint Time;
            public int X;
            public int Y;
            public uint Private;
        }

        private const int StyleIndex = -16;
        private const int ExStyleIndex = -20;
        private const uint FrameChanged = 0x0020;
        private const uint ShowWindow = 0x0040;
        private const uint NoActivate = 0x0010;
        private const long WindowEdge = 0x00000100L;
        private const uint HotKeyMessage = 0x0312;
        private const uint QuitMessage = 0x0012;
        private const uint AltModifier = 0x0001;
        private const uint ShiftModifier = 0x0004;
        private const uint NoRepeatModifier = 0x4000;
        private const int ZoomInOemIdentifier = 0x54A1;
        private const int ZoomInNumpadIdentifier = 0x54A2;
        private const int ZoomOutOemIdentifier = 0x54A3;
        private const int ZoomOutNumpadIdentifier = 0x54A4;
        private const int HotKeyEventLimit = 100;
        private static readonly object HotKeySync = new object();
        private static readonly List<NativeHotKeyEvent> HotKeyEvents = new List<NativeHotKeyEvent>();
        private static readonly System.Threading.ManualResetEvent HotKeyReady = new System.Threading.ManualResetEvent(false);
        private static System.Threading.Thread hotKeyThread;
        private static volatile uint hotKeyThreadId;
        private static volatile int hotKeyRegistrationCount;
        private static long hotKeyCursor;

        private static long ReadWindowLong(IntPtr window, int index) {
            if (IntPtr.Size == 8) return GetWindowLongPtr64(window, index).ToInt64();
            return unchecked((uint)GetWindowLong32(window, index));
        }

        public static void EnablePerMonitorDpiAwareness() {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        private static uint ReadDpi(IntPtr window) {
            uint dpi = GetDpiForWindow(window);
            return dpi == 0 ? 96u : dpi;
        }

        public static int DipsToPixels(long handle, int value) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            return checked((int)Math.Round(value * ReadDpi(window) / 96.0, MidpointRounding.AwayFromZero));
        }

        public static int PixelsToDips(long handle, int value) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            return checked((int)Math.Round(value * 96.0 / ReadDpi(window), MidpointRounding.AwayFromZero));
        }

        public static NativePointInfo ScreenPointToDips(long handle, int x, int y) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            IntPtr monitor = MonitorFromWindow(window, 2);
            if (monitor == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var information = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(monitor, ref information)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            uint dpi = ReadDpi(window);
            // A mixed-DPI desktop has no single scale that can be applied to an
            // absolute screen coordinate. Preserve the selected monitor origin
            // (including negative origins), and scale only the monitor-local
            // offset so left/top use the same DIP distance unit as width/height.
            int logicalX = checked(information.Monitor.Left + (int)Math.Round(
                (x - information.Monitor.Left) * 96.0 / dpi,
                MidpointRounding.AwayFromZero
            ));
            int logicalY = checked(information.Monitor.Top + (int)Math.Round(
                (y - information.Monitor.Top) * 96.0 / dpi,
                MidpointRounding.AwayFromZero
            ));
            return new NativePointInfo { X = logicalX, Y = logicalY };
        }

        private static byte[] CaptureRegionData(IntPtr window) {
            IntPtr region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                if (GetWindowRgn(window, region) == 0) return null;
                uint length = GetRegionData(region, 0, null);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                var data = new byte[length];
                if (GetRegionData(region, length, data) != length) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return data;
            } finally {
                DeleteObject(region);
            }
        }

        public static byte[] CaptureRegion(long handle) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            return CaptureRegionData(window);
        }

        private static IntPtr CreateRegion(byte[] data) {
            if (data == null) return IntPtr.Zero;
            IntPtr region = ExtCreateRegion(IntPtr.Zero, checked((uint)data.Length), data);
            if (region == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            return region;
        }

        private static void AssignRegion(IntPtr window, byte[] data) {
            IntPtr region = CreateRegion(data);
            try {
                if (SetWindowRgn(window, region, true) == 0) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                // SetWindowRgn owns a non-null region after a successful call.
                region = IntPtr.Zero;
            } finally {
                if (region != IntPtr.Zero) DeleteObject(region);
            }
        }

        private static void AssignRectRegion(IntPtr window, int left, int top, int width, int height) {
            if (width <= 0 || height <= 0) throw new ArgumentOutOfRangeException("width");
            IntPtr region = CreateRectRgn(left, top, checked(left + width), checked(top + height));
            if (region == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                if (SetWindowRgn(window, region, true) == 0) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                region = IntPtr.Zero;
            } finally {
                if (region != IntPtr.Zero) DeleteObject(region);
            }
        }

        private static bool RegionsEqual(byte[] left, byte[] right) {
            if (left == null || right == null) return left == null && right == null;
            if (left.Length != right.Length) return false;
            for (int index = 0; index < left.Length; index++) {
                if (left[index] != right[index]) return false;
            }
            return true;
        }

        private static bool MatchesRectRegion(IntPtr window, int left, int top, int width, int height) {
            IntPtr region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                if (GetWindowRgn(window, region) != 2) return false;
                Rect box;
                if (GetRgnBox(region, out box) != 2) return false;
                return box.Left == left && box.Top == top &&
                    box.Right - box.Left == width && box.Bottom - box.Top == height;
            } finally {
                DeleteObject(region);
            }
        }

        private static NativeContentInfo FindContent(IntPtr parent) {
            uint parentProcessId;
            GetWindowThreadProcessId(parent, out parentProcessId);
            Rect parentRect;
            if (!GetWindowRect(parent, out parentRect)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var candidates = new List<Rect>();
            EnumChildWindows(parent, delegate(IntPtr child, IntPtr parameter) {
                if (!IsWindowVisible(child)) return true;
                var className = new StringBuilder(256);
                GetClassName(child, className, className.Capacity);
                if (!String.Equals(className.ToString(), "Chrome_RenderWidgetHostHWND", StringComparison.Ordinal)) {
                    return true;
                }
                uint childProcessId;
                GetWindowThreadProcessId(child, out childProcessId);
                Rect rect;
                if (childProcessId != parentProcessId || !GetWindowRect(child, out rect)) return true;
                if (
                    rect.Left < parentRect.Left || rect.Top < parentRect.Top ||
                    rect.Right > parentRect.Right || rect.Bottom > parentRect.Bottom ||
                    rect.Right <= rect.Left || rect.Bottom <= rect.Top
                ) return true;
                candidates.Add(rect);
                return true;
            }, IntPtr.Zero);
            if (candidates.Count == 0) return null;
            candidates.Sort(delegate(Rect left, Rect right) {
                long leftArea = (long)(left.Right - left.Left) * (left.Bottom - left.Top);
                long rightArea = (long)(right.Right - right.Left) * (right.Bottom - right.Top);
                return rightArea.CompareTo(leftArea);
            });
            long maximumArea = (long)(candidates[0].Right - candidates[0].Left) *
                (candidates[0].Bottom - candidates[0].Top);
            if (candidates.Count > 1) {
                long secondArea = (long)(candidates[1].Right - candidates[1].Left) *
                    (candidates[1].Bottom - candidates[1].Top);
                if (maximumArea == secondArea) return null;
            }
            Rect selected = candidates[0];
            return new NativeContentInfo {
                Left = selected.Left,
                Top = selected.Top,
                Width = selected.Right - selected.Left,
                Height = selected.Bottom - selected.Top
            };
        }

        public static NativeContentInfo MeasureContent(long handle) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            NativeContentInfo first = FindContent(window);
            if (first == null) return null;
            System.Threading.Thread.Sleep(30);
            NativeContentInfo second = FindContent(window);
            if (second == null) return null;
            if (
                first.Left != second.Left || first.Top != second.Top ||
                first.Width != second.Width || first.Height != second.Height
            ) return null;
            return second;
        }

        private static NativeContentInfo WaitForContent(long handle) {
            for (int attempt = 0; attempt < 5; attempt++) {
                NativeContentInfo content = MeasureContent(handle);
                if (content != null) return content;
                System.Threading.Thread.Sleep(30);
            }
            return null;
        }

        private static void WriteWindowLong(IntPtr window, int index, long value) {
            SetLastError(0);
            if (IntPtr.Size == 8) {
                IntPtr previous = SetWindowLongPtr64(window, index, new IntPtr(value));
                if (previous == IntPtr.Zero && Marshal.GetLastWin32Error() != 0) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return;
            }
            int previous32 = SetWindowLong32(window, index, unchecked((int)value));
            if (previous32 == 0 && Marshal.GetLastWin32Error() != 0) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        private static void AddHotKeyEvent(string action) {
            lock (HotKeySync) {
                hotKeyCursor++;
                HotKeyEvents.Add(new NativeHotKeyEvent { Cursor = hotKeyCursor, Action = action });
                while (HotKeyEvents.Count > HotKeyEventLimit) HotKeyEvents.RemoveAt(0);
            }
        }

        private static void HotKeyLoop() {
            var registered = new List<int>();
            hotKeyThreadId = GetCurrentThreadId();
            try {
                if (RegisterHotKey(IntPtr.Zero, ZoomInOemIdentifier, AltModifier | ShiftModifier | NoRepeatModifier, 0xBB)) registered.Add(ZoomInOemIdentifier);
                if (RegisterHotKey(IntPtr.Zero, ZoomInNumpadIdentifier, AltModifier | NoRepeatModifier, 0x6B)) registered.Add(ZoomInNumpadIdentifier);
                if (RegisterHotKey(IntPtr.Zero, ZoomOutOemIdentifier, AltModifier | NoRepeatModifier, 0xBD)) registered.Add(ZoomOutOemIdentifier);
                if (RegisterHotKey(IntPtr.Zero, ZoomOutNumpadIdentifier, AltModifier | NoRepeatModifier, 0x6D)) registered.Add(ZoomOutNumpadIdentifier);
                if (registered.Count != 4) {
                    foreach (int identifier in registered) UnregisterHotKey(IntPtr.Zero, identifier);
                    registered.Clear();
                    hotKeyRegistrationCount = 0;
                    HotKeyReady.Set();
                    return;
                }
                hotKeyRegistrationCount = registered.Count;
                HotKeyReady.Set();
                NativeMessage message;
                while (true) {
                    int result = GetMessage(out message, IntPtr.Zero, 0, 0);
                    if (result <= 0) break;
                    if (message.Message != HotKeyMessage) continue;
                    int identifier = message.WParam.ToInt32();
                    if (identifier == ZoomInOemIdentifier || identifier == ZoomInNumpadIdentifier) {
                        AddHotKeyEvent("ZOOM_IN");
                    } else if (identifier == ZoomOutOemIdentifier || identifier == ZoomOutNumpadIdentifier) {
                        AddHotKeyEvent("ZOOM_OUT");
                    }
                }
            } finally {
                foreach (int identifier in registered) UnregisterHotKey(IntPtr.Zero, identifier);
                hotKeyRegistrationCount = 0;
                hotKeyThreadId = 0;
                HotKeyReady.Set();
            }
        }

        public static int StartHotKeys() {
            lock (HotKeySync) {
                if (hotKeyThread != null && hotKeyThread.IsAlive) return hotKeyRegistrationCount;
                HotKeyEvents.Clear();
                hotKeyCursor = 0;
                HotKeyReady.Reset();
                hotKeyThread = new System.Threading.Thread(HotKeyLoop);
                hotKeyThread.IsBackground = true;
                hotKeyThread.Name = "TarkovHelperMiniMapHotKeys";
                hotKeyThread.Start();
            }
            if (!HotKeyReady.WaitOne(3000)) {
                StopHotKeys();
                return 0;
            }
            return hotKeyRegistrationCount;
        }

        public static void StopHotKeys() {
            System.Threading.Thread thread;
            uint threadId;
            lock (HotKeySync) {
                thread = hotKeyThread;
                threadId = hotKeyThreadId;
            }
            if (thread != null && thread.IsAlive && threadId == 0) {
                HotKeyReady.WaitOne(1000);
                threadId = hotKeyThreadId;
                if (thread.IsAlive && threadId == 0) {
                    throw new InvalidOperationException("The native hotkey thread did not initialize.");
                }
            }
            if (thread != null && thread.IsAlive && threadId != 0) {
                if (!PostThreadMessage(threadId, QuitMessage, IntPtr.Zero, IntPtr.Zero)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (!thread.Join(3000)) {
                    throw new InvalidOperationException("The native hotkey thread did not stop.");
                }
            }
            lock (HotKeySync) {
                hotKeyThread = null;
                hotKeyThreadId = 0;
                hotKeyRegistrationCount = 0;
                HotKeyEvents.Clear();
                hotKeyCursor = 0;
            }
        }

        public static NativeHotKeyEventsPayload GetHotKeyEvents(long after) {
            lock (HotKeySync) {
                if (after < 0 || after > hotKeyCursor) throw new ArgumentOutOfRangeException("after");
                var events = new List<NativeHotKeyEvent>();
                foreach (NativeHotKeyEvent item in HotKeyEvents) {
                    if (item.Cursor > after) {
                        events.Add(new NativeHotKeyEvent { Cursor = item.Cursor, Action = item.Action });
                    }
                }
                return new NativeHotKeyEventsPayload {
                    LatestCursor = hotKeyCursor,
                    Events = events.ToArray()
                };
            }
        }

        private static bool MatchesWindowState(
            IntPtr window,
            long style,
            long exStyle,
            int left,
            int top,
            int width,
            int height
        ) {
            Rect rect;
            if (!GetWindowRect(window, out rect)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            // Windows may add or remove WS_EX_WINDOWEDGE when a frame style changes.
            // Every other style bit, including all overlay input and z-order bits,
            // remains part of the transactional postcondition.
            long effectiveExStyleMask = ~WindowEdge;
            return
                ReadWindowLong(window, StyleIndex) == style &&
                (ReadWindowLong(window, ExStyleIndex) & effectiveExStyleMask) ==
                    (exStyle & effectiveExStyleMask) &&
                rect.Left == left &&
                rect.Top == top &&
                rect.Right - rect.Left == width &&
                rect.Bottom - rect.Top == height;
        }

        public static NativeWindowInfo[] EnumerateWindows() {
            var windows = new List<NativeWindowInfo>();
            EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                var title = new StringBuilder(512);
                var className = new StringBuilder(256);
                uint processId;
                Rect rect;
                GetWindowText(window, title, title.Capacity);
                GetClassName(window, className, className.Capacity);
                GetWindowThreadProcessId(window, out processId);
                if (!GetWindowRect(window, out rect)) return true;
                windows.Add(new NativeWindowInfo {
                    Handle = window.ToInt64(),
                    ProcessId = unchecked((int)processId),
                    Title = title.ToString(),
                    ClassName = className.ToString(),
                    Style = ReadWindowLong(window, StyleIndex),
                    ExStyle = ReadWindowLong(window, ExStyleIndex),
                    Left = rect.Left,
                    Top = rect.Top,
                    Width = rect.Right - rect.Left,
                    Height = rect.Bottom - rect.Top,
                    IsVisible = IsWindowVisible(window)
                });
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        }

        public static bool IsWindowHandle(long handle) {
            return IsWindow(new IntPtr(handle));
        }

        private static void SetPosition(
            IntPtr window,
            long style,
            long exStyle,
            int left,
            int top,
            int width,
            int height,
            bool topmost
        ) {
            WriteWindowLong(window, StyleIndex, style);
            WriteWindowLong(window, ExStyleIndex, exStyle);
            var insertAfter = topmost ? new IntPtr(-1) : new IntPtr(-2);
            if (!SetWindowPos(window, insertAfter, left, top, width, height, FrameChanged | ShowWindow | NoActivate)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!MatchesWindowState(window, style, exStyle, left, top, width, height)) {
                throw new InvalidOperationException("The overlay window rejected its requested state.");
            }
        }

        private static void RollBack(
            IntPtr window,
            long style,
            long exStyle,
            Rect rect,
            byte[] regionData
        ) {
            SetPosition(
                window,
                style,
                exStyle,
                rect.Left,
                rect.Top,
                rect.Right - rect.Left,
                rect.Bottom - rect.Top,
                (exStyle & 0x00000008L) != 0
            );
            AssignRegion(window, regionData);
            if (!RegionsEqual(CaptureRegionData(window), regionData)) {
                throw new InvalidOperationException("The overlay window rejected rollback of its previous region.");
            }
        }

        public static void ApplyOriginal(
            long handle,
            long style,
            long exStyle,
            int left,
            int top,
            int width,
            int height,
            bool topmost,
            byte[] regionData
        ) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            long previousStyle = ReadWindowLong(window, StyleIndex);
            long previousExStyle = ReadWindowLong(window, ExStyleIndex);
            Rect previousRect;
            if (!GetWindowRect(window, out previousRect)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            byte[] previousRegionData = CaptureRegionData(window);
            try {
                SetPosition(window, style, exStyle, left, top, width, height, topmost);
                AssignRegion(window, regionData);
                if (!RegionsEqual(CaptureRegionData(window), regionData)) {
                    throw new InvalidOperationException("The overlay window rejected its requested region.");
                }
            } catch (Exception applyError) {
                if (!IsWindow(window)) throw;
                try {
                    RollBack(window, previousStyle, previousExStyle, previousRect, previousRegionData);
                } catch (Exception rollbackError) {
                    throw new AggregateException(
                        "The native overlay update and rollback both failed.",
                        applyError,
                        rollbackError
                    );
                }
                throw;
            }
        }

        public static void ApplyCropped(
            long handle,
            long style,
            long exStyle,
            int visibleLeft,
            int visibleTop,
            int visibleWidth,
            int visibleHeight
        ) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            long previousStyle = ReadWindowLong(window, StyleIndex);
            long previousExStyle = ReadWindowLong(window, ExStyleIndex);
            Rect previousRect;
            if (!GetWindowRect(window, out previousRect)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            byte[] previousRegionData = CaptureRegionData(window);
            try {
                NativeContentInfo content = WaitForContent(handle);
                if (content == null) throw new InvalidOperationException("A unique stable browser content surface was not found.");
                for (int attempt = 0; attempt < 5; attempt++) {
                    Rect outer;
                    if (!GetWindowRect(window, out outer)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    int outerWidth = outer.Right - outer.Left;
                    int outerHeight = outer.Bottom - outer.Top;
                    int nextLeft = checked(outer.Left + visibleLeft - content.Left);
                    int nextTop = checked(outer.Top + visibleTop - content.Top);
                    int nextWidth = checked(outerWidth + visibleWidth - content.Width);
                    int nextHeight = checked(outerHeight + visibleHeight - content.Height);
                    if (nextWidth <= 0 || nextHeight <= 0) {
                        throw new InvalidOperationException("The browser content geometry is invalid.");
                    }
                    SetPosition(window, style, exStyle, nextLeft, nextTop, nextWidth, nextHeight, true);
                    content = WaitForContent(handle);
                    if (content == null) throw new InvalidOperationException("The browser content surface became ambiguous.");
                    if (
                        content.Left == visibleLeft && content.Top == visibleTop &&
                        content.Width == visibleWidth && content.Height == visibleHeight
                    ) break;
                    if (attempt == 4) {
                        throw new InvalidOperationException("The browser content surface did not converge to the requested bounds.");
                    }
                }
                Rect finalOuter;
                if (!GetWindowRect(window, out finalOuter)) throw new Win32Exception(Marshal.GetLastWin32Error());
                int regionLeft = checked(visibleLeft - finalOuter.Left);
                int regionTop = checked(visibleTop - finalOuter.Top);
                AssignRectRegion(window, regionLeft, regionTop, visibleWidth, visibleHeight);
                if (!MatchesRectRegion(window, regionLeft, regionTop, visibleWidth, visibleHeight)) {
                    throw new InvalidOperationException("The overlay window rejected its cropped region.");
                }
            } catch (Exception applyError) {
                if (!IsWindow(window)) throw;
                try {
                    RollBack(window, previousStyle, previousExStyle, previousRect, previousRegionData);
                } catch (Exception rollbackError) {
                    throw new AggregateException(
                        "The native overlay update and rollback both failed.",
                        applyError,
                        rollbackError
                    );
                }
                throw;
            }
        }
    }
}
'@
    [TarkovHelper.NativeOverlayBridge]::EnablePerMonitorDpiAwareness()
}

function Get-NativeBrowserWindows {
    Initialize-NativeOverlayBridge
    $windows = New-Object 'Collections.Generic.List[object]'
    foreach ($window in [TarkovHelper.NativeOverlayBridge]::EnumerateWindows()) {
        if (-not $window.IsVisible -or $window.ClassName -cne "Chrome_WidgetWin_1") { continue }
        try {
            $process = Get-Process -Id $window.ProcessId -ErrorAction Stop
            if ($process.ProcessName -notin @("msedge", "chrome")) { continue }
            $startTimeUtc = $process.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
            $windows.Add([pscustomobject]@{
                handle = [long]$window.Handle
                processId = [int]$window.ProcessId
                processStartTimeUtc = $startTimeUtc
                processIdentity = "$([int]$window.ProcessId)|$startTimeUtc"
                title = [string]$window.Title
                className = [string]$window.ClassName
                style = [long]$window.Style
                exStyle = [long]$window.ExStyle
                rect = [pscustomobject]@{
                    left = [int]$window.Left
                    top = [int]$window.Top
                    width = [int]$window.Width
                    height = [int]$window.Height
                }
            })
        } catch {
            # A browser can exit while its top-level windows are enumerated.
        }
    }
    return $windows.ToArray()
}

function Convert-NativeRectToDips {
    param(
        [Parameter(Mandatory = $true)][long]$Handle,
        [Parameter(Mandatory = $true)][pscustomobject]$Rect
    )

    $topLeft = [TarkovHelper.NativeOverlayBridge]::ScreenPointToDips(
        $Handle,
        [int]$Rect.left,
        [int]$Rect.top
    )
    return [pscustomobject]@{
        left = [int]$topLeft.X
        top = [int]$topLeft.Y
        width = [TarkovHelper.NativeOverlayBridge]::PixelsToDips($Handle, [int]$Rect.width)
        height = [TarkovHelper.NativeOverlayBridge]::PixelsToDips($Handle, [int]$Rect.height)
    }
}

function Get-NativeOverlayEventsPayload {
    param([Parameter(Mandatory = $true)][string]$RequestTarget)

    $query = Get-QueryParameters -RequestTarget $RequestTarget
    foreach ($name in $query.Keys) {
        if ($name -cne "after") {
            throw [ArgumentException]::new("Unknown query parameter.")
        }
    }
    $after = [long]0
    if ($query.ContainsKey("after")) {
        if ($query["after"] -notmatch "^\d{1,16}$" -or -not [long]::TryParse($query["after"], [ref]$after)) {
            throw [ArgumentException]::new("after must be a non-negative safe integer.")
        }
    }
    if ($after -gt 9007199254740991) {
        throw [ArgumentException]::new("after must be a non-negative safe integer.")
    }
    Initialize-NativeOverlayBridge
    if ($null -ne $script:nativeOverlayRecord -and $null -eq (Get-CurrentNativeOverlayWindow)) {
        if (-not [TarkovHelper.NativeOverlayBridge]::IsWindowHandle($script:nativeOverlayRecord.handle)) {
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
            $script:nativeOverlayRecord = $null
            $after = [long]0
        } else {
            # Do not continue consuming global input when the claimed HWND identity
            # can no longer be proven, but retain the record for fail-closed restore.
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
            $after = [long]0
        }
    }
    try {
        $payload = [TarkovHelper.NativeOverlayBridge]::GetHotKeyEvents($after)
    } catch [ArgumentOutOfRangeException] {
        throw [ArgumentException]::new("after is ahead of the latest cursor.")
    }
    return [pscustomobject]@{
        protocolVersion = $nativeOverlayProtocolVersion
        latestCursor = [long]$payload.LatestCursor
        events = @($payload.Events | ForEach-Object {
            [pscustomobject]@{
                cursor = [long]$_.Cursor
                action = [string]$_.Action
            }
        })
    }
}

function Update-NativeOverlayBridge {
    if ($null -eq $script:nativeOverlayRecord) { return }
    $now = [DateTime]::UtcNow
    if ($now -lt $script:nativeOverlayNextReconciliationUtc) { return }
    $script:nativeOverlayNextReconciliationUtc = $now.AddSeconds(1)
    try {
        if ($null -ne (Get-CurrentNativeOverlayWindow)) { return }
        [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        if (-not [TarkovHelper.NativeOverlayBridge]::IsWindowHandle($script:nativeOverlayRecord.handle)) {
            $script:nativeOverlayRecord = $null
        }
    } catch {
        # A failed reconciliation must not stop the local server. Mutating API
        # calls will continue to fail closed until identity can be proven again.
    }
}

function Remove-ExpiredNativeOverlayClaims {
    $now = [DateTime]::UtcNow
    foreach ($claimId in @($script:nativeOverlayClaims.Keys)) {
        if ($script:nativeOverlayClaims[$claimId].expiresAtUtc -le $now) {
            $script:nativeOverlayClaims.Remove($claimId)
        }
    }
}

function New-NativeOverlayClaim {
    Remove-ExpiredNativeOverlayClaims
    $windows = @(Get-NativeBrowserWindows)
    $claimId = Get-RandomToken
    $expiresAtUtc = [DateTime]::UtcNow.AddSeconds($nativeOverlayClaimLifetimeSeconds)
    $script:nativeOverlayClaims[$claimId] = [pscustomobject]@{
        claimId = $claimId
        expiresAtUtc = $expiresAtUtc
        handles = @($windows | ForEach-Object { [string]$_.handle })
        processIdentities = @($windows | ForEach-Object { $_.processIdentity } | Select-Object -Unique)
    }
    return [pscustomobject]@{
        protocolVersion = $nativeOverlayProtocolVersion
        claimId = $claimId
        expiresAt = $expiresAtUtc.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    }
}

function Test-NativePictureInPictureWindow {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Window,
        [Parameter(Mandatory = $true)][pscustomobject]$Claim
    )

    $styleVisible = [long]0x10000000
    $styleCaption = [long]0x00C00000
    $styleMinimizeBox = [long]0x00020000
    $styleMaximizeBox = [long]0x00010000
    $exStyleTopmost = [long]0x00000008
    return (
        $Claim.handles -notcontains [string]$Window.handle -and
        $Claim.processIdentities -contains $Window.processIdentity -and
        $Window.title -ceq $nativeOverlayWindowTitle -and
        ($Window.style -band $styleVisible) -eq $styleVisible -and
        ($Window.style -band $styleCaption) -eq $styleCaption -and
        ($Window.style -band $styleMinimizeBox) -eq 0 -and
        ($Window.style -band $styleMaximizeBox) -eq 0 -and
        ($Window.exStyle -band $exStyleTopmost) -eq $exStyleTopmost
    )
}

function Complete-NativeOverlayClaim {
    param([Parameter(Mandatory = $true)][string]$ClaimId)

    Remove-ExpiredNativeOverlayClaims
    if (-not $script:nativeOverlayClaims.ContainsKey($ClaimId)) {
        return [pscustomobject]@{ errorCode = "CLAIM_NOT_FOUND" }
    }
    if ($null -ne $script:nativeOverlayRecord) {
        if ($null -ne (Get-CurrentNativeOverlayWindow)) {
            return [pscustomobject]@{ errorCode = "OVERLAY_ALREADY_ATTACHED" }
        }
        if ([TarkovHelper.NativeOverlayBridge]::IsWindowHandle($script:nativeOverlayRecord.handle)) {
            return [pscustomobject]@{ errorCode = "OVERLAY_ALREADY_ATTACHED" }
        }
        [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        $script:nativeOverlayRecord = $null
    }

    $claim = $script:nativeOverlayClaims[$ClaimId]
    $script:nativeOverlayClaims.Remove($ClaimId)
    $browserWindows = @(Get-NativeBrowserWindows)
    $matches = @(
        $browserWindows |
            Where-Object { Test-NativePictureInPictureWindow -Window $_ -Claim $claim }
    )
    Write-PortableLog "Native overlay claim inspected $($browserWindows.Count) browser windows and found $($matches.Count) eligible new windows."
    if ($matches.Count -eq 0) {
        return [pscustomobject]@{ errorCode = "WINDOW_NOT_FOUND" }
    }
    if ($matches.Count -ne 1) {
        return [pscustomobject]@{ errorCode = "AMBIGUOUS_WINDOW" }
    }

    $window = $matches[0]
    $overlayId = Get-RandomToken
    $originalRegionData = [TarkovHelper.NativeOverlayBridge]::CaptureRegion([long]$window.handle)
    $script:nativeOverlayRecord = [pscustomobject]@{
        overlayId = $overlayId
        handle = [long]$window.handle
        processId = [int]$window.processId
        processStartTimeUtc = [string]$window.processStartTimeUtc
        windowTitle = [string]$window.title
        originalStyle = [long]$window.style
        originalExStyle = [long]$window.exStyle
        originalRegionData = $originalRegionData
        originalRect = $window.rect
        normalStyle = [long]$window.style
        normalExStyle = [long]$window.exStyle
        normalRegionData = $originalRegionData
        normalRect = $window.rect
        lockedVisibleRect = $null
        lockedBoundsDip = $null
        globalHotkeysAvailable = $false
        mode = "UNLOCKED"
    }
    $registeredHotKeys = [TarkovHelper.NativeOverlayBridge]::StartHotKeys()
    $script:nativeOverlayRecord.globalHotkeysAvailable = $registeredHotKeys -eq 4
    Write-PortableLog "Native overlay hotkey bridge registered $registeredHotKeys of 4 shortcuts."
    return Get-NativeOverlayResponse
}

function Get-NativeOverlayResponse {
    $record = $script:nativeOverlayRecord
    $current = Get-CurrentNativeOverlayWindow
    $bounds = if ($record.mode -eq "UNLOCKED") {
        $physicalBounds = if ($null -ne $current) { $current.rect } else { $record.originalRect }
        Convert-NativeRectToDips -Handle $record.handle -Rect $physicalBounds
    } else {
        $record.lockedBoundsDip
    }
    return [pscustomobject]@{
        protocolVersion = $nativeOverlayProtocolVersion
        overlayId = $record.overlayId
        state = "ATTACHED"
        mode = $record.mode
        globalHotkeysAvailable = [bool]$record.globalHotkeysAvailable
        bounds = [pscustomobject]@{
            left = [int]$bounds.left
            top = [int]$bounds.top
            width = [int]$bounds.width
            height = [int]$bounds.height
        }
    }
}

function Get-CurrentNativeOverlayWindow {
    if ($null -eq $script:nativeOverlayRecord) { return $null }
    $record = $script:nativeOverlayRecord
    return @(
        Get-NativeBrowserWindows |
            Where-Object {
                $_.handle -eq $record.handle -and
                $_.processId -eq $record.processId -and
                $_.processStartTimeUtc -ceq $record.processStartTimeUtc -and
                $_.title -ceq $record.windowTitle
            }
    ) | Select-Object -First 1
}

function Set-NativeOverlayMode {
    param(
        [Parameter(Mandatory = $true)][string]$OverlayId,
        [Parameter(Mandatory = $true)][ValidateSet("UNLOCKED", "LOCKED", "CLICK_THROUGH")][string]$Mode,
        [Nullable[int]]$Width,
        [Nullable[int]]$Height
    )

    if (@("UNLOCKED", "LOCKED", "CLICK_THROUGH") -cnotcontains $Mode) {
        throw [ArgumentException]::new("The native overlay mode is invalid.")
    }
    if ($null -eq $script:nativeOverlayRecord -or $script:nativeOverlayRecord.overlayId -cne $OverlayId) {
        return [pscustomobject]@{ errorCode = "OVERLAY_NOT_FOUND" }
    }
    $record = $script:nativeOverlayRecord
    $current = Get-CurrentNativeOverlayWindow
    if ($null -eq $current) {
        if ([TarkovHelper.NativeOverlayBridge]::IsWindowHandle($record.handle)) {
            throw [InvalidOperationException]::new("The overlay window identity could not be verified.")
        }
        [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        $script:nativeOverlayRecord = $null
        return [pscustomobject]@{ errorCode = "OVERLAY_NOT_FOUND" }
    }

    if ($Mode -ceq "UNLOCKED") {
        [TarkovHelper.NativeOverlayBridge]::ApplyOriginal(
            $record.handle,
            $record.normalStyle,
            $record.normalExStyle,
            $record.normalRect.left,
            $record.normalRect.top,
            $record.normalRect.width,
            $record.normalRect.height,
            (($record.normalExStyle -band [long]0x00000008) -ne 0),
            $record.normalRegionData
        )
        $record.mode = "UNLOCKED"
        return Get-NativeOverlayResponse
    }

    if ($record.mode -ceq "UNLOCKED") {
        $content = [TarkovHelper.NativeOverlayBridge]::MeasureContent($record.handle)
        if ($null -eq $content) {
            throw [InvalidOperationException]::new("A unique stable browser content surface was not found.")
        }
        $record.normalStyle = [long]$current.style
        $record.normalExStyle = [long]$current.exStyle
        $record.normalRegionData = [TarkovHelper.NativeOverlayBridge]::CaptureRegion($record.handle)
        $record.normalRect = [pscustomobject]@{
            left = [int]$current.rect.left
            top = [int]$current.rect.top
            width = [int]$current.rect.width
            height = [int]$current.rect.height
        }
        $nextVisibleRect = [pscustomobject]@{
            left = [int]$current.rect.left
            top = [int]$current.rect.top
            width = [int]$content.Width
            height = [int]$content.Height
        }
        $visibleTopLeftDip = [TarkovHelper.NativeOverlayBridge]::ScreenPointToDips(
            $record.handle,
            $nextVisibleRect.left,
            $nextVisibleRect.top
        )
        $nextBoundsDip = [pscustomobject]@{
            left = [int]$visibleTopLeftDip.X
            top = [int]$visibleTopLeftDip.Y
            width = [TarkovHelper.NativeOverlayBridge]::PixelsToDips($record.handle, $nextVisibleRect.width)
            height = [TarkovHelper.NativeOverlayBridge]::PixelsToDips($record.handle, $nextVisibleRect.height)
        }
    } else {
        $nextVisibleRect = [pscustomobject]@{
            left = [int]$record.lockedVisibleRect.left
            top = [int]$record.lockedVisibleRect.top
            width = [int]$record.lockedVisibleRect.width
            height = [int]$record.lockedVisibleRect.height
        }
        $nextBoundsDip = [pscustomobject]@{
            left = [int]$record.lockedBoundsDip.left
            top = [int]$record.lockedBoundsDip.top
            width = [int]$record.lockedBoundsDip.width
            height = [int]$record.lockedBoundsDip.height
        }
    }
    if ($null -ne $Width -and $null -ne $Height) {
        $nextVisibleRect.width = [TarkovHelper.NativeOverlayBridge]::DipsToPixels($record.handle, [int]$Width)
        $nextVisibleRect.height = [TarkovHelper.NativeOverlayBridge]::DipsToPixels($record.handle, [int]$Height)
        $nextBoundsDip.width = [int]$Width
        $nextBoundsDip.height = [int]$Height
    }

    # Chromium enforces its large normal-window minimum while caption/thick-frame
    # styles are present. Remove only the native frame bits for a locked crop;
    # the renderer is remeasured after this transition before the HRGN is applied.
    $windowDecorationMask = [long]0x00CF0000
    $pinnedStyle = $record.originalStyle -band (-bnot $windowDecorationMask)
    $pinnedExStyle = $record.originalExStyle -bor [long]0x00000008
    if ($record.globalHotkeysAvailable -or $Mode -ceq "CLICK_THROUGH") {
        $pinnedExStyle = $pinnedExStyle -bor [long]0x08000000
    } else {
        # When global registration is unavailable the focused PiP document is
        # the keyboard fallback, so a normal locked window must remain activatable.
        $pinnedExStyle = $pinnedExStyle -band (-bnot [long]0x08000000)
    }
    if ($Mode -ceq "CLICK_THROUGH") {
        $pinnedExStyle = $pinnedExStyle -bor [long]0x00080000 -bor [long]0x00000020
    } else {
        $pinnedExStyle = $pinnedExStyle -band (-bnot [long]0x00080020)
    }
    [TarkovHelper.NativeOverlayBridge]::ApplyCropped(
        $record.handle,
        $pinnedStyle,
        $pinnedExStyle,
        $nextVisibleRect.left,
        $nextVisibleRect.top,
        $nextVisibleRect.width,
        $nextVisibleRect.height
    )
    $record.lockedVisibleRect = $nextVisibleRect
    $record.lockedBoundsDip = $nextBoundsDip
    $record.mode = $Mode
    return Get-NativeOverlayResponse
}

function Remove-NativeOverlay {
    param(
        [string]$OverlayId,
        [switch]$IgnoreIdentifier
    )

    if ($null -eq $script:nativeOverlayRecord) {
        if ($IgnoreIdentifier) { return $true }
        return $false
    }
    if (-not $IgnoreIdentifier -and $script:nativeOverlayRecord.overlayId -cne $OverlayId) {
        return $false
    }

    $record = $script:nativeOverlayRecord
    $current = Get-CurrentNativeOverlayWindow
    if ($null -ne $current) {
        [TarkovHelper.NativeOverlayBridge]::ApplyOriginal(
            $record.handle,
            $record.originalStyle,
            $record.originalExStyle,
            $record.originalRect.left,
            $record.originalRect.top,
            $record.originalRect.width,
            $record.originalRect.height,
            (($record.originalExStyle -band [long]0x00000008) -ne 0),
            $record.originalRegionData
        )
        [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        $script:nativeOverlayRecord = $null
    } else {
        if ([TarkovHelper.NativeOverlayBridge]::IsWindowHandle($record.handle)) {
            throw [InvalidOperationException]::new("The overlay window identity could not be verified.")
        }
        [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        $script:nativeOverlayRecord = $null
    }
    return $true
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
$nativeOverlayToken = Get-RandomToken

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
            Update-NativeOverlayBridge
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
            $overlayHeaders = @()
            $secFetchSiteHeaders = @()
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
                if ($headerName.Equals("X-Tarkov-Overlay", [StringComparison]::OrdinalIgnoreCase)) {
                    $overlayHeaders += $headerValue
                }
                if ($headerName.Equals("Sec-Fetch-Site", [StringComparison]::OrdinalIgnoreCase)) {
                    $secFetchSiteHeaders += $headerValue
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

            $isNativeOverlayMutation = (
                $requestPath -eq "/api/v1/native-overlay/claims" -or
                $requestPath -eq "/api/v1/native-overlay/minimap"
            )
            if ($isNativeOverlayMutation) {
                $allowedNativeMethod = (
                    ($requestPath -eq "/api/v1/native-overlay/claims" -and $method -eq "POST") -or
                    ($requestPath -eq "/api/v1/native-overlay/minimap" -and $method -in @("POST", "PATCH", "DELETE"))
                )
                if (-not $allowedNativeMethod) {
                    Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                        -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                    continue
                }

                $expectedOrigin = "http://127.0.0.1:$boundPort"
                if (
                    $originHeaders.Count -ne 1 -or
                    $originHeaders[0] -ne $expectedOrigin -or
                    $overlayHeaders.Count -ne 1 -or
                    $overlayHeaders[0] -cne $nativeOverlayToken
                ) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" `
                        -Code "FORBIDDEN" -Message "The native overlay request could not be authenticated."
                    continue
                }

                try {
                    $requestObject = Read-JsonRequestObject -Stream $stream `
                        -ContentLengthHeaders $contentLengthHeaders `
                        -ContentTypeHeaders $contentTypeHeaders `
                        -TransferEncodingHeaders $transferEncodingHeaders
                } catch {
                    Write-PortableLog "Rejected native overlay JSON request: $($_.Exception.GetType().Name): $($_.Exception.Message)"
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" `
                        -Code "INVALID_JSON" -Message "A bounded JSON object is required."
                    continue
                }

                if ($requestPath -eq "/api/v1/native-overlay/claims") {
                    try {
                        Assert-JsonObjectShape -Value $requestObject -AllowedProperties @()
                        $claimResponse = New-NativeOverlayClaim
                        Send-JsonResponse -Stream $stream -StatusCode 201 -Reason "Created" -Value $claimResponse
                    } catch [ArgumentException] {
                        Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                            -Code "INVALID_REQUEST" -Message $_.Exception.Message
                    } catch {
                        Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                            -Code "NATIVE_FAILURE" -Message "The native overlay bridge could not be initialized."
                    }
                    continue
                }

                if ($method -eq "POST") {
                    try {
                        Assert-JsonObjectShape -Value $requestObject `
                            -AllowedProperties @("claimId", "windowTitle") `
                            -RequiredProperties @("claimId", "windowTitle")
                        if (
                            $requestObject.claimId -isnot [string] -or
                            $requestObject.claimId -notmatch "^[A-Za-z0-9_-]{40,64}$" -or
                            $requestObject.windowTitle -isnot [string] -or
                            $requestObject.windowTitle -cne $nativeOverlayWindowTitle
                        ) {
                            throw [ArgumentException]::new("The claim identifier or window title is invalid.")
                        }
                    } catch [ArgumentException] {
                        Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                            -Code "INVALID_REQUEST" -Message $_.Exception.Message
                        continue
                    }

                    try {
                        $completeResponse = Complete-NativeOverlayClaim -ClaimId $requestObject.claimId
                    } catch {
                        Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                            -Code "NATIVE_FAILURE" -Message "The native overlay window could not be inspected."
                        continue
                    }
                    switch ($completeResponse.errorCode) {
                        "CLAIM_NOT_FOUND" {
                            Send-JsonError -Stream $stream -StatusCode 404 -Reason "Not Found" `
                                -Code "CLAIM_NOT_FOUND" -Message "The overlay claim is missing or expired."
                            continue
                        }
                        "OVERLAY_ALREADY_ATTACHED" {
                            Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" `
                                -Code "OVERLAY_ALREADY_ATTACHED" -Message "A native overlay is already attached."
                            continue
                        }
                        "WINDOW_NOT_FOUND" {
                            Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" `
                                -Code "WINDOW_NOT_FOUND" -Message "No new Document Picture-in-Picture window was found."
                            continue
                        }
                        "AMBIGUOUS_WINDOW" {
                            Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" `
                                -Code "AMBIGUOUS_WINDOW" -Message "More than one new Picture-in-Picture window was found."
                            continue
                        }
                    }
                    Send-JsonResponse -Stream $stream -StatusCode 201 -Reason "Created" -Value $completeResponse
                    continue
                }

                if ($method -eq "PATCH") {
                    $hasWidth = @($requestObject.PSObject.Properties.Name) -contains "width"
                    $hasHeight = @($requestObject.PSObject.Properties.Name) -contains "height"
                    try {
                        Assert-JsonObjectShape -Value $requestObject `
                            -AllowedProperties @("overlayId", "mode", "width", "height") `
                            -RequiredProperties @("overlayId", "mode")
                        if (
                            $requestObject.overlayId -isnot [string] -or
                            $requestObject.overlayId -notmatch "^[A-Za-z0-9_-]{40,64}$" -or
                            $requestObject.mode -isnot [string] -or
                            @("UNLOCKED", "LOCKED", "CLICK_THROUGH") -cnotcontains $requestObject.mode -or
                            $hasWidth -ne $hasHeight
                        ) {
                            throw [ArgumentException]::new("The overlay identifier, mode, or size is invalid.")
                        }
                        if ($hasWidth) {
                            if (
                                $requestObject.mode -ceq "UNLOCKED" -or
                                $requestObject.width -isnot [int] -or
                                $requestObject.height -isnot [int] -or
                                $requestObject.width -lt $nativeOverlayMinimumSize -or
                                $requestObject.width -gt $nativeOverlayMaximumSize -or
                                $requestObject.height -lt $nativeOverlayMinimumSize -or
                                $requestObject.height -gt $nativeOverlayMaximumSize
                            ) {
                                throw [ArgumentException]::new("Overlay width and height must be bounded integers for a locked mode.")
                            }
                        }
                    } catch [ArgumentException] {
                        Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                            -Code "INVALID_REQUEST" -Message $_.Exception.Message
                        continue
                    }

                    try {
                        $width = if ($hasWidth) { [Nullable[int]]([int]$requestObject.width) } else { $null }
                        $height = if ($hasHeight) { [Nullable[int]]([int]$requestObject.height) } else { $null }
                        $updateResponse = Set-NativeOverlayMode -OverlayId $requestObject.overlayId `
                            -Mode $requestObject.mode -Width $width -Height $height
                    } catch {
                        Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                            -Code "NATIVE_FAILURE" -Message "The native overlay could not be updated."
                        continue
                    }
                    if ($updateResponse.errorCode -eq "OVERLAY_NOT_FOUND") {
                        Send-JsonError -Stream $stream -StatusCode 404 -Reason "Not Found" `
                            -Code "OVERLAY_NOT_FOUND" -Message "The native overlay is no longer attached."
                        continue
                    }
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value $updateResponse
                    continue
                }

                try {
                    Assert-JsonObjectShape -Value $requestObject `
                        -AllowedProperties @("overlayId") -RequiredProperties @("overlayId")
                    if (
                        $requestObject.overlayId -isnot [string] -or
                        $requestObject.overlayId -notmatch "^[A-Za-z0-9_-]{40,64}$"
                    ) {
                        throw [ArgumentException]::new("The overlay identifier is invalid.")
                    }
                } catch [ArgumentException] {
                    Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                        -Code "INVALID_REQUEST" -Message $_.Exception.Message
                    continue
                }
                try {
                    $removed = Remove-NativeOverlay -OverlayId $requestObject.overlayId
                } catch {
                    Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                        -Code "NATIVE_FAILURE" -Message "The native overlay could not be detached safely."
                    continue
                }
                if (-not $removed) {
                    Send-JsonError -Stream $stream -StatusCode 404 -Reason "Not Found" `
                        -Code "OVERLAY_NOT_FOUND" -Message "The native overlay is no longer attached."
                    continue
                }
                Send-Response -Stream $stream -StatusCode 204 -Reason "No Content" `
                    -ContentType "application/json; charset=utf-8" -Body (New-Object byte[] 0)
                continue
            }

            if ($requestPath -eq "/api/v1/native-overlay/events") {
                if ($method -ne "GET") {
                    Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                        -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                    continue
                }
                $expectedOrigin = "http://127.0.0.1:$boundPort"
                if (
                    $overlayHeaders.Count -ne 1 -or
                    $overlayHeaders[0] -cne $nativeOverlayToken -or
                    $originHeaders.Count -gt 1 -or
                    ($originHeaders.Count -eq 1 -and $originHeaders[0] -ne $expectedOrigin) -or
                    $secFetchSiteHeaders.Count -gt 1 -or
                    ($secFetchSiteHeaders.Count -eq 1 -and $secFetchSiteHeaders[0] -cne "same-origin")
                ) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" `
                        -Code "FORBIDDEN" -Message "The native overlay request could not be authenticated."
                    continue
                }
                try {
                    $eventPayload = Get-NativeOverlayEventsPayload -RequestTarget $requestTarget
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value $eventPayload
                } catch [ArgumentException] {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" `
                        -Code "INVALID_QUERY" -Message $_.Exception.Message
                } catch {
                    Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                        -Code "NATIVE_FAILURE" -Message "The native overlay hotkey bridge could not be read."
                }
                continue
            }
            if ($method -ne "GET" -and -not $headOnly) {
                Send-TextResponse -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                    -Message "Method Not Allowed" -ExtraHeaders @("Allow: GET, HEAD")
                continue
            }

            if ($requestPath -eq "/api/v1/native-overlay/session") {
                Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -HeadOnly:$headOnly -Value ([pscustomobject]@{
                    protocolVersion = $nativeOverlayProtocolVersion
                    capability = "WINDOWS_DOCUMENT_PIP"
                    token = $nativeOverlayToken
                    windowTitle = $nativeOverlayWindowTitle
                    sizeLimits = [pscustomobject]@{
                        minWidth = $nativeOverlayMinimumSize
                        minHeight = $nativeOverlayMinimumSize
                        maxWidth = $nativeOverlayMaximumSize
                        maxHeight = $nativeOverlayMaximumSize
                    }
                })
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
            Update-NativeOverlayBridge
        }
    }
} finally {
    try {
        $null = Remove-NativeOverlay -IgnoreIdentifier
    } catch {
        Write-PortableLog "Native overlay restoration failed during shutdown."
    }
    Stop-ScreenshotWatcher
    $listener.Stop()
    if ($ownsInstanceState) {
        Remove-OwnedInstance -ProcessId $PID -ControlToken $controlToken
        Write-PortableLog "Server stopped."
    }
    if ($hasServeMutex) { $serveMutex.ReleaseMutex() }
    $serveMutex.Dispose()
}
