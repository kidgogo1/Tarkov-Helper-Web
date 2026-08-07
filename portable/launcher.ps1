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
$trackerEvents = New-Object 'Collections.Generic.List[object]'
$trackerLatestCursor = [long]0
$screenshotWatcher = $null
$screenshotWatcherSources = @()
$screenshotPendingFiles = @{}
$screenshotWatcherState = [pscustomobject]@{ state = "NOT_FOUND" }

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

function Stop-ScreenshotWatcher {
    foreach ($source in $script:screenshotWatcherSources) {
        Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
    }
    $script:screenshotWatcherSources = @()
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
            $selectedFolder = Get-ScreenshotCandidates | Where-Object { [IO.Directory]::Exists($_) } | Select-Object -First 1
        }

        if ([string]::IsNullOrWhiteSpace($selectedFolder) -or -not [IO.Directory]::Exists($selectedFolder)) {
            $script:screenshotWatcherState = [pscustomobject]@{ state = "NOT_FOUND" }
            return
        }

        $watcher = [IO.FileSystemWatcher]::new($selectedFolder, "*.png")
        $watcher.IncludeSubdirectories = $false
        $watcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::CreationTime -bor [IO.NotifyFilters]::LastWrite
        $createdSource = "TarkovHelper.Screenshot.Created.$PID.$([Guid]::NewGuid().ToString('N'))"
        $changedSource = "TarkovHelper.Screenshot.Changed.$PID.$([Guid]::NewGuid().ToString('N'))"
        Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $createdSource | Out-Null
        Register-ObjectEvent -InputObject $watcher -EventName Changed -SourceIdentifier $changedSource | Out-Null
        $watcher.EnableRaisingEvents = $true

        $script:screenshotWatcher = $watcher
        $script:screenshotWatcherSources = @($createdSource, $changedSource)
        $script:screenshotWatcherState = [pscustomobject]@{
            state = "WATCHING"
            folderPath = $selectedFolder
        }
    } catch {
        Stop-ScreenshotWatcher
        $script:screenshotWatcherState = [pscustomobject]@{
            state = "ERROR"
            message = "The screenshot folder could not be monitored."
        }
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
    if ($script:screenshotWatcherState.state -ne "WATCHING") { return }

    foreach ($source in $script:screenshotWatcherSources) {
        foreach ($eventRecord in @(Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
            try {
                $fullPath = [string]$eventRecord.SourceEventArgs.FullPath
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

    $now = [DateTime]::UtcNow
    foreach ($fileName in @($script:screenshotPendingFiles.Keys)) {
        if (($now - $script:screenshotPendingFiles[$fileName]).TotalMilliseconds -lt $trackerDebounceMilliseconds) { continue }
        $script:screenshotPendingFiles.Remove($fileName)
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
        $remaining = $TimeoutMilliseconds - [int]$stopwatch.ElapsedMilliseconds
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

function Read-PortableInstance {
    try {
        $instancePath = Get-InstancePath
        if (-not [IO.File]::Exists($instancePath)) { return $null }
        $instance = Get-Content -LiteralPath $instancePath -Raw | ConvertFrom-Json
        if (
            $null -eq $instance -or
            $instance.protocolVersion -ne 1 -or
            $instance.pid -isnot [int] -or
            $instance.port -isnot [int] -or
            $instance.port -lt 1 -or
            $instance.port -gt 65535 -or
            $instance.controlToken -isnot [string] -or
            $instance.controlToken -notmatch "^[A-Za-z0-9_-]{40,}$"
        ) {
            return $null
        }
        return $instance
    } catch {
        return $null
    }
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

function Test-PortableInstance {
    param([object]$Instance)

    if ($null -eq $Instance) { return $false }
    try {
        $process = Get-Process -Id ([int]$Instance.pid) -ErrorAction Stop
        if ($process.HasExited) { return $false }
        $url = "http://127.0.0.1:$($Instance.port)/"
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
            -Headers @{ "X-Tarkov-Control" = [string]$Instance.controlToken } `
            -Uri ($url.TrimEnd("/") + $healthPath)
        return $response.StatusCode -eq 200 -and $response.Content.EndsWith(":authenticated", [StringComparison]::Ordinal)
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

    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-PortableBroker {
    $mutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Start"))
    $hasMutex = $false
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

        $existing = Read-PortableInstance
        if (Test-PortableInstance -Instance $existing) {
            $existingUrl = "http://127.0.0.1:$($existing.port)/"
            [Console]::Out.WriteLine("TARKOV_HELPER_URL=$existingUrl")
            [Console]::Out.WriteLine("Tarkov Helper is already running.")
            Open-PortableBrowser -Url $existingUrl
            return 0
        }

        $instancePath = Get-InstancePath
        if ([IO.File]::Exists($instancePath)) {
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
            if ($null -ne $instance -and $instance.pid -eq $child.Id -and (Test-PortableInstance -Instance $instance)) {
                $url = "http://127.0.0.1:$($instance.port)/"
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
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Stop-PortableBroker {
    $instance = Read-PortableInstance
    if ($null -eq $instance) { return 0 }

    try {
        $url = "http://127.0.0.1:$($instance.port)/"
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Method Post `
            -Headers @{
                "Origin" = $url.TrimEnd("/")
                "X-Tarkov-Control" = [string]$instance.controlToken
            } `
            -ContentType "application/json" -Body "{}" `
            -Uri ($url.TrimEnd("/") + "/api/v1/control/shutdown")
        if ($response.StatusCode -ne 204) { throw "Unexpected shutdown response." }

        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (-not [IO.File]::Exists((Get-InstancePath))) { return 0 }
            Start-Sleep -Milliseconds 100
        }
        [Console]::Error.WriteLine("Tarkov Helper did not stop in time.")
        return 2
    } catch {
        try {
            Get-Process -Id ([int]$instance.pid) -ErrorAction Stop | Out-Null
        } catch {
            Remove-OwnedInstance -ProcessId ([int]$instance.pid) -ControlToken ([string]$instance.controlToken)
            return 0
        }
        [Console]::Error.WriteLine("The recorded Tarkov Helper instance could not be authenticated and was not terminated: $($_.Exception.Message)")
        return 2
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

Start-ScreenshotWatcher
$buildIdentity = $null
$packageInfoPath = Join-Path (Split-Path -Parent $rootPath) "PACKAGE_INFO.txt"
if ([IO.File]::Exists($packageInfoPath)) {
    $packageInfo = Get-Content -LiteralPath $packageInfoPath -Raw
    $treeHashMatch = [Text.RegularExpressions.Regex]::Match(
        $packageInfo,
        "(?m)^App tree SHA-256: ([0-9a-f]{64})$"
    )
    if ($treeHashMatch.Success) {
        $buildIdentity = $treeHashMatch.Groups[1].Value
    }
}
if ($null -eq $buildIdentity) {
    $identityHashes = @((Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash.ToLowerInvariant())
    $dataPath = Join-Path $rootPath "data\tarkov-data.json"
    if ([IO.File]::Exists($dataPath)) {
        $identityHashes += (Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $buildIdentity = $identityHashes -join ":"
}
$healthResponse = "tarkov-helper-web-portable-v1:$buildIdentity"
$controlToken = Get-RandomToken

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
        try {
            $healthCheck = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ($existingUrl.TrimEnd('/') + $healthPath)
            if ($healthCheck.StatusCode -ne 200 -or $healthCheck.Content -ne $healthResponse) {
                throw "Unexpected response"
            }
            $existingServerMatches = $true
        } catch {
            $existingServerMatches = $false
        }
        if (-not $existingServerMatches) {
            [Console]::Error.WriteLine("Local port $Port is already used by another program.")
            [Console]::Error.WriteLine("Close that program and run Tarkov Helper again.")
            exit 2
        }
        [Console]::Out.WriteLine("TARKOV_HELPER_URL=$existingUrl")
        [Console]::Out.WriteLine("Tarkov Helper is already running.")
        [Console]::Out.Flush()
        if (-not $NoBrowser) {
            try {
                Start-Process $existingUrl
            } catch {
                [Console]::Error.WriteLine("Could not open the browser automatically. Open this URL: $existingUrl")
            }
        }
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
            startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        })
        $ownsInstanceState = $true
        Write-PortableLog "Server started on loopback port $boundPort."
    } catch {
        [Console]::Error.WriteLine("The local runtime state could not be written.")
        Write-PortableLog "Runtime state initialization failed."
        exit 2
    }

    [Console]::Out.WriteLine("TARKOV_HELPER_URL=$url")
    [Console]::Out.WriteLine("Tarkov Helper is running locally.")
    [Console]::Out.WriteLine("Keep this window open. Press Ctrl+C to stop.")
    [Console]::Out.Flush()

    if (-not $NoBrowser) {
        try {
            Start-Process $url
        } catch {
            [Console]::Error.WriteLine("Could not open the browser automatically. Open this URL: $url")
        }
    }

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
    if ($ownsInstanceState) {
        Remove-OwnedInstance -ProcessId $PID -ControlToken $controlToken
        Write-PortableLog "Server stopped."
    }
    $listener.Stop()
}
