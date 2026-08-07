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
    $documentFolders = @("Documents", "문서", "My Documents")

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

$rootPrefix = $rootPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$handledRequests = 0

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

    while ($MaxRequests -eq 0 -or $handledRequests -lt $MaxRequests) {
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
            $malformedHeader = $false
            for ($index = 1; $index -lt $requestLines.Length; $index++) {
                $headerLine = $requestLines[$index]
                if ($headerLine.Length -eq 0) { break }
                $separator = $headerLine.IndexOf(":")
                if ($separator -le 0) {
                    $malformedHeader = $true
                    break
                }
                if ($headerLine.Substring(0, $separator).Trim().Equals("Host", [StringComparison]::OrdinalIgnoreCase)) {
                    $hostHeaders += $headerLine.Substring($separator + 1).Trim()
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
            if ($method -ne "GET" -and -not $headOnly) {
                Send-TextResponse -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                    -Message "Method Not Allowed" -ExtraHeaders @("Allow: GET, HEAD")
                continue
            }

            $requestPath = $requestTarget.Split("?", 2)[0]
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
                Send-TextResponse -Stream $stream -StatusCode 200 -Reason "OK" `
                    -Message $healthResponse -HeadOnly:$headOnly
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
}
