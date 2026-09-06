[CmdletBinding()]
param(
    [ValidateSet("Start", "Serve", "Stop", "Repair")]
    [string]$Action = "Serve",
    [string]$Root,
    [ValidateRange(0, 65535)]
    [int]$Port = 41753,
    [switch]$NoBrowser,
    [ValidateRange(0, 2147483647)]
    [int]$MaxRequests = 0,
    [string]$ScreenshotFolder,
    [string]$StateDirectory,
    [string]$UpdateNonce,
    [switch]$DisablePackageUpdates
)

$ErrorActionPreference = "Stop"
$healthPath = "/.tarkov-helper-portable"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Join-Path $PSScriptRoot "app"
}

if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
    $StateDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "TarkovHelperWeb"
}

if (-not [string]::IsNullOrWhiteSpace($UpdateNonce) -and $UpdateNonce -notmatch '^[A-Za-z0-9_-]{40,64}$') {
    [Console]::Error.WriteLine("The internal update health nonce is invalid.")
    exit 2
}

$trackerProtocolVersion = 1
$trackerEventLimit = 100
$trackerDebounceMilliseconds = 500
$trackerDiscoveryIntervalSeconds = 5
$trackerReconciliationIntervalSeconds = 5
$trackerFingerprintLimit = 2048
$trackerMapObservationMaximumAgeMinutes = 90
$trackerMapBootstrapByteBudget = 1048576
$trackerMapBootstrapFileByteBudget = 262144
$trackerMapScreenshotBootstrapByteBudget = 262144
$trackerMapBootstrapIntervalMilliseconds = 100
$trackerMapPendingFallbackSeconds = 15
$trackerTestMode = [string]$env:TARKOV_HELPER_TRACKER_TEST_MODE -ceq "1"
$trackerInstanceId = [Guid]::NewGuid().ToString("N")
$trackerStartedAtUtc = [DateTime]::UtcNow
$trackerEvents = New-Object 'Collections.Generic.List[object]'
$trackerLatestCursor = [long]0
$trackerGameLogRootsCache = @()
$trackerNextGameLogRootDiscoveryUtc = [DateTime]::MinValue
$trackerGameLogSessionCache = $null
$trackerGameLogRootFingerprint = ""
$trackerMapStateCacheSession = ""
$trackerMapLogFileStates = @{}
$trackerMapArchivedEvents = @()
$trackerMapBootstrapRoundRobinIndex = 0
$trackerNextMapBootstrapUtc = [DateTime]::MinValue
$screenshotWatcher = $null
$screenshotWatcherSources = @()
$screenshotWatcherErrorSource = $null
$screenshotPendingFiles = @{}
$screenshotFingerprints = @{}
$screenshotWatcherState = [pscustomobject]@{ state = "NOT_FOUND" }
$screenshotNextDiscoveryUtc = [DateTime]::MinValue
$screenshotNextReconciliationUtc = [DateTime]::MinValue
$nativeOverlayProtocolVersion = 1
$nativeOverlayV2ProtocolVersion = 2
$nativeOverlayV2Capability = "WINDOWS_MULTI_OVERLAY"
$nativeOverlayWindowTitle = "Tarkov Helper Web"
$nativeOverlayQuestListWindowTitle = "Tarkov Helper Quest List"
$nativeOverlayClaimLifetimeSeconds = 15
$nativeOverlayMinimumSize = 240
$nativeOverlayMaximumSize = 1000
$nativeOverlayClaims = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
$nativeOverlayCompletedClaims = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
$nativeOverlayRecords = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
$nativeOverlayNextReconciliationUtc = [DateTime]::MinValue
$protectedPortableLogPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$appUpdateProtocolVersion = 1
$appUpdateToken = $null
$legacyAppUpdateCleanupFinished = [bool]$DisablePackageUpdates
$legacyAppUpdateCleanupNextAttemptUtc = [DateTime]::MinValue
$legacyAppUpdateCleanupDeadlineUtc = [DateTime]::UtcNow.AddMinutes(5)
$itemPriceProtocolVersion = 1
$itemPriceFreshSeconds = 600
$itemPriceStaleSeconds = 604800
$itemPriceMaximumBytes = 4194304
$itemPriceUpstreamBaseUrl = "https://json.tarkov.dev"
$itemPriceTestMode = [string]$env:TARKOV_HELPER_PRICE_TEST_MODE -ceq "1"
$moddingPreviewUpstreamBaseUrl = "https://image-gen.tarkov-changes.com"
$moddingPreviewJob = $null
$moddingPreviewCache = [ordered]@{}
$moddingPreviewSlotCache = @{}
$moddingPreviewCooldownUtc = [DateTime]::MinValue
if ($env:TARKOV_HELPER_MODDING_PREVIEW_TEST_MODE -ceq "1") {
    try {
        $previewTestUri = [Uri]::new([string]$env:TARKOV_HELPER_MODDING_PREVIEW_TEST_BASE_URL)
        if (-not $previewTestUri.IsAbsoluteUri -or $previewTestUri.Scheme -cne "http" -or
            $previewTestUri.Host -cne "127.0.0.1" -or $previewTestUri.Port -lt 1 -or
            $previewTestUri.AbsolutePath -cne "/" -or $previewTestUri.Query -or
            $previewTestUri.Fragment -or $previewTestUri.UserInfo) { throw "Invalid preview test endpoint" }
        $moddingPreviewUpstreamBaseUrl = $previewTestUri.AbsoluteUri.TrimEnd("/")
    } catch {
        [Console]::Error.WriteLine("The internal preview test configuration is invalid.")
        exit 2
    }
}
if ($itemPriceTestMode) {
    try {
        $testPriceUri = [Uri]::new([string]$env:TARKOV_HELPER_PRICE_TEST_BASE_URL)
        if (
            -not $testPriceUri.IsAbsoluteUri -or
            $testPriceUri.Scheme -cne "http" -or
            $testPriceUri.Host -cne "127.0.0.1" -or
            $testPriceUri.Port -lt 1 -or
            $testPriceUri.AbsolutePath -cne "/" -or
            -not [string]::IsNullOrEmpty($testPriceUri.Query) -or
            -not [string]::IsNullOrEmpty($testPriceUri.Fragment) -or
            -not [string]::IsNullOrEmpty($testPriceUri.UserInfo)
        ) {
            throw [ArgumentException]::new("The price test endpoint is invalid.")
        }
        $itemPriceUpstreamBaseUrl = $testPriceUri.AbsoluteUri.TrimEnd("/")
        if (-not [string]::IsNullOrWhiteSpace($env:TARKOV_HELPER_PRICE_TEST_FRESH_SECONDS)) {
            $itemPriceFreshSeconds = [int]$env:TARKOV_HELPER_PRICE_TEST_FRESH_SECONDS
            if ($itemPriceFreshSeconds -lt 1 -or $itemPriceFreshSeconds -gt 600) { throw "Invalid test freshness" }
        }
        if (-not [string]::IsNullOrWhiteSpace($env:TARKOV_HELPER_PRICE_TEST_MAX_BYTES)) {
            $itemPriceMaximumBytes = [int]$env:TARKOV_HELPER_PRICE_TEST_MAX_BYTES
            if ($itemPriceMaximumBytes -lt 256 -or $itemPriceMaximumBytes -gt 4194304) { throw "Invalid test byte cap" }
        }
    } catch {
        [Console]::Error.WriteLine("The internal price test configuration is invalid.")
        exit 2
    }
}
# Browsers throttle background-tab timers. A short lease made the hidden
# launcher stop while the user was still using the map, so keep a generous
# orphan-recovery window; normal tab close still sends /client/close immediately.
$clientLeaseTimeoutSeconds = 600
$clientLeases = @{}
$clientLifecycleArmed = $false
$clientFirstLeaseDeadlineUtc = [DateTime]::MaxValue
if (-not [string]::IsNullOrWhiteSpace($UpdateNonce)) {
    $firstLeaseDeadlineMilliseconds = 300000
    if (-not [string]::IsNullOrWhiteSpace($env:TARKOV_HELPER_UPDATE_TEST_FIRST_CLIENT_DEADLINE_MS)) {
        if (
            -not [int]::TryParse([string]$env:TARKOV_HELPER_UPDATE_TEST_FIRST_CLIENT_DEADLINE_MS, [ref]$firstLeaseDeadlineMilliseconds) -or
            $firstLeaseDeadlineMilliseconds -lt 500 -or
            $firstLeaseDeadlineMilliseconds -gt 300000
        ) {
            [Console]::Error.WriteLine("The internal replacement first-client deadline is invalid.")
            exit 2
        }
    }
    $clientFirstLeaseDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds($firstLeaseDeadlineMilliseconds)
}

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

function ConvertTo-TrackerMapKey {
    param([string]$MapName)

    if ([string]::IsNullOrWhiteSpace($MapName) -or $MapName.Length -gt 80) { return $null }
    $normalized = $MapName.Trim().ToLowerInvariant()
    if ($normalized.EndsWith("_preset", [StringComparison]::Ordinal)) {
        $withoutPreset = $normalized.Substring(0, $normalized.Length - "_preset".Length)
        $fallback = ConvertTo-TrackerMapKey -MapName $withoutPreset
        if (-not [string]::IsNullOrWhiteSpace($fallback)) { return $fallback }
    }
    switch ($normalized) {
        { $_ -in @("woods", "woods_preset") } { return "Woods" }
        { $_ -in @("customs", "customs_preset", "bigmap", "bigmap_preset") } { return "Customs" }
        { $_ -in @("shoreline", "shoreline_preset") } { return "Shoreline" }
        { $_ -in @("interchange", "shopping_mall", "shopping_mall_preset") } { return "Interchange" }
        { $_ -in @("reserve", "rezervbase", "rezerv_base", "rezerv_base_preset") } { return "Reserve" }
        { $_ -in @("lighthouse", "lighthouse_preset") } { return "Lighthouse" }
        { $_ -in @("streets", "streets of tarkov", "tarkovstreets", "city", "city_preset") } { return "StreetsOfTarkov" }
        { $_ -in @("factory", "factory4_day", "factory4_night", "factory4_day_preset", "factory4_night_preset", "factory_day", "factory_night", "factory_day_preset", "factory_night_preset") } { return "Factory" }
        { $_ -in @("groundzero", "ground zero", "ground_zero", "sandbox", "sandbox_high", "sandbox_start", "sandbox_preset", "sandbox_high_preset", "sandbox_start_preset") } { return "GroundZero" }
        { $_ -in @("lab", "labs", "the lab", "laboratory", "laboratory_preset") } { return "Labs" }
        { $_ -in @("labyrinth", "the labyrinth", "labyrinth_preset") } { return "Labyrinth" }
        { $_ -in @("terminal", "terminal_preset") } { return "Terminal" }
        default { return $null }
    }
}

function Get-TrackerScreenshotCapturedAt {
    param([string]$FileName)

    if ($FileName -notmatch '^(?<date>\d{4}-\d{2}-\d{2})\[(?<time>\d{2}-\d{2})\]_') { return $null }
    $capturedAt = [DateTime]::MinValue
    $timestamp = "$($Matches.date)[$($Matches.time)]"
    if (-not [DateTime]::TryParseExact(
        $timestamp,
        "yyyy-MM-dd[HH-mm]",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,
        [ref]$capturedAt
    )) { return $null }
    return $capturedAt
}

function Get-TrackerGameLogRoots {
    $now = [DateTime]::UtcNow
    if ($now -lt $script:trackerNextGameLogRootDiscoveryUtc) {
        return @($script:trackerGameLogRootsCache)
    }

    $paths = New-Object 'Collections.Generic.List[string]'
    $knownPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    function Add-LogRoot {
        param([string]$Candidate)
        if ([string]::IsNullOrWhiteSpace($Candidate)) { return }
        try {
            $normalized = [IO.Path]::GetFullPath($Candidate)
            if ([IO.Directory]::Exists($normalized) -and $knownPaths.Add($normalized)) {
                $paths.Add($normalized)
            }
        } catch {
            # Discovery candidates are local hints only; malformed paths are ignored.
        }
    }

    if ($trackerTestMode) {
        Add-LogRoot ([string]$env:TARKOV_HELPER_TRACKER_TEST_LOG_ROOT)
    } else {
        foreach ($registryPath in @(
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
            "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov"
        )) {
            try {
                $installation = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
                if ($installation.InstallLocation -is [string]) {
                    Add-LogRoot (Join-Path ([string]$installation.InstallLocation) "Logs")
                }
            } catch {
                # The game may be installed without this registry view.
            }
        }

        foreach ($process in @(Get-Process -Name "EscapeFromTarkov" -ErrorAction SilentlyContinue)) {
            try {
                if (-not [string]::IsNullOrWhiteSpace($process.Path)) {
                    Add-LogRoot (Join-Path ([IO.Path]::GetDirectoryName($process.Path)) "Logs")
                }
            } catch {
                # Protected process metadata is optional discovery input.
            }
        }

        try {
            $launcherSettings = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) "Battlestate Games\BsgLauncher\settings"
            if ([IO.File]::Exists($launcherSettings) -and ([IO.FileInfo]::new($launcherSettings)).Length -le 1048576) {
                $settings = ConvertFrom-Json ([IO.File]::ReadAllText($launcherSettings, [Text.Encoding]::UTF8))
                if ($settings.gamesRootDir -is [string]) {
                    Add-LogRoot (Join-Path (Join-Path ([string]$settings.gamesRootDir) "Escape from Tarkov") "Logs")
                }
            }
        } catch {
            # Launcher settings are optional and their contents are never logged.
        }
    }

    $script:trackerGameLogRootsCache = @($paths.ToArray())
    $script:trackerNextGameLogRootDiscoveryUtc = $now.AddSeconds(30)
    return @($script:trackerGameLogRootsCache)
}

function Get-TrackerGameLogSession {
    $rootFingerprintParts = New-Object 'Collections.Generic.List[string]'
    foreach ($logRoot in @(Get-TrackerGameLogRoots)) {
        try {
            $rootInfo = [IO.DirectoryInfo]::new($logRoot)
            $rootFingerprintParts.Add("$($rootInfo.FullName)|$($rootInfo.LastWriteTimeUtc.Ticks)")
        } catch { }
    }
    $rootFingerprint = [string]::Join("`n", @($rootFingerprintParts | Sort-Object))
    if (
        $rootFingerprint -ceq $script:trackerGameLogRootFingerprint -and
        -not [string]::IsNullOrWhiteSpace([string]$script:trackerGameLogSessionCache) -and
        [IO.Directory]::Exists([string]$script:trackerGameLogSessionCache)
    ) {
        return [string]$script:trackerGameLogSessionCache
    }

    $sessions = New-Object 'Collections.Generic.List[object]'
    $knownSessions = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($logRoot in @(Get-TrackerGameLogRoots)) {
        try {
            foreach ($sessionPath in [IO.Directory]::EnumerateDirectories($logRoot, "log_*", [IO.SearchOption]::TopDirectoryOnly)) {
                try {
                    $normalized = [IO.Path]::GetFullPath($sessionPath)
                    if ($knownSessions.Add($normalized)) {
                        $sessions.Add([IO.DirectoryInfo]::new($normalized))
                    }
                } catch { }
            }
            if (@([IO.Directory]::EnumerateFiles($logRoot, "*application*.log", [IO.SearchOption]::TopDirectoryOnly)).Count -gt 0) {
                $normalizedRoot = [IO.Path]::GetFullPath($logRoot)
                if ($knownSessions.Add($normalizedRoot)) {
                    $sessions.Add([IO.DirectoryInfo]::new($normalizedRoot))
                }
            }
        } catch {
            # A log session can disappear while the game rotates it.
        }
    }

    $selected = @($sessions | Sort-Object -Property LastWriteTimeUtc -Descending | Select-Object -First 1)
    $nextSession = if ($selected.Count -eq 1) { [string]$selected[0].FullName } else { $null }
    if ($nextSession -cne [string]$script:trackerGameLogSessionCache) {
        $script:trackerMapStateCacheSession = ""
        $script:trackerMapLogFileStates = @{}
        $script:trackerMapArchivedEvents = @()
        $script:trackerMapBootstrapRoundRobinIndex = 0
    }
    $script:trackerGameLogSessionCache = $nextSession
    $script:trackerGameLogRootFingerprint = $rootFingerprint
    return $nextSession
}

function ConvertTo-TrackerMapStateEvent {
    param([string]$Line)

    if ($Line -notmatch '^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,7})?)') { return $null }
    $observedAt = [DateTime]::MinValue
    if (-not [DateTime]::TryParse(
        [string]$Matches.timestamp,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,
        [ref]$observedAt
    )) { return $null }

    $rawMapName = $null
    if ($Line -match '(?i)scene preset path:maps/(?<map>[A-Za-z0-9_]+)\.bundle') {
        $rawMapName = [string]$Matches.map
    } elseif ($Line -match '(?i)\bLocation:\s*(?<map>[A-Za-z0-9_ -]+),') {
        $rawMapName = [string]$Matches.map
    }
    if (-not [string]::IsNullOrWhiteSpace($rawMapName)) {
        return [pscustomobject]@{
            observedAt = $observedAt
            kind = "MAP"
            rawMapName = $rawMapName
        }
    }
    if ($Line -match '(?i)\b(?:PrepareSelectedProfileLocally|CompleteSelectedProfile|Disposing BEClient|TRACE-NetworkGameDestroy|GameStop(?:ped|ping)|StopSession)\b') {
        return [pscustomobject]@{
            observedAt = $observedAt
            kind = "INACTIVE"
            rawMapName = $null
        }
    }
    return $null
}

function Read-TrackerLogStateAppend {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$StartOffset,
        [bool]$DiscardUntilNewline
    )

    $stream = $null
    $events = New-Object 'Collections.Generic.List[object]'
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        if ($StartOffset -lt 0 -or $StartOffset -gt $stream.Length) { $StartOffset = 0 }
        $stream.Position = $StartOffset
        $lineBuffer = [IO.MemoryStream]::new()
        $discardLine = $DiscardUntilNewline
        $committedOffset = $StartOffset
        $buffer = New-Object byte[] 65536
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $chunkStart = $stream.Position - $read
            $segmentStart = 0
            while ($segmentStart -lt $read) {
                $newlineIndex = [Array]::IndexOf($buffer, [byte]10, $segmentStart, $read - $segmentStart)
                $segmentEnd = if ($newlineIndex -ge 0) { $newlineIndex } else { $read }
                $segmentLength = $segmentEnd - $segmentStart
                if (-not $discardLine -and $segmentLength -gt 0) {
                    if (($lineBuffer.Length + $segmentLength) -le 16384) {
                        $lineBuffer.Write($buffer, $segmentStart, $segmentLength)
                    } else {
                        $lineBuffer.SetLength(0)
                        $discardLine = $true
                    }
                }
                if ($newlineIndex -lt 0) { break }
                if (-not $discardLine) {
                    $lineBytes = $lineBuffer.ToArray()
                    $line = [Text.Encoding]::UTF8.GetString($lineBytes).TrimEnd("`r")
                    $event = ConvertTo-TrackerMapStateEvent -Line $line
                    if ($null -ne $event) { $events.Add($event) }
                }
                $lineBuffer.SetLength(0)
                $discardLine = $false
                $committedOffset = $chunkStart + $newlineIndex + 1
                $segmentStart = $newlineIndex + 1
            }
        }
        if ($discardLine) { $committedOffset = [long]$stream.Position }
        return [pscustomobject]@{
            offset = [long]$committedOffset
            discardUntilNewline = [bool]$discardLine
            events = $events.ToArray()
        }
    } catch {
        return $null
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Advance-TrackerLogBootstrapState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$State,
        [ValidateRange(1, 1048576)][int]$MaximumBytes
    )

    if ([bool]$State.bootstrapComplete) { return 0 }
    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        $position = [Math]::Min([long]$State.bootstrapPosition, [long]$stream.Length)
        if ($position -le 0) {
            $State.bootstrapComplete = $true
            return 0
        }

        $readLength = [int][Math]::Min([long]$MaximumBytes, $position)
        $position -= $readLength
        $stream.Position = $position
        $buffer = New-Object byte[] $readLength
        $read = $stream.Read($buffer, 0, $readLength)
        if ($read -le 0) { return 0 }
        $State.bootstrapPosition = $position
        $chunk = [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        $discardTail = [bool]$State.bootstrapDiscardTail
        if ($discardTail) {
            $lastNewline = $chunk.LastIndexOf("`n", [StringComparison]::Ordinal)
            if ($lastNewline -lt 0) {
                if ($position -eq 0) { $State.bootstrapComplete = $true }
                return $read
            }
            $chunk = $chunk.Substring(0, $lastNewline + 1)
            $discardTail = $false
        }

        $text = $chunk + [string]$State.bootstrapCarry
        $lines = [Text.RegularExpressions.Regex]::Split($text, "`r?`n")
        $carry = $lines[0]
        $foundEvents = New-Object 'Collections.Generic.List[object]'
        for ($index = $lines.Length - 1; $index -ge 1; $index--) {
            $event = ConvertTo-TrackerMapStateEvent -Line $lines[$index]
            if ($null -ne $event) { $foundEvents.Add($event) }
        }

        if ($carry.Length -gt 16384) {
            $carry = ""
            $discardTail = $true
        }
        $State.bootstrapCarry = $carry
        $State.bootstrapDiscardTail = $discardTail
        if ($position -eq 0) {
            if (-not $discardTail -and -not [string]::IsNullOrWhiteSpace($carry)) {
                $event = ConvertTo-TrackerMapStateEvent -Line $carry
                if ($null -ne $event) { $foundEvents.Add($event) }
            }
            $State.bootstrapCarry = ""
            $State.bootstrapDiscardTail = $false
            $State.bootstrapComplete = $true
        }
        if ($foundEvents.Count -gt 0) {
            $State.events = @(
                @($State.events) + @($foundEvents.ToArray()) |
                    Sort-Object -Property observedAt |
                    Select-Object -Last 512
            )
        }
        return $read
    } catch {
        return 0
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-TrackerLogCommittedState {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        if ($stream.Length -eq 0) {
            return [pscustomobject]@{ offset = [long]0; discardUntilNewline = $false }
        }
        $stream.Position = $stream.Length - 1
        if ($stream.ReadByte() -eq 10) {
            return [pscustomobject]@{ offset = [long]$stream.Length; discardUntilNewline = $false }
        }
        $maximumScan = [long][Math]::Min(16384, $stream.Length)
        $start = $stream.Length - $maximumScan
        $stream.Position = $start
        $buffer = New-Object byte[] ([int]$maximumScan)
        $read = $stream.Read($buffer, 0, $buffer.Length)
        for ($index = $read - 1; $index -ge 0; $index--) {
            if ($buffer[$index] -eq 10) {
                return [pscustomobject]@{
                    offset = [long]($start + $index + 1)
                    discardUntilNewline = $false
                }
            }
        }
        if ($stream.Length -le 16384) {
            return [pscustomobject]@{ offset = [long]0; discardUntilNewline = $false }
        }
        return [pscustomobject]@{ offset = [long]$stream.Length; discardUntilNewline = $true }
    } catch {
        return $null
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-TrackerLogHeadFingerprint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        $buffer = New-Object byte[] ([int][Math]::Min([long]512, $stream.Length))
        $read = if ($buffer.Length -gt 0) { $stream.Read($buffer, 0, $buffer.Length) } else { 0 }
        return [Convert]::ToBase64String($buffer, 0, $read)
    } catch {
        return $null
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-TrackerLogBoundaryFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$Offset
    )

    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        if ($Offset -lt 0 -or $Offset -gt $stream.Length) { return $null }
        $length = [int][Math]::Min([long]512, $Offset)
        if ($length -eq 0) { return "" }
        $stream.Position = $Offset - $length
        $buffer = New-Object byte[] $length
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -ne $length) { return $null }
        return [Convert]::ToBase64String($buffer, 0, $read)
    } catch {
        return $null
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-TrackerMapStateEvents {
    param(
        [switch]$AdvanceBootstrap,
        [ValidateRange(1, 1048576)]
        [int]$BootstrapByteBudget = $trackerMapBootstrapByteBudget
    )

    $sessionPath = Get-TrackerGameLogSession
    if ([string]::IsNullOrWhiteSpace($sessionPath) -or -not [IO.Directory]::Exists($sessionPath)) {
        return @()
    }

    if ($script:trackerMapStateCacheSession -cne $sessionPath) {
        $script:trackerMapStateCacheSession = $sessionPath
        $script:trackerMapLogFileStates = @{}
        $script:trackerMapArchivedEvents = @()
        $script:trackerMapBootstrapRoundRobinIndex = 0
    }

    $applicationLogs = New-Object 'Collections.Generic.List[object]'
    try {
        foreach ($path in [IO.Directory]::EnumerateFiles($sessionPath, "*application*.log", [IO.SearchOption]::TopDirectoryOnly)) {
            try { $applicationLogs.Add([IO.FileInfo]::new($path)) } catch { }
        }
    } catch {
        return @()
    }
    $currentPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($logFile in @($applicationLogs | Sort-Object -Property LastWriteTimeUtc -Descending)) {
        [void]$currentPaths.Add($logFile.FullName)
        $state = if ($script:trackerMapLogFileStates.ContainsKey($logFile.FullName)) {
            $script:trackerMapLogFileStates[$logFile.FullName]
        } else {
            $null
        }
        $headFingerprint = Get-TrackerLogHeadFingerprint -Path $logFile.FullName
        if ($null -eq $headFingerprint) {
            if ($null -eq $state) {
                $state = [pscustomobject]@{
                    offset = [long]0
                    discardUntilNewline = $false
                    lastWriteTicks = [long]$logFile.LastWriteTimeUtc.Ticks
                    headFingerprint = ""
                    boundaryFingerprint = ""
                    sourceAvailable = $false
                    events = @()
                    bootstrapPosition = [long]0
                    bootstrapCarry = ""
                    bootstrapDiscardTail = $false
                    bootstrapComplete = $false
                }
                $script:trackerMapLogFileStates[$logFile.FullName] = $state
            } else {
                $state.sourceAvailable = $false
                $state.events = @()
                $state.bootstrapComplete = $false
            }
            continue
        }
        $boundaryFingerprint = if (
            $null -ne $state -and
            $logFile.Length -ge [long]$state.offset
        ) {
            Get-TrackerLogBoundaryFingerprint -Path $logFile.FullName -Offset ([long]$state.offset)
        } else {
            ""
        }
        if (
            $null -ne $state -and
            $logFile.Length -ge [long]$state.offset -and
            $null -eq $boundaryFingerprint
        ) {
            $state.sourceAvailable = $false
            $state.events = @()
            $state.bootstrapComplete = $false
            continue
        }
        $mustReset = $null -eq $state -or -not [bool]$state.sourceAvailable -or $logFile.Length -lt [long]$state.offset -or (
            $logFile.Length -eq [long]$state.offset -and
            $logFile.LastWriteTimeUtc.Ticks -ne [long]$state.lastWriteTicks
        ) -or (
            $null -ne $state -and (
                $headFingerprint -cne [string]$state.headFingerprint -or
                $boundaryFingerprint -cne [string]$state.boundaryFingerprint
            )
        )
        if ($mustReset) {
            $committedState = Get-TrackerLogCommittedState -Path $logFile.FullName
            if ($null -eq $committedState) {
                $state = [pscustomobject]@{
                    offset = [long]0
                    discardUntilNewline = $false
                    lastWriteTicks = [long]$logFile.LastWriteTimeUtc.Ticks
                    headFingerprint = $headFingerprint
                    boundaryFingerprint = ""
                    sourceAvailable = $false
                    events = @()
                    bootstrapPosition = [long]0
                    bootstrapCarry = ""
                    bootstrapDiscardTail = $false
                    bootstrapComplete = $false
                }
                $script:trackerMapLogFileStates[$logFile.FullName] = $state
                continue
            }
            $committedBoundaryFingerprint = Get-TrackerLogBoundaryFingerprint `
                -Path $logFile.FullName `
                -Offset ([long]$committedState.offset)
            $state = [pscustomobject]@{
                offset = [long]$committedState.offset
                discardUntilNewline = [bool]$committedState.discardUntilNewline
                lastWriteTicks = [long]$logFile.LastWriteTimeUtc.Ticks
                headFingerprint = $headFingerprint
                boundaryFingerprint = if ($null -eq $committedBoundaryFingerprint) { "" } else { $committedBoundaryFingerprint }
                sourceAvailable = $null -ne $committedBoundaryFingerprint
                events = @()
                bootstrapPosition = [long]$committedState.offset
                bootstrapCarry = ""
                bootstrapDiscardTail = [bool]$committedState.discardUntilNewline
                bootstrapComplete = $null -ne $committedBoundaryFingerprint -and [long]$committedState.offset -eq 0
            }
            $script:trackerMapLogFileStates[$logFile.FullName] = $state
            if (-not [bool]$state.sourceAvailable) { continue }
        }
        if ($logFile.Length -gt [long]$state.offset -or $mustReset) {
            $append = Read-TrackerLogStateAppend `
                -Path $logFile.FullName `
                -StartOffset ([long]$state.offset) `
                -DiscardUntilNewline ([bool]$state.discardUntilNewline)
            if ($null -ne $append) {
                $combinedEvents = @($state.events) + @($append.events)
                $appendBoundaryFingerprint = Get-TrackerLogBoundaryFingerprint `
                    -Path $logFile.FullName `
                    -Offset ([long]$append.offset)
                $state = [pscustomobject]@{
                    offset = [long]$append.offset
                    discardUntilNewline = [bool]$append.discardUntilNewline
                    lastWriteTicks = [long]$logFile.LastWriteTimeUtc.Ticks
                    headFingerprint = $headFingerprint
                    boundaryFingerprint = if ($null -eq $appendBoundaryFingerprint) { "" } else { $appendBoundaryFingerprint }
                    sourceAvailable = $null -ne $appendBoundaryFingerprint
                    events = @($combinedEvents | Sort-Object -Property observedAt | Select-Object -Last 512)
                    bootstrapPosition = [long]$state.bootstrapPosition
                    bootstrapCarry = [string]$state.bootstrapCarry
                    bootstrapDiscardTail = [bool]$state.bootstrapDiscardTail
                    bootstrapComplete = [bool]$state.bootstrapComplete
                }
                $script:trackerMapLogFileStates[$logFile.FullName] = $state
            } else {
                $state.sourceAvailable = $false
                $state.events = @()
                $state.bootstrapComplete = $false
            }
        }
    }
    foreach ($knownPath in @($script:trackerMapLogFileStates.Keys)) {
        if (-not $currentPaths.Contains([string]$knownPath)) {
            $script:trackerMapArchivedEvents = @(
                @($script:trackerMapArchivedEvents) + @($script:trackerMapLogFileStates[$knownPath].events) |
                    Sort-Object -Property observedAt |
                    Select-Object -Last 512
            )
            $script:trackerMapLogFileStates.Remove($knownPath)
        }
    }

    if ($AdvanceBootstrap -and $script:trackerMapLogFileStates.Count -gt 0) {
        $paths = @($script:trackerMapLogFileStates.Keys | Sort-Object)
        $remainingBytes = $BootstrapByteBudget
        $visitsWithoutProgress = 0
        while ($remainingBytes -gt 0 -and $visitsWithoutProgress -lt $paths.Count) {
            $index = $script:trackerMapBootstrapRoundRobinIndex % $paths.Count
            $path = [string]$paths[$index]
            $script:trackerMapBootstrapRoundRobinIndex = ($index + 1) % $paths.Count
            $state = $script:trackerMapLogFileStates[$path]
            if ([bool]$state.bootstrapComplete) {
                $visitsWithoutProgress++
                continue
            }
            $maximumBytes = [int][Math]::Min(
                [long]$trackerMapBootstrapFileByteBudget,
                [long]$remainingBytes
            )
            $read = Advance-TrackerLogBootstrapState `
                -Path $path `
                -State $state `
                -MaximumBytes $maximumBytes
            if ([int]$read -gt 0) {
                $remainingBytes -= [int]$read
                $visitsWithoutProgress = 0
            } else {
                $visitsWithoutProgress++
            }
        }
    }

    $states = @($script:trackerMapArchivedEvents) + @(
        $script:trackerMapLogFileStates.Values | ForEach-Object { $_.events }
    )
    return @($states | Sort-Object -Property observedAt | Select-Object -Last 1024)
}

function Test-TrackerMapBootstrapReady {
    if (
        [string]::IsNullOrWhiteSpace([string]$script:trackerMapStateCacheSession) -or
        $script:trackerMapLogFileStates.Count -eq 0
    ) {
        return $false
    }
    foreach ($state in $script:trackerMapLogFileStates.Values) {
        if (-not [bool]$state.sourceAvailable -or -not [bool]$state.bootstrapComplete) { return $false }
    }
    return $true
}

function Get-TrackerMapKeyForScreenshot {
    param(
        [string]$FileName,
        [Nullable[DateTime]]$FileWrittenAt
    )

    $capturedAt = Get-TrackerScreenshotCapturedAt -FileName $FileName
    if ($null -eq $capturedAt -or $null -eq $FileWrittenAt) { return $null }
    $correlationAt = [DateTime]$FileWrittenAt
    if ($correlationAt.Kind -eq [DateTimeKind]::Utc) {
        $correlationAt = $correlationAt.ToLocalTime()
    }
    if ([Math]::Abs(($correlationAt - $capturedAt).TotalMinutes) -gt 2) { return $null }
    $notBefore = $correlationAt.AddMinutes(-$trackerMapObservationMaximumAgeMinutes)
    $states = @(
        Get-TrackerMapStateEvents `
            -AdvanceBootstrap `
            -BootstrapByteBudget $trackerMapScreenshotBootstrapByteBudget
    )
    if (-not (Test-TrackerMapBootstrapReady)) { return $null }
    $latestState = @(
        $states |
            Where-Object { $_.observedAt -ge $notBefore -and $_.observedAt -le $correlationAt } |
            Sort-Object -Property observedAt -Descending |
            Select-Object -First 1
    )
    if ($latestState.Count -ne 1 -or $latestState[0].kind -cne "MAP") { return $null }
    return ConvertTo-TrackerMapKey -MapName ([string]$latestState[0].rawMapName)
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
        Write-PortableLog "Screenshot watcher startup failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
        Stop-ScreenshotWatcher
        $script:screenshotWatcherState = [pscustomobject]@{
            state = "ERROR"
            message = "The screenshot folder could not be monitored."
        }
        $script:screenshotNextDiscoveryUtc = [DateTime]::UtcNow.AddSeconds($trackerDiscoveryIntervalSeconds)
    }
}

function Add-ScreenshotEvent {
    param(
        [string]$FileName,
        [Nullable[DateTime]]$FileWrittenAt
    )

    if ([string]::IsNullOrWhiteSpace($FileName) -or $FileName.Length -gt 255) { return }
    if ([IO.Path]::GetFileName($FileName) -ne $FileName) { return }
    if (-not [IO.Path]::GetExtension($FileName).Equals(".png", [StringComparison]::OrdinalIgnoreCase)) { return }

    $event = [ordered]@{
        type = "SCREENSHOT_CREATED"
        sequence = $script:trackerLatestCursor + 1
        fileName = $FileName
        detectedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    }
    $mapKey = Get-TrackerMapKeyForScreenshot -FileName $FileName -FileWrittenAt $FileWrittenAt
    if (-not [string]::IsNullOrWhiteSpace($mapKey)) { $event.mapKey = $mapKey }

    $script:trackerLatestCursor++
    $script:trackerEvents.Add([pscustomobject]$event)
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
        Write-PortableLog "Screenshot watcher reported a background error and will be restarted."
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
            Write-PortableLog "Screenshot watcher reconciliation failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
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
        $fileWrittenAt = $null
        try {
            $filePath = Join-Path $script:screenshotWatcher.Path $fileName
            if ([IO.File]::Exists($filePath)) {
                $file = [IO.FileInfo]::new($filePath)
                $fileWrittenAt = $file.LastWriteTime
                $script:screenshotFingerprints[$fileName] = [pscustomobject]@{
                    fileName = $fileName
                    fingerprint = "$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
                    lastWriteUtc = $file.LastWriteTimeUtc
                }
            }
        } catch {
            # The filename-only event remains useful if the game has already moved the file.
        }
        $null = @(Get-TrackerMapStateEvents -AdvanceBootstrap)
        $bootstrapReady = Test-TrackerMapBootstrapReady
        if (
            -not $bootstrapReady -and
            ($now - $script:screenshotPendingFiles[$fileName]).TotalSeconds -lt $trackerMapPendingFallbackSeconds
        ) { continue }
        $script:screenshotPendingFiles.Remove($fileName)
        $correlationFileWrittenAt = if ($bootstrapReady) { $fileWrittenAt } else { $null }
        Add-ScreenshotEvent `
            -FileName $fileName `
            -FileWrittenAt $correlationFileWrittenAt
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
        [object[]]$TransferEncodingHeaders,
        [ValidateRange(2, 65536)]
        [int]$MaximumBytes = 8192
    )

    $contentLength = 0
    if (
        $TransferEncodingHeaders.Count -ne 0 -or
        $ContentLengthHeaders.Count -ne 1 -or
        $ContentLengthHeaders[0] -notmatch "^\d{1,5}$" -or
        -not [int]::TryParse([string]($ContentLengthHeaders[0]), [ref]$contentLength) -or
        $contentLength -lt 2 -or
        $contentLength -gt $MaximumBytes -or
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
        if ($AllowedProperties -cnotcontains $property) {
            throw [ArgumentException]::new("The request contains an unsupported property.")
        }
    }
    foreach ($property in $RequiredProperties) {
        if ($properties -cnotcontains $property) {
            throw [ArgumentException]::new("The request is missing a required property.")
        }
    }
}

function Get-ModdingPreviewHash {
    param([string]$Value)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Convert-ModdingPreviewBuild {
    param([pscustomobject]$Value)
    Assert-JsonObjectShape -Value $Value -AllowedProperties @("root", "angle") -RequiredProperties @("root", "angle")
    if (($Value.angle -isnot [int] -and $Value.angle -isnot [long]) -or $Value.angle -notin @(-30, 0, 30)) {
        throw [ArgumentException]::new("The preview angle is invalid.")
    }
    $items = [Collections.Generic.List[object]]::new()
    $instances = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    function Visit-PreviewNode {
        param($Node, [int]$Depth, [string]$NodePath, [string]$ParentId, [string]$ParentTpl)
        if ($Node -isnot [pscustomobject] -or $Depth -gt 12 -or $items.Count -ge 96) { throw [ArgumentException]::new("The preview tree is invalid.") }
        Assert-JsonObjectShape -Value $Node -AllowedProperties @("instanceId", "itemId", "slotId", "children") -RequiredProperties @("instanceId", "itemId", "children")
        if ($Node.instanceId -isnot [string] -or $Node.instanceId -cnotmatch '^[A-Za-z0-9:_/-]{1,2048}$' -or
            -not $instances.Add($Node.instanceId) -or $Node.itemId -isnot [string] -or
            $Node.itemId -cnotmatch '^[0-9a-f]{24}$' -or $Node.children -isnot [Array]) { throw [ArgumentException]::new("The preview node is invalid.") }
        if (($Depth -gt 0 -and ($Node.slotId -isnot [string] -or $Node.slotId -cnotmatch '^[0-9a-f]{24}$')) -or
            ($Depth -eq 0 -and $null -ne $Node.slotId)) { throw [ArgumentException]::new("The preview slot is invalid.") }
        $id = (Get-ModdingPreviewHash $NodePath).Substring(0, 24)
        $items.Add([pscustomobject]@{ _id = $id; _tpl = [string]$Node.itemId; parentId = $ParentId; parentTplId = $ParentTpl; slotId = [string]$Node.slotId })
        $occupied = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($child in @($Node.children | Sort-Object -Property slotId)) {
            if ($null -eq $child -or -not $occupied.Add([string]$child.slotId)) { throw [ArgumentException]::new("The preview slot is repeated.") }
            Visit-PreviewNode -Node $child -Depth ($Depth + 1) -NodePath "$id/$($child.slotId)" -ParentId $id -ParentTpl $Node.itemId
        }
    }
    Visit-PreviewNode -Node $Value.root -Depth 0 -NodePath "root:$($Value.root.itemId)" -ParentId "" -ParentTpl ""
    return [pscustomobject]@{ angle = [int]$Value.angle; items = @($items.ToArray()) }
}

function Invoke-ModdingPreviewHttp {
    param([string]$BaseUrl, [string]$Path, [string]$BodyJson, [int]$MaximumBytes, [Diagnostics.Stopwatch]$Clock)
    $remaining = 28000 - [int]$Clock.ElapsedMilliseconds
    if ($remaining -le 0) { throw [TimeoutException]::new("Preview deadline exceeded.") }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $uri = [Uri]::new($BaseUrl + $Path)
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = [Math]::Min(10000, $remaining)
    $request.ReadWriteTimeout = $request.Timeout
    $request.UserAgent = "TarkovHelperWeb-Preview/1"
    $request.Accept = "application/json, image/png, image/jpeg, image/webp"
    $response = $null
    $memory = [IO.MemoryStream]::new()
    try {
        if (-not [string]::IsNullOrEmpty($BodyJson)) {
            $request.Method = "POST"
            $request.ContentType = "application/json; charset=utf-8"
            $bytes = [Text.Encoding]::UTF8.GetBytes($BodyJson)
            $request.ContentLength = $bytes.Length
            $output = $request.GetRequestStream()
            try { $output.Write($bytes, 0, $bytes.Length) } finally { $output.Dispose() }
        }
        try { $response = [Net.HttpWebResponse]$request.GetResponse() }
        catch [Net.WebException] {
            if ($_.Exception.Status -eq [Net.WebExceptionStatus]::Timeout) { throw [TimeoutException]::new("Preview upstream timed out.") }
            if ($null -eq $_.Exception.Response) { throw }
            $response = [Net.HttpWebResponse]$_.Exception.Response
        }
        if ([int]$response.StatusCode -eq 429) {
            $retryAfter = [long]60
            $seconds = [double]0
            $maximumPause = [Math]::Floor(([DateTime]::MaxValue - [DateTime]::UtcNow).TotalSeconds) - 1
            $retryHeader = [string]$response.Headers["Retry-After"]
            if ($retryHeader -match '^\d+$' -and [double]::TryParse($retryHeader, [ref]$seconds) -and $seconds -gt 0) { $retryAfter = [long][Math]::Min($maximumPause, $seconds) }
            else {
                $retryDate = [DateTime]::MinValue
                if ([DateTime]::TryParse([string]$response.Headers["Retry-After"], [ref]$retryDate)) {
                    $retryAfter = [long][Math]::Min($maximumPause, [Math]::Max(1, [Math]::Ceiling(($retryDate.ToUniversalTime() - [DateTime]::UtcNow).TotalSeconds)))
                }
            }
            $error = [InvalidOperationException]::new("Preview rate limited.")
            $error.Data["retryAfterSeconds"] = $retryAfter
            throw $error
        }
        if ([int]$response.StatusCode -ne 200 -or $response.ResponseUri.AbsoluteUri -cne $uri.AbsoluteUri) { throw [IO.InvalidDataException]::new("Preview upstream response rejected.") }
        if ($response.ContentLength -gt $MaximumBytes) { throw [IO.InvalidDataException]::new("Preview response is too large.") }
        $inputStream = $response.GetResponseStream()
        try {
            $buffer = New-Object byte[] 8192
            while ($true) {
                $remaining = 28000 - [int]$Clock.ElapsedMilliseconds
                if ($remaining -le 0) { throw [TimeoutException]::new("Preview deadline exceeded.") }
                $inputStream.ReadTimeout = [Math]::Min(10000, $remaining)
                $count = $inputStream.Read($buffer, 0, $buffer.Length)
                if ($count -eq 0) { break }
                if ($memory.Length + $count -gt $MaximumBytes) { throw [IO.InvalidDataException]::new("Preview response is too large.") }
                $memory.Write($buffer, 0, $count)
            }
        } finally { $inputStream.Dispose() }
        return [pscustomobject]@{ bytes = $memory.ToArray(); contentType = ([string]$response.ContentType).Split(";", 2)[0].Trim().ToLowerInvariant() }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $memory.Dispose()
        $request.Abort()
    }
}

function Read-ModdingPreviewJson {
    param($Response)
    if ($Response.contentType -cne "application/json") { throw [IO.InvalidDataException]::new("Expected preview JSON.") }
    try {
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $value = ConvertFrom-Json -InputObject $utf8.GetString($Response.bytes) -ErrorAction Stop
        if ($value -isnot [pscustomobject]) { throw "Expected object" }
        return $value
    } catch { throw [IO.InvalidDataException]::new("Invalid preview JSON.") }
}

function Invoke-ModdingPreviewRender {
    param($Build, [string]$BaseUrl, [hashtable]$SlotCache)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $outputItems = [Collections.Generic.List[object]]::new()
        foreach ($item in $Build.items) {
            $entry = [ordered]@{ _id = $item._id; _tpl = $item._tpl }
            if ([string]::IsNullOrEmpty($item.parentId)) { $entry.slotId = "FirstPrimaryWeapon" }
            else {
                $parentTpl = [string]$item.parentTplId
                $cached = $SlotCache[$parentTpl]
                if ($null -eq $cached -or $cached.expiresAt -lt [DateTime]::UtcNow) {
                    $slotsResponse = Invoke-ModdingPreviewHttp -BaseUrl $BaseUrl -Path "/api/item-slots/$parentTpl" -MaximumBytes 1048576 -Clock $clock
                    $slotsPayload = Read-ModdingPreviewJson $slotsResponse
                    if ($slotsPayload.slots -isnot [Array] -or $slotsPayload.slots.Count -gt 512) { throw [IO.InvalidDataException]::new("Invalid preview slots.") }
                    $cached = @{ slots = $slotsPayload.slots; expiresAt = [DateTime]::UtcNow.AddHours(24); byteCount = $slotsResponse.bytes.Length }
                    if ($SlotCache.Count -ge 256) { $SlotCache.Remove(@($SlotCache.Keys)[0]) }
                    $SlotCache[$parentTpl] = $cached
                    $slotBytes = 0
                    foreach ($slotEntry in $SlotCache.Values) { $slotBytes += $slotEntry.byteCount }
                    while ($slotBytes -gt 4194304) {
                        $evicted = @($SlotCache.Keys | Where-Object { $_ -cne $parentTpl })[0]
                        $slotBytes -= $SlotCache[$evicted].byteCount
                        $SlotCache.Remove($evicted)
                    }
                }
                $slotMatches = @($cached.slots | Where-Object { $_.parentTplId -ceq $parentTpl -and $_.slotId -ceq $item.slotId })
                if ($slotMatches.Count -ne 1 -or $slotMatches[0].slotName -isnot [string] -or
                    $slotMatches[0].slotName -cnotmatch '^[A-Za-z][A-Za-z0-9_]{0,95}$' -or
                    $slotMatches[0].resolvedItemTplIds -isnot [Array] -or
                    $slotMatches[0].resolvedItemTplIds -cnotcontains $item._tpl) { throw [ArgumentException]::new("The exact preview slot mapping is unavailable.") }
                $entry.parentId = $item.parentId
                $entry.slotId = $slotMatches[0].slotName
            }
            $outputItems.Add([pscustomobject]$entry)
        }
        $payload = [ordered]@{ data = [ordered]@{ id = $Build.items[0]._id; items = @($outputItems.ToArray()) } }
        $generatePath = "/api/generate-build"
        if ($Build.angle -ne 0) {
            $payload.data.rotationX = 0
            $payload.data.rotationY = $Build.angle
            $generatePath = "/api/generate-build-rotated"
        }
        $body = ConvertTo-Json -InputObject $payload -Compress -Depth 8
        $generated = Read-ModdingPreviewJson (Invoke-ModdingPreviewHttp -BaseUrl $BaseUrl -Path $generatePath -BodyJson $body -MaximumBytes 1048576 -Clock $clock)
        if ($generated.ok -isnot [bool] -or -not $generated.ok -or $generated.imageUrl -isnot [string]) { throw [IO.InvalidDataException]::new("Preview generation failed.") }
        $imagePath = [string]$generated.imageUrl
        if ($imagePath.StartsWith($BaseUrl + "/", [StringComparison]::Ordinal)) { $imagePath = $imagePath.Substring($BaseUrl.Length) }
        if ($imagePath -cnotmatch '^/api/images/(?:build|icon)_[A-Za-z0-9_-]{1,160}$') { throw [IO.InvalidDataException]::new("Preview image location rejected.") }
        $image = Invoke-ModdingPreviewHttp -BaseUrl $BaseUrl -Path $imagePath -MaximumBytes 5242880 -Clock $clock
        $bytes = $image.bytes
        $validImage = switch ($image.contentType) {
            "image/png" {
                if ($bytes.Length -lt 24 -or [BitConverter]::ToString($bytes, 0, 8) -cne "89-50-4E-47-0D-0A-1A-0A") { $false }
                else {
                    $width = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes, 16))
                    $height = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes, 20))
                    $width -gt 0 -and $height -gt 0 -and $width -le 8192 -and $height -le 8192 -and [long]$width * $height -le 16777216
                }
            }
            "image/jpeg" { $bytes.Length -ge 3 -and $bytes[0] -eq 255 -and $bytes[1] -eq 216 -and $bytes[2] -eq 255 }
            "image/webp" { $bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ceq "RIFF" -and [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ceq "WEBP" }
            default { $false }
        }
        if (-not $validImage) { throw [IO.InvalidDataException]::new("Preview image format rejected.") }
        return @{ status = 200; value = @{ imageUrl = "data:$($image.contentType);base64,$([Convert]::ToBase64String($bytes))" } }
    } catch {
        $exception = $_.Exception
        $status = 502; $code = "PROVIDER_UNAVAILABLE"; $message = "The preview provider is unavailable."
        $retryAfter = $null
        $timedOut = $clock.ElapsedMilliseconds -ge 28000
        $cause = $exception
        while ($null -ne $cause) {
            if ($cause -is [TimeoutException] -or
                ($cause -is [Net.WebException] -and $cause.Status -eq [Net.WebExceptionStatus]::Timeout) -or
                ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::TimedOut)) { $timedOut = $true }
            $cause = $cause.InnerException
        }
        if ($exception.Data.Contains("retryAfterSeconds")) { $status = 429; $code = "RATE_LIMITED"; $message = "The preview provider requested a pause."; $retryAfter = [long]$exception.Data["retryAfterSeconds"] }
        elseif ($timedOut) { $status = 504; $code = "PROVIDER_TIMEOUT"; $message = "The preview provider timed out." }
        elseif ($exception -is [ArgumentException]) { $status = 422; $code = "SLOT_UNAVAILABLE"; $message = "An exact compatible slot mapping is unavailable." }
        elseif ($exception -is [IO.InvalidDataException]) { $code = "PROVIDER_RESPONSE"; $message = "The preview provider returned an invalid response." }
        $errorValue = @{ code = $code; message = $message }
        if ($null -ne $retryAfter) { $errorValue.retryAfterSeconds = $retryAfter }
        return @{ status = $status; value = @{ error = $errorValue } }
    }
}

function Complete-ModdingPreviewJob {
    if ($null -eq $script:moddingPreviewJob -or -not $script:moddingPreviewJob.async.IsCompleted) { return }
    $job = $script:moddingPreviewJob
    $script:moddingPreviewJob = $null
    try {
        $results = $job.worker.EndInvoke($job.async)
        if ($results.Count -ne 1) { throw "Invalid preview worker result" }
        $result = $results[0]
        if ($result.status -eq 200) {
            $script:moddingPreviewCache[$job.key] = $result.value
            $cacheBytes = 0
            foreach ($value in $script:moddingPreviewCache.Values) { $cacheBytes += [Text.Encoding]::UTF8.GetByteCount($value.imageUrl) }
            while ($script:moddingPreviewCache.Count -gt 8 -or $cacheBytes -gt 33554432) {
                $oldest = @($script:moddingPreviewCache.Keys)[0]
                $cacheBytes -= [Text.Encoding]::UTF8.GetByteCount($script:moddingPreviewCache[$oldest].imageUrl)
                $script:moddingPreviewCache.Remove($oldest)
            }
        } elseif ($result.status -eq 429) {
            $script:moddingPreviewCooldownUtc = [DateTime]::UtcNow.AddSeconds($result.value.error.retryAfterSeconds)
        }
        Send-JsonResponse -Stream $job.stream -StatusCode $result.status -Reason "Preview" -Value $result.value
    } catch {
        try { Send-JsonError -Stream $job.stream -StatusCode 502 -Reason "Bad Gateway" -Code "PROVIDER_UNAVAILABLE" -Message "The preview could not be completed." } catch { }
    } finally { $job.client.Dispose(); $job.worker.Dispose() }
}

function Start-ModdingPreviewJob {
    param($Build, [string]$Key, $Client, $Stream)
    $worker = [PowerShell]::Create()
    try {
        $source = 'param($Build, $BaseUrl, $SlotCache); $ErrorActionPreference = "Stop";' + "`n"
        foreach ($name in @("Invoke-ModdingPreviewHttp", "Read-ModdingPreviewJson", "Invoke-ModdingPreviewRender")) {
            $source += "function $name { $((Get-Item ('function:' + $name)).Definition) }`n"
        }
        $source += 'Invoke-ModdingPreviewRender -Build $Build -BaseUrl $BaseUrl -SlotCache $SlotCache'
        $null = $worker.AddScript($source).AddArgument($Build).AddArgument($script:moddingPreviewUpstreamBaseUrl).AddArgument($script:moddingPreviewSlotCache)
        $script:moddingPreviewJob = @{ worker = $worker; async = $worker.BeginInvoke(); key = $Key; client = $Client; stream = $Stream }
    } catch { $worker.Dispose(); throw }
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

function Test-BoundedPriceInteger {
    param(
        [AllowNull()][object]$Value,
        [long]$Maximum = 2000000000
    )

    if ($null -eq $Value -or $Value -is [bool]) { return $false }
    try {
        $number = [Convert]::ToDouble($Value, [Globalization.CultureInfo]::InvariantCulture)
        return (
            -not [double]::IsNaN($number) -and
            -not [double]::IsInfinity($number) -and
            $number -ge 0 -and
            $number -le $Maximum -and
            $number -eq [Math]::Truncate($number)
        )
    } catch {
        return $false
    }
}

function Format-ItemPriceTimestamp {
    param([Parameter(Mandatory = $true)][DateTime]$Value)
    return $Value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function Assert-PriceObjectShape {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Value,
        [Parameter(Mandatory = $true)][string[]]$AllowedProperties,
        [string[]]$RequiredProperties = @()
    )

    $properties = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($property in $properties) {
        if ($AllowedProperties -cnotcontains $property) {
            throw [IO.InvalidDataException]::new("The price payload contains an unsupported property.")
        }
    }
    foreach ($property in $RequiredProperties) {
        if ($properties -cnotcontains $property) {
            throw [IO.InvalidDataException]::new("The price payload is missing a required property.")
        }
    }
}

function Convert-PriceHistoryPayload {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Payload,
        [Parameter(Mandatory = $true)][string]$ItemId,
        [Parameter(Mandatory = $true)][string]$GameMode
    )

    Assert-PriceObjectShape -Value $Payload -AllowedProperties @("data", "translations") -RequiredProperties @("data")
    if ($Payload.data -isnot [Array]) {
        throw [IO.InvalidDataException]::new("The price history must be an array.")
    }
    $rawPoints = @($Payload.data)
    if ($rawPoints.Count -lt 1 -or $rawPoints.Count -gt 5000) {
        throw [IO.InvalidDataException]::new("The price history count is invalid.")
    }

    $points = New-Object 'Collections.Generic.List[object]'
    foreach ($rawPoint in $rawPoints) {
        if ($rawPoint -isnot [pscustomobject]) {
            throw [IO.InvalidDataException]::new("A price history point is invalid.")
        }
        Assert-PriceObjectShape -Value $rawPoint `
            -AllowedProperties @("priceMin", "price", "offerCount", "timestamp") `
            -RequiredProperties @("priceMin", "price", "timestamp")
        if (
            -not (Test-BoundedPriceInteger -Value $rawPoint.priceMin) -or
            -not (Test-BoundedPriceInteger -Value $rawPoint.price) -or
            -not (Test-BoundedPriceInteger -Value $rawPoint.timestamp -Maximum 4102444800000) -or
            ($null -ne $rawPoint.offerCount -and -not (Test-BoundedPriceInteger -Value $rawPoint.offerCount -Maximum 1000000))
        ) {
            throw [IO.InvalidDataException]::new("A price history value is out of range.")
        }
        $points.Add([pscustomobject]@{
            priceMin = [long]$rawPoint.priceMin
            price = [long]$rawPoint.price
            offerCount = if ($null -eq $rawPoint.offerCount) { $null } else { [long]$rawPoint.offerCount }
            timestamp = [long]$rawPoint.timestamp
        })
    }

    $orderedPoints = @($points | Sort-Object -Property timestamp)
    $latest = $orderedPoints[$orderedPoints.Count - 1]
    $dayStart = $latest.timestamp - 86400000
    $twoDayStart = $latest.timestamp - 172800000
    $lastDay = @($orderedPoints | Where-Object { $_.timestamp -ge $dayStart })
    $lastTwoDays = @($orderedPoints | Where-Object { $_.timestamp -ge $twoDayStart })
    if ($lastDay.Count -lt 1 -or $lastTwoDays.Count -lt 1) {
        throw [IO.InvalidDataException]::new("The price history window is empty.")
    }
    $average24 = [long][Math]::Round(
        [double](($lastDay | Measure-Object -Property price -Average).Average),
        0,
        [MidpointRounding]::AwayFromZero
    )
    $low24 = [long](($lastDay | Measure-Object -Property priceMin -Minimum).Minimum)
    $high24 = [long](($lastDay | Measure-Object -Property price -Maximum).Maximum)
    $oldest48 = $lastTwoDays[0]
    $change48 = if ($oldest48.price -eq 0) {
        $null
    } else {
        [Math]::Round((([double]$latest.price - [double]$oldest48.price) / [double]$oldest48.price) * 100, 2)
    }
    $fetchedAt = [DateTime]::UtcNow

    return [ordered]@{
        protocolVersion = $itemPriceProtocolVersion
        itemId = $ItemId
        gameMode = $GameMode
        source = "LIVE"
        fetchedAt = Format-ItemPriceTimestamp -Value $fetchedAt
        expiresAt = Format-ItemPriceTimestamp -Value $fetchedAt.AddSeconds($itemPriceFreshSeconds)
        isStale = $false
        flea = [ordered]@{
            lastLowPrice = [long]$latest.priceMin
            avg24hPrice = $average24
            low24hPrice = $low24
            high24hPrice = $high24
            changeLast48hPercent = $change48
            offerCount = $latest.offerCount
            updatedAt = Format-ItemPriceTimestamp -Value ([DateTimeOffset]::FromUnixTimeMilliseconds($latest.timestamp).UtcDateTime)
        }
    }
}

function Get-ItemPriceCacheDirectory {
    $directory = Join-Path (Initialize-StateDirectory) "price-cache-v1"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $info = [IO.DirectoryInfo]::new($directory)
    if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw [IO.IOException]::new("The item price cache directory is unsafe.")
    }
    return $info.FullName
}

function Get-ItemPriceCachePath {
    param([string]$ItemId, [string]$GameMode)
    if ($ItemId -notmatch '^[0-9a-f]{24}$' -or @("pvp", "pve") -cnotcontains $GameMode) {
        throw [ArgumentException]::new("The item price cache key is invalid.")
    }
    return Join-Path (Get-ItemPriceCacheDirectory) "$GameMode-$ItemId.json"
}

function Convert-CachedItemPriceQuote {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Value,
        [Parameter(Mandatory = $true)][string]$ItemId,
        [Parameter(Mandatory = $true)][string]$GameMode
    )

    Assert-PriceObjectShape -Value $Value `
        -AllowedProperties @("protocolVersion", "itemId", "gameMode", "source", "fetchedAt", "expiresAt", "isStale", "flea") `
        -RequiredProperties @("protocolVersion", "itemId", "gameMode", "source", "fetchedAt", "expiresAt", "isStale", "flea")
    if (
        $Value.protocolVersion -ne 1 -or
        $Value.itemId -cne $ItemId -or
        $Value.gameMode -cne $GameMode -or
        $Value.source -cne "LIVE" -or
        $Value.isStale -ne $false -or
        $Value.flea -isnot [pscustomobject]
    ) { throw [IO.InvalidDataException]::new("The cached price identity is invalid.") }
    $fetchedAt = [DateTime]::MinValue
    $expiresAt = [DateTime]::MinValue
    if (
        -not [DateTime]::TryParse([string]$Value.fetchedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$fetchedAt) -or
        -not [DateTime]::TryParse([string]$Value.expiresAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$expiresAt)
    ) { throw [IO.InvalidDataException]::new("The cached price timestamp is invalid.") }
    Assert-PriceObjectShape -Value $Value.flea `
        -AllowedProperties @("lastLowPrice", "avg24hPrice", "low24hPrice", "high24hPrice", "changeLast48hPercent", "offerCount", "updatedAt") `
        -RequiredProperties @("lastLowPrice", "avg24hPrice", "low24hPrice", "high24hPrice", "changeLast48hPercent", "offerCount", "updatedAt")
    foreach ($property in @("lastLowPrice", "avg24hPrice", "low24hPrice", "high24hPrice")) {
        if (-not (Test-BoundedPriceInteger -Value $Value.flea.$property)) {
            throw [IO.InvalidDataException]::new("The cached price value is invalid.")
        }
    }
    if ($null -ne $Value.flea.offerCount -and -not (Test-BoundedPriceInteger -Value $Value.flea.offerCount -Maximum 1000000)) {
        throw [IO.InvalidDataException]::new("The cached offer count is invalid.")
    }
    if ($null -ne $Value.flea.changeLast48hPercent) {
        try { $change = [double]$Value.flea.changeLast48hPercent } catch { throw [IO.InvalidDataException]::new("The cached change value is invalid.") }
        if ([double]::IsNaN($change) -or [double]::IsInfinity($change) -or [Math]::Abs($change) -gt 1000000) {
            throw [IO.InvalidDataException]::new("The cached change value is invalid.")
        }
    }
    $updatedAt = [DateTime]::MinValue
    if (-not [DateTime]::TryParse([string]$Value.flea.updatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$updatedAt)) {
        throw [IO.InvalidDataException]::new("The cached quote update timestamp is invalid.")
    }

    $now = [DateTime]::UtcNow
    $ageSeconds = ($now - $fetchedAt.ToUniversalTime()).TotalSeconds
    if ($ageSeconds -lt -300 -or $ageSeconds -gt $itemPriceStaleSeconds) { return $null }
    $isStale = $ageSeconds -gt $itemPriceFreshSeconds
    return [ordered]@{
        protocolVersion = 1
        itemId = $ItemId
        gameMode = $GameMode
        source = if ($isStale) { "STALE_CACHE" } else { "CACHE" }
        fetchedAt = Format-ItemPriceTimestamp -Value $fetchedAt
        expiresAt = Format-ItemPriceTimestamp -Value $expiresAt
        isStale = [bool]$isStale
        flea = $Value.flea
    }
}

function Read-ItemPriceCache {
    param([string]$ItemId, [string]$GameMode)
    try {
        $path = Get-ItemPriceCachePath -ItemId $ItemId -GameMode $GameMode
        if (-not [IO.File]::Exists($path)) { return $null }
        $info = [IO.FileInfo]::new($path)
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.Length -lt 2 -or $info.Length -gt 32768) { return $null }
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $value = ConvertFrom-Json -InputObject $strictUtf8.GetString([IO.File]::ReadAllBytes($path)) -ErrorAction Stop
        if ($value -isnot [pscustomobject]) { return $null }
        return Convert-CachedItemPriceQuote -Value $value -ItemId $ItemId -GameMode $GameMode
    } catch {
        return $null
    }
}

function Write-ItemPriceCache {
    param([string]$ItemId, [string]$GameMode, [object]$Quote)
    $temporaryPath = $null
    try {
        $path = Get-ItemPriceCachePath -ItemId $ItemId -GameMode $GameMode
        $temporaryPath = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
        $encoding = New-Object Text.UTF8Encoding($false)
        $bytes = $encoding.GetBytes((ConvertTo-Json -InputObject $Quote -Compress -Depth 6))
        $temporaryFile = [IO.FileStream]::new(
            $temporaryPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        try {
            $temporaryFile.Write($bytes, 0, $bytes.Length)
            $temporaryFile.Flush($true)
        } finally {
            $temporaryFile.Dispose()
        }
        if ([IO.File]::Exists($path)) {
            if (([IO.FileInfo]::new($path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw [IO.IOException]::new("The item price cache file is unsafe.")
            }
            [IO.File]::Replace($temporaryPath, $path, $null)
        } else {
            [IO.File]::Move($temporaryPath, $path)
        }
        $cacheFiles = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($path)) -File -Filter "*.json" | Sort-Object -Property LastWriteTimeUtc -Descending)
        foreach ($oldFile in @($cacheFiles | Select-Object -Skip 256)) {
            if ($oldFile.Name -match '^(pvp|pve)-[0-9a-f]{24}\.json$' -and ($oldFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                Remove-Item -LiteralPath $oldFile.FullName -Force
            }
        }
    } catch {
        Write-PortableLog "Item price cache write failed: $($_.Exception.GetType().Name)"
    } finally {
        if (-not [string]::IsNullOrWhiteSpace($temporaryPath) -and [IO.File]::Exists($temporaryPath)) {
            try {
                $temporaryInfo = [IO.FileInfo]::new($temporaryPath)
                if (($temporaryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                    Remove-Item -LiteralPath $temporaryPath -Force
                }
            } catch {
                # A later cache write can safely ignore an incomplete random temporary file.
            }
        }
    }
}

function Invoke-ItemPriceUpstream {
    param([string]$ItemId, [string]$GameMode)
    $upstreamMode = if ($GameMode -ceq "pvp") { "regular" } else { "pve" }
    $uri = [Uri]::new("$itemPriceUpstreamBaseUrl/$upstreamMode/prices/$ItemId")
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false
    $request.Method = "GET"
    $request.Accept = "application/json"
    $request.UserAgent = "TarkovHelper-Web-PriceBridge/1.0"
    $request.Timeout = 8000
    $request.ReadWriteTimeout = 8000
    $response = $null
    $stream = $null
    $memory = New-Object IO.MemoryStream
    try {
        $response = [Net.HttpWebResponse]$request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ResponseUri.AbsoluteUri -cne $uri.AbsoluteUri) {
            throw [IO.InvalidDataException]::new("The price upstream response was not a direct success.")
        }
        if (-not ([string]$response.ContentType).StartsWith("application/json", [StringComparison]::OrdinalIgnoreCase)) {
            throw [IO.InvalidDataException]::new("The price upstream response was not JSON.")
        }
        if ($response.ContentLength -gt $itemPriceMaximumBytes) {
            throw [IO.InvalidDataException]::new("The price upstream response exceeded the byte limit.")
        }
        $stream = $response.GetResponseStream()
        $buffer = New-Object byte[] 8192
        while ($true) {
            $count = $stream.Read($buffer, 0, $buffer.Length)
            if ($count -le 0) { break }
            if ($memory.Length + $count -gt $itemPriceMaximumBytes) {
                throw [IO.InvalidDataException]::new("The price upstream response exceeded the byte limit.")
            }
            $memory.Write($buffer, 0, $count)
        }
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $payload = ConvertFrom-Json -InputObject $strictUtf8.GetString($memory.ToArray()) -ErrorAction Stop
        if ($payload -isnot [pscustomobject]) {
            throw [IO.InvalidDataException]::new("The price upstream payload was invalid.")
        }
        return Convert-PriceHistoryPayload -Payload $payload -ItemId $ItemId -GameMode $GameMode
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $memory.Dispose()
    }
}

function Get-ItemPriceQuote {
    param([string]$ItemId, [string]$GameMode)
    $cached = Read-ItemPriceCache -ItemId $ItemId -GameMode $GameMode
    if ($null -ne $cached -and -not $cached.isStale) { return $cached }
    try {
        $live = Invoke-ItemPriceUpstream -ItemId $ItemId -GameMode $GameMode
        Write-ItemPriceCache -ItemId $ItemId -GameMode $GameMode -Quote $live
        return $live
    } catch {
        Write-PortableLog "Item price upstream failed for $GameMode/$ItemId`: $($_.Exception.GetType().Name)"
        if ($null -ne $cached) { return $cached }
        throw
    }
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
        instanceId = $trackerInstanceId
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

function Protect-PortableLogMessage {
    param([string]$Message)

    $text = if ($null -eq $Message) { "" } else { [string]$Message }
    $wasTruncated = $text.Length -gt 16384
    if ($wasTruncated) { $text = $text.Substring(0, [Math]::Min($text.Length, 16512)) }
    $text = $text -replace '[\u0000-\u001f\u007f-\u009f\u2028\u2029]+', ' '
    $text = $text -replace '(?i)\b(cookie|set-cookie)\s*[:=].*$', '${1}=[REDACTED]'
    $text = $text -replace '(?i)\b(authorization|proxy-authorization|x-tarkov-[a-z0-9-]+)\s*[:=].*$', '${1}=[REDACTED]'
    $text = $text -replace '(?i)(?<![A-Za-z0-9_])["'']?(token|nonce|secret|password|api[-_]?key|claimid|overlayid|candidateid|healthnonce|updatenonce|controltoken|leasetoken)["'']?\s*[:=].*$', '${1}=[REDACTED]'
    $text = $text -replace '(?i)\b(https?://)[^/@\s]+@', '$1[REDACTED]@'
    $text = $text -replace '(?i)(https?://[^\s?#]+)[?#][^\s]+', '$1?[REDACTED]'
    $text = $text -replace '(?i)(?<![A-Za-z0-9_])file:/+(?:localhost/)?(?:[A-Z]:/)?[^"<>\u0000-\u001f\u007f-\u009f\u2028\u2029]+', '[REDACTED]'
    $text = $text -replace '(?i)(?<![A-Za-z0-9_])(?:[A-Z]:[\\/]|\\\\)[^"<>|\r\n\u2028\u2029]+', '[REDACTED]'
    $text = $text -replace '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])', '[REDACTED]'
    $text = $text.Trim()
    if ($wasTruncated) {
        if ($text.Length -gt 128) { $text = $text.Substring(0, $text.Length - 128).TrimEnd() } else { $text = "" }
        $text = ($text + " [TRUNCATED]").Trim()
    }
    $encoding = New-Object Text.UTF8Encoding($false)
    if ($encoding.GetByteCount($text) -gt 3800) {
        $low = 0; $high = $text.Length
        while ($low -lt $high) {
            $middle = [int][Math]::Ceiling(($low + $high) / 2.0)
            if ($encoding.GetByteCount($text.Substring(0, $middle) + "...") -le 3800) { $low = $middle } else { $high = $middle - 1 }
        }
        $text = $text.Substring(0, $low) + "..."
    }
    return $text
}

function Get-PortableLogMutexName {
    $normalized = [IO.Path]::GetFullPath($StateDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).ToUpperInvariant()
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)) } finally { $hash.Dispose() }
    return "Local\TarkovHelperWebLog" + ([BitConverter]::ToString($bytes, 0, 12)).Replace("-", "")
}

function Protect-PortableLogFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($Path)) { return $true }
    $temporary = $null
    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $directory = [IO.Path]::GetDirectoryName($fullPath)
        $directoryInfo = [IO.DirectoryInfo]::new($directory)
        if (($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The diagnostic log directory is unsafe.") }
        $info = [IO.FileInfo]::new($fullPath)
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw [IO.IOException]::new("The diagnostic log file is unsafe.")
        }
        $maximumBytes = 1048576
        $tailOnly = $info.Length -gt $maximumBytes
        $count = [int][Math]::Min([long]$maximumBytes, $info.Length)
        $bytes = New-Object byte[] $count
        $source = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($tailOnly) { $null = $source.Seek(-[long]$count, [IO.SeekOrigin]::End) }
            $offset = 0
            while ($offset -lt $count) {
                $read = $source.Read($bytes, $offset, $count - $offset)
                if ($read -le 0) { break }
                $offset += $read
            }
            if ($offset -ne $count) { throw [IO.EndOfStreamException]::new("The diagnostic log could not be read safely.") }
        } finally {
            $source.Dispose()
        }

        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $text = $strictUtf8.GetString($bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        if ($tailOnly) {
            $boundary = [regex]::Match($text, '\r\n|[\r\n\u0085\u2028\u2029]')
            $text = if ($boundary.Success) { $text.Substring($boundary.Index + $boundary.Length) } else { "" }
        }

        $segments = [regex]::Split($text, '\r\n|[\r\n\u0085\u2028\u2029]')
        $protectedLines = New-Object 'Collections.Generic.List[string]'
        $first = [int][Math]::Max(0, $segments.Length - 4096)
        for ($index = $first; $index -lt $segments.Length; $index++) {
            $protected = Protect-PortableLogMessage ([string]$segments[$index])
            if (-not [string]::IsNullOrWhiteSpace($protected)) { $protectedLines.Add($protected) }
        }

        $encoding = New-Object Text.UTF8Encoding($false)
        $keptReverse = New-Object 'Collections.Generic.List[string]'
        $keptBytes = 0
        for ($index = $protectedLines.Count - 1; $index -ge 0; $index--) {
            $line = $protectedLines[$index] + [Environment]::NewLine
            $lineBytes = $encoding.GetByteCount($line)
            if (($keptBytes + $lineBytes) -gt $maximumBytes) { break }
            $keptReverse.Add($line)
            $keptBytes += $lineBytes
        }
        $builder = New-Object Text.StringBuilder
        for ($index = $keptReverse.Count - 1; $index -ge 0; $index--) { $null = $builder.Append($keptReverse[$index]) }
        $sanitizedBytes = $encoding.GetBytes($builder.ToString())
        $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($fullPath) + "." + [Guid]::NewGuid().ToString("N") + ".sanitize.tmp")
        [IO.File]::WriteAllBytes($temporary, $sanitizedBytes)
        [IO.File]::Delete($fullPath)
        [IO.File]::Move($temporary, $fullPath)
        return $true
    } catch {
        try {
            if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }
            return -not [IO.File]::Exists($Path)
        } catch {
            return $false
        }
    } finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch { } }
    }
}

function Rotate-PortableLogFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(0, 4096)][int]$AdditionalBytes = 0
    )

    $temporary = $null
    try {
        if (-not [IO.File]::Exists($Path) -or (([IO.FileInfo]::new($Path)).Length + $AdditionalBytes) -le 1048576) { return }
        $directory = [IO.Path]::GetDirectoryName($Path)
        $previous = Join-Path $directory ([IO.Path]::GetFileNameWithoutExtension($Path) + ".previous" + [IO.Path]::GetExtension($Path))
        $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($previous) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
        $source = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $count = [int][Math]::Min([long]1048576, $source.Length)
            $null = $source.Seek(-[long]$count, [IO.SeekOrigin]::End)
            $bytes = New-Object byte[] $count
            $offset = 0
            while ($offset -lt $count) {
                $read = $source.Read($bytes, $offset, $count - $offset)
                if ($read -le 0) { break }
                $offset += $read
            }
            if ($offset -ne $count) { throw [IO.EndOfStreamException]::new("The diagnostic log tail could not be read.") }
            [IO.File]::WriteAllBytes($temporary, $bytes)
        } finally { $source.Dispose() }
        if ([IO.File]::Exists($previous)) { [IO.File]::Delete($previous) }
        [IO.File]::Move($temporary, $previous)
        [IO.File]::Delete($Path)
    } catch {
        # Diagnostics are best effort and must never change launcher behavior.
    } finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch { } }
    }
}

function Write-PortableLog {
    param([string]$Message)

    $mutex = $null
    $hasMutex = $false
    try {
        $directory = Initialize-StateDirectory
        $mutex = [Threading.Mutex]::new($false, (Get-PortableLogMutexName))
        try { $hasMutex = $mutex.WaitOne(200) } catch [Threading.AbandonedMutexException] { $hasMutex = $true }
        if (-not $hasMutex) { return }
        $logPath = Join-Path $directory "server.log"
        $previousLogPath = Join-Path $directory "server.previous.log"
        foreach ($candidateLogPath in @($previousLogPath, $logPath)) {
            if (-not $script:protectedPortableLogPaths.Contains($candidateLogPath)) {
                if (-not (Protect-PortableLogFile -Path $candidateLogPath)) { return }
                $null = $script:protectedPortableLogPaths.Add($candidateLogPath)
            }
        }
        $line = "{0} {1}{2}" -f [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture), (Protect-PortableLogMessage $Message), [Environment]::NewLine
        $encoding = New-Object Text.UTF8Encoding($false)
        $lineBytes = $encoding.GetByteCount($line)
        Rotate-PortableLogFile -Path $logPath -AdditionalBytes $lineBytes
        if ([IO.File]::Exists($logPath) -and (([IO.FileInfo]::new($logPath)).Length + $lineBytes) -gt 1048576) { return }
        [IO.File]::AppendAllText($logPath, $line, $encoding)
    } catch {
        # Logging must not prevent startup or shutdown.
    } finally {
        if ($hasMutex) { try { $mutex.ReleaseMutex() } catch { } }
        if ($null -ne $mutex) { try { $mutex.Dispose() } catch { } }
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

function New-ClientLease {
    $token = Get-RandomToken
    $script:clientLeases[$token] = [DateTime]::UtcNow.AddSeconds($script:clientLeaseTimeoutSeconds)
    $script:clientLifecycleArmed = $true
    return $token
}

function Touch-ClientLease {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Token,
        [switch]$Closing
    )

    if (-not $script:clientLeases.ContainsKey($Token)) { return $false }
    if ($Closing) {
        # A tab close is the only client-driven shutdown signal. Remove this
        # lease immediately, but keep other open tabs alive.
        $script:clientLeases.Remove($Token)
        if ($script:clientLeases.Count -eq 0) {
            $script:shutdownRequested = $true
        }
        return $true
    }
    $seconds = $script:clientLeaseTimeoutSeconds
    $script:clientLeases[$Token] = [DateTime]::UtcNow.AddSeconds($seconds)
    return $true
}

function Update-ClientLeases {
    $now = [DateTime]::UtcNow
    if (-not $script:clientLifecycleArmed) {
        if ($script:clientFirstLeaseDeadlineUtc -ne [DateTime]::MaxValue -and $now -ge $script:clientFirstLeaseDeadlineUtc) {
            # Update/rollback Serve processes start hidden so the broker can
            # authenticate them. If every tab disappeared during the restart,
            # no first lease will arrive; retire only that replacement instead
            # of leaving a permanent background server. Normal Serve processes
            # have no deadline, and the first lease restores existing semantics.
            Write-PortableLog "Update replacement stopped because no client acquired its first lease before the handoff deadline."
            $script:shutdownRequested = $true
        }
        return
    }
    foreach ($token in @($script:clientLeases.Keys)) {
        if ($script:clientLeases[$token] -le $now) {
            $script:clientLeases.Remove($token)
        }
    }
    # Expired heartbeats are discarded, but never stop the server. Browsers
    # throttle background tabs; only an authenticated /client/close request
    # from the last open tab may request automatic shutdown.
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
        public int ThreadId { get; set; }
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
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetProp(IntPtr window, string name, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetProp(IntPtr window, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr RemoveProp(IntPtr window, string name);
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
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetLayeredWindowAttributes(
            IntPtr window,
            uint colorKey,
            byte alpha,
            uint flags
        );
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
        private const long LayeredWindow = 0x00080000L;
        private const uint LayeredAlpha = 0x00000002;
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

        public static int DipsToPixelsAtDpi(int value, uint dpi) {
            if (dpi == 0) throw new ArgumentOutOfRangeException("dpi");
            return checked((int)Math.Round(value * dpi / 96.0, MidpointRounding.AwayFromZero));
        }

        public static int PixelsToDipsAtDpi(int value, uint dpi) {
            if (dpi == 0) throw new ArgumentOutOfRangeException("dpi");
            return checked((int)Math.Round(value * 96.0 / dpi, MidpointRounding.AwayFromZero));
        }

        public static int DipsToPixels(long handle, int value) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            return DipsToPixelsAtDpi(value, ReadDpi(window));
        }

        public static int PixelsToDips(long handle, int value) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            return PixelsToDipsAtDpi(value, ReadDpi(window));
        }

        public static void SetLayeredAlpha(long handle, int alpha) {
            if (alpha < 1 || alpha > 255) throw new ArgumentOutOfRangeException("alpha");
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            if ((ReadWindowLong(window, ExStyleIndex) & LayeredWindow) == 0) {
                throw new InvalidOperationException("The overlay window is not layered.");
            }
            if (!SetLayeredWindowAttributes(window, 0, checked((byte)alpha), LayeredAlpha)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
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
            int logicalX = checked(information.Monitor.Left + PixelsToDipsAtDpi(x - information.Monitor.Left, dpi));
            int logicalY = checked(information.Monitor.Top + PixelsToDipsAtDpi(y - information.Monitor.Top, dpi));
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

        private static void SetConvergencePosition(
            IntPtr window,
            long style,
            long exStyle,
            int left,
            int top,
            int width,
            int height
        ) {
            WriteWindowLong(window, StyleIndex, style);
            WriteWindowLong(window, ExStyleIndex, exStyle);
            long effectiveExStyleMask = ~WindowEdge;
            if (
                ReadWindowLong(window, StyleIndex) != style ||
                (ReadWindowLong(window, ExStyleIndex) & effectiveExStyleMask) !=
                    (exStyle & effectiveExStyleMask)
            ) {
                throw new InvalidOperationException("The overlay window rejected its requested style.");
            }
            if (!SetWindowPos(window, new IntPtr(-1), left, top, width, height, FrameChanged | ShowWindow | NoActivate)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            // Chromium may normalize extended styles while processing the
            // frame change. Re-assert the layered bit after that pass before
            // applying the compositor alpha.
            WriteWindowLong(window, ExStyleIndex, exStyle);
            if (
                ReadWindowLong(window, StyleIndex) != style ||
                (ReadWindowLong(window, ExStyleIndex) & effectiveExStyleMask) !=
                    (exStyle & effectiveExStyleMask)
            ) {
                throw new InvalidOperationException("The overlay window rejected its requested style.");
            }
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
                uint threadId = GetWindowThreadProcessId(window, out processId);
                if (!GetWindowRect(window, out rect)) return true;
                windows.Add(new NativeWindowInfo {
                    Handle = window.ToInt64(),
                    ProcessId = unchecked((int)processId),
                    ThreadId = unchecked((int)threadId),
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

        public static void AddWindowMarker(long handle, string markerName) {
            if (string.IsNullOrEmpty(markerName)) {
                throw new ArgumentException("A native overlay marker name is required.", "markerName");
            }
            if (!SetProp(new IntPtr(handle), markerName, new IntPtr(1))) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public static bool HasWindowMarker(long handle, string markerName) {
            return !string.IsNullOrEmpty(markerName) &&
                GetProp(new IntPtr(handle), markerName) == new IntPtr(1);
        }

        public static bool RemoveWindowMarker(long handle, string markerName) {
            return !string.IsNullOrEmpty(markerName) &&
                RemoveProp(new IntPtr(handle), markerName) == new IntPtr(1);
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

        private static NativeContentInfo ConvergeContent(
            IntPtr window,
            long handle,
            long style,
            long exStyle,
            int visibleLeft,
            int visibleTop,
            int visibleWidth,
            int visibleHeight
        ) {
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
                // A PMv2 window can accept SetWindowPos and then adjust its physical
                // rectangle while processing WM_DPICHANGED. Keep style verification
                // strict, but let the measured content drive the next bounded pass.
                SetConvergencePosition(window, style, exStyle, nextLeft, nextTop, nextWidth, nextHeight);
                content = WaitForContent(handle);
                if (content == null) throw new InvalidOperationException("The browser content surface became ambiguous.");
                if (
                    content.Left == visibleLeft && content.Top == visibleTop &&
                    content.Width == visibleWidth && content.Height == visibleHeight
                ) return content;
                if (attempt == 4) {
                    throw new InvalidOperationException("The browser content surface did not converge to the requested bounds.");
                }
            }
            throw new InvalidOperationException("The browser content surface did not converge.");
        }

        public static NativeContentInfo ApplyCroppedDips(
            long handle,
            long style,
            long exStyle,
            int visibleLeft,
            int visibleTop,
            int visibleWidthDips,
            int visibleHeightDips
        ) {
            var window = new IntPtr(handle);
            if (!IsWindow(window)) throw new InvalidOperationException("The overlay window no longer exists.");
            if (visibleWidthDips <= 0 || visibleHeightDips <= 0) {
                throw new ArgumentOutOfRangeException("visibleWidthDips");
            }
            long previousStyle = ReadWindowLong(window, StyleIndex);
            long previousExStyle = ReadWindowLong(window, ExStyleIndex);
            Rect previousRect;
            if (!GetWindowRect(window, out previousRect)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            byte[] previousRegionData = CaptureRegionData(window);
            try {
                var observedDpiStates = new HashSet<string>(StringComparer.Ordinal);
                for (int dpiAttempt = 0; dpiAttempt < 5; dpiAttempt++) {
                    uint targetDpi = ReadDpi(window);
                    int targetWidth = DipsToPixelsAtDpi(visibleWidthDips, targetDpi);
                    int targetHeight = DipsToPixelsAtDpi(visibleHeightDips, targetDpi);
                    NativeContentInfo content = ConvergeContent(
                        window,
                        handle,
                        style,
                        exStyle,
                        visibleLeft,
                        visibleTop,
                        targetWidth,
                        targetHeight
                    );
                    uint appliedDpi = ReadDpi(window);
                    int appliedTargetWidth = DipsToPixelsAtDpi(visibleWidthDips, appliedDpi);
                    int appliedTargetHeight = DipsToPixelsAtDpi(visibleHeightDips, appliedDpi);
                    string state;
                    if (content.Width == appliedTargetWidth && content.Height == appliedTargetHeight) {
                        Rect finalOuter;
                        if (!GetWindowRect(window, out finalOuter)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        int regionLeft = checked(content.Left - finalOuter.Left);
                        int regionTop = checked(content.Top - finalOuter.Top);
                        AssignRectRegion(window, regionLeft, regionTop, content.Width, content.Height);
                        NativeContentInfo verified = WaitForContent(handle);
                        uint verifiedDpi = ReadDpi(window);
                        Rect verifiedOuter;
                        if (!GetWindowRect(window, out verifiedOuter)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        int verifiedTargetWidth = DipsToPixelsAtDpi(visibleWidthDips, verifiedDpi);
                        int verifiedTargetHeight = DipsToPixelsAtDpi(visibleHeightDips, verifiedDpi);
                        int verifiedRegionLeft = verified == null ? 0 : checked(verified.Left - verifiedOuter.Left);
                        int verifiedRegionTop = verified == null ? 0 : checked(verified.Top - verifiedOuter.Top);
                        if (
                            verified != null &&
                            verified.Left == visibleLeft && verified.Top == visibleTop &&
                            verified.Width == content.Width && verified.Height == content.Height &&
                            verified.Width == verifiedTargetWidth && verified.Height == verifiedTargetHeight &&
                            MatchesRectRegion(
                                window,
                                verifiedRegionLeft,
                                verifiedRegionTop,
                                verified.Width,
                                verified.Height
                            )
                        ) {
                            return verified;
                        }
                        state = "region:" + targetDpi.ToString() + ":" + appliedDpi.ToString() + ":" +
                            verifiedDpi.ToString() + ":" + (verified == null ? "ambiguous" :
                                verified.Width.ToString() + ":" + verified.Height.ToString());
                        // The region was sized in the previous physical coordinate
                        // system. Restore the pre-operation region before measuring
                        // the next DPI-adjusted geometry pass.
                        AssignRegion(window, previousRegionData);
                    } else {
                        state = "content:" + targetDpi.ToString() + ":" + appliedDpi.ToString() + ":" +
                            content.Width.ToString() + ":" + content.Height.ToString();
                    }
                    if (!observedDpiStates.Add(state)) {
                        throw new InvalidOperationException("The overlay DPI transition did not converge.");
                    }
                }
                throw new InvalidOperationException("The overlay DPI transition exceeded its retry limit.");
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
                threadId = [int]$window.ThreadId
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

function Convert-NativeOpacityToAlpha {
    param([Parameter(Mandatory = $true)][double]$Opacity)

    if ([double]::IsNaN($Opacity) -or [double]::IsInfinity($Opacity) -or $Opacity -lt 0.1 -or $Opacity -gt 1) {
        throw [ArgumentOutOfRangeException]::new("Opacity must be between 0.1 and 1.")
    }
    return [int][Math]::Round($Opacity * 255, [MidpointRounding]::AwayFromZero)
}

function Get-NativeOverlayEventsPayload {
    param(
        [Parameter(Mandatory = $true)][string]$RequestTarget,
        [ValidateSet(1, 2)][int]$ProtocolVersion = 1
    )

    $query = Get-QueryParameters -RequestTarget $RequestTarget
    foreach ($name in $query.Keys) {
        if ($name -cne "after" -and ($ProtocolVersion -ne 2 -or $name -cne "kind")) {
            throw [ArgumentException]::new("Unknown query parameter.")
        }
    }
    if ($ProtocolVersion -eq 2 -and (
        -not $query.ContainsKey("kind") -or
        $query["kind"] -cne "minimap"
    )) {
        throw [ArgumentException]::new("kind must be minimap.")
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
    $miniMapRecord = if ($script:nativeOverlayRecords.ContainsKey("minimap")) {
        $script:nativeOverlayRecords["minimap"]
    } else {
        $null
    }
    if ($null -ne $miniMapRecord -and $null -eq (Get-CurrentNativeOverlayWindow -OverlayKind "minimap")) {
        if (-not [TarkovHelper.NativeOverlayBridge]::IsWindowHandle($miniMapRecord.handle)) {
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
            [void]$script:nativeOverlayRecords.Remove("minimap")
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
        protocolVersion = $ProtocolVersion
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
    Remove-ExpiredNativeOverlayClaims
    if ($script:nativeOverlayRecords.Count -eq 0) { return }
    $now = [DateTime]::UtcNow
    if ($now -lt $script:nativeOverlayNextReconciliationUtc) { return }
    $script:nativeOverlayNextReconciliationUtc = $now.AddSeconds(1)
    foreach ($overlayKind in @($script:nativeOverlayRecords.Keys)) {
        try {
            if ($null -ne (Get-CurrentNativeOverlayWindow -OverlayKind $overlayKind)) { continue }
            $record = $script:nativeOverlayRecords[$overlayKind]
            if ($overlayKind -ceq "quest-list") {
                if ($null -ne (Get-NativeOverlayIdentityWindow -OverlayKind $overlayKind)) {
                    $null = Remove-NativeOverlay -OverlayKind $overlayKind -IgnoreIdentifier
                } else {
                    Remove-NativeOverlayRecordState -OverlayKind $overlayKind
                }
                continue
            }
            if ($overlayKind -ceq "minimap") {
                [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
            }
            if (-not [TarkovHelper.NativeOverlayBridge]::IsWindowHandle($record.handle)) {
                [void]$script:nativeOverlayRecords.Remove($overlayKind)
            }
        } catch {
            # A failed reconciliation must not stop the local server. Mutating API
            # calls will continue to fail closed until identity can be proven again.
            Write-PortableLog "Native overlay periodic reconciliation failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
        }
    }
}

function Remove-NativeOverlayClaimMarker {
    param([Parameter(Mandatory = $true)][pscustomobject]$Claim)

    if (
        $Claim.overlayKind -cne "quest-list" -or
        [string]::IsNullOrEmpty([string]$Claim.markerName) -or
        $null -eq $Claim.boundWindow
    ) {
        return
    }
    try {
        $boundWindow = $Claim.boundWindow
        $current = @(Get-NativeBrowserWindows | Where-Object {
            $_.handle -eq $boundWindow.handle -and
            $_.processId -eq $boundWindow.processId -and
            $_.processStartTimeUtc -ceq $boundWindow.processStartTimeUtc -and
            $_.className -ceq $boundWindow.className -and
            $_.threadId -eq $boundWindow.threadId -and
            [TarkovHelper.NativeOverlayBridge]::HasWindowMarker(
                [long]$_.handle,
                [string]$Claim.markerName
            )
        }) | Select-Object -First 1
        if ($null -eq $current) { return }
        $null = [TarkovHelper.NativeOverlayBridge]::RemoveWindowMarker(
            [long]$current.handle,
            [string]$Claim.markerName
        )
    } catch {
        Write-PortableLog "A stale quest overlay claim marker could not be removed."
    }
}

function Remove-ExpiredNativeOverlayClaims {
    $now = [DateTime]::UtcNow
    foreach ($claimId in @($script:nativeOverlayClaims.Keys)) {
        if ($script:nativeOverlayClaims[$claimId].expiresAtUtc -le $now) {
            Remove-NativeOverlayClaimMarker -Claim $script:nativeOverlayClaims[$claimId]
            [void]$script:nativeOverlayClaims.Remove($claimId)
        }
    }
    foreach ($claimId in @($script:nativeOverlayCompletedClaims.Keys)) {
        if ($script:nativeOverlayCompletedClaims[$claimId].expiresAtUtc -le $now) {
            [void]$script:nativeOverlayCompletedClaims.Remove($claimId)
        }
    }
}

function Remove-NativeOverlayRecordState {
    param([Parameter(Mandatory = $true)][ValidateSet("minimap", "quest-list")][string]$OverlayKind)

    if (-not $script:nativeOverlayRecords.ContainsKey($OverlayKind)) { return }
    $record = $script:nativeOverlayRecords[$OverlayKind]
    foreach ($claimId in @($script:nativeOverlayCompletedClaims.Keys)) {
        if (
            $script:nativeOverlayCompletedClaims[$claimId].overlayKind -ceq $OverlayKind -and
            $script:nativeOverlayCompletedClaims[$claimId].overlayId -ceq $record.overlayId
        ) {
            [void]$script:nativeOverlayCompletedClaims.Remove($claimId)
        }
    }
    [void]$script:nativeOverlayRecords.Remove($OverlayKind)
}

function New-NativeOverlayClaim {
    param(
        [ValidateSet("minimap", "quest-list")][string]$OverlayKind = "minimap",
        [ValidateSet(1, 2)][int]$ProtocolVersion = 1,
        [string]$WindowNonce
    )

    Remove-ExpiredNativeOverlayClaims
    $windows = @(Get-NativeBrowserWindows)
    $boundWindow = $null
    $pendingWindowTitle = $null
    $markerName = $null
    if ($OverlayKind -ceq "quest-list") {
        if (-not (Test-NativeQuestWindowNonce -WindowNonce $WindowNonce)) {
            throw [ArgumentException]::new("The quest overlay window nonce is invalid.")
        }
        $pendingWindowTitle = "$nativeOverlayQuestListWindowTitle [$WindowNonce]"
        $styleVisible = [long]0x10000000
        $styleCaption = [long]0x00C00000
        $matches = @()
        $inspectionDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds(750)
        do {
            $windows = @(Get-NativeBrowserWindows)
            $matches = @($windows | Where-Object {
                $_.title -ceq $pendingWindowTitle -and
                ($_.style -band $styleVisible) -eq $styleVisible -and
                ($_.style -band $styleCaption) -eq $styleCaption
            })
            if ($matches.Count -ne 0) { break }
            Start-Sleep -Milliseconds 25
        } while ([DateTime]::UtcNow -lt $inspectionDeadlineUtc)
        if ($matches.Count -eq 0) {
            return [pscustomobject]@{ errorCode = "WINDOW_NOT_FOUND" }
        }
        if ($matches.Count -ne 1) {
            return [pscustomobject]@{ errorCode = "AMBIGUOUS_WINDOW" }
        }
        $boundWindow = $matches[0]
        foreach ($pendingClaimId in @($script:nativeOverlayClaims.Keys)) {
            $pendingClaim = $script:nativeOverlayClaims[$pendingClaimId]
            if ($pendingClaim.overlayKind -cne "quest-list" -or $null -eq $pendingClaim.boundWindow) { continue }
            if (-not [TarkovHelper.NativeOverlayBridge]::HasWindowMarker(
                [long]$pendingClaim.boundWindow.handle,
                [string]$pendingClaim.markerName
            )) {
                [void]$script:nativeOverlayClaims.Remove($pendingClaimId)
            }
        }
        $alreadyClaimed = @($script:nativeOverlayClaims.Values | Where-Object {
            $_.overlayKind -ceq "quest-list" -and
            $null -ne $_.boundWindow -and
            $_.boundWindow.handle -eq $boundWindow.handle -and
            $_.boundWindow.processId -eq $boundWindow.processId -and
            $_.boundWindow.processStartTimeUtc -ceq $boundWindow.processStartTimeUtc -and
            $_.boundWindow.threadId -eq $boundWindow.threadId -and
            $_.boundWindow.className -ceq $boundWindow.className -and
            [TarkovHelper.NativeOverlayBridge]::HasWindowMarker(
                [long]$_.boundWindow.handle,
                [string]$_.markerName
            )
        })
        if ($alreadyClaimed.Count -ne 0) {
            return [pscustomobject]@{ errorCode = "OVERLAY_ALREADY_ATTACHED" }
        }
    }
    $claimId = Get-RandomToken
    $expiresAtUtc = [DateTime]::UtcNow.AddSeconds($nativeOverlayClaimLifetimeSeconds)
    if ($OverlayKind -ceq "quest-list") {
        $markerName = "TarkovHelper.NativeOverlay.$claimId"
        [TarkovHelper.NativeOverlayBridge]::AddWindowMarker(
            [long]$boundWindow.handle,
            $markerName
        )
    }
    $script:nativeOverlayClaims[$claimId] = [pscustomobject]@{
        claimId = $claimId
        expiresAtUtc = $expiresAtUtc
        overlayKind = $OverlayKind
        pendingWindowTitle = $pendingWindowTitle
        markerName = $markerName
        boundWindow = $boundWindow
        handles = @($windows | ForEach-Object { [string]$_.handle })
        processIdentities = @($windows | ForEach-Object { $_.processIdentity } | Select-Object -Unique)
    }
    $response = [ordered]@{
        protocolVersion = $ProtocolVersion
    }
    if ($ProtocolVersion -eq 2) {
        $response.overlayKind = $OverlayKind
    }
    $response.claimId = $claimId
    $response.expiresAt = $expiresAtUtc.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    return [pscustomobject]$response
}

function Get-NativeOverlayWindowTitle {
    param([Parameter(Mandatory = $true)][ValidateSet("minimap", "quest-list")][string]$OverlayKind)

    if ($OverlayKind -ceq "quest-list") { return $nativeOverlayQuestListWindowTitle }
    return $nativeOverlayWindowTitle
}

function Test-NativeQuestWindowNonce {
    param([string]$WindowNonce)

    return $null -ne $WindowNonce -and $WindowNonce -cmatch "^[A-Za-z0-9_-]{43}$"
}

function Test-NativeOverlayCandidate {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Window,
        [Parameter(Mandatory = $true)][pscustomobject]$Claim,
        [Parameter(Mandatory = $true)][ValidateSet("minimap", "quest-list")][string]$OverlayKind
    )

    $styleVisible = [long]0x10000000
    $styleCaption = [long]0x00C00000
    $styleMinimizeBox = [long]0x00020000
    $styleMaximizeBox = [long]0x00010000
    $exStyleTopmost = [long]0x00000008
    $isCommonCandidate = (
        $Claim.handles -notcontains [string]$Window.handle -and
        $Claim.processIdentities -contains $Window.processIdentity -and
        $Window.title -ceq $nativeOverlayWindowTitle -and
        ($Window.style -band $styleVisible) -eq $styleVisible -and
        ($Window.style -band $styleCaption) -eq $styleCaption
    )
    if (-not $isCommonCandidate) { return $false }
    return (
        ($Window.style -band $styleMinimizeBox) -eq 0 -and
        ($Window.style -band $styleMaximizeBox) -eq 0 -and
        ($Window.exStyle -band $exStyleTopmost) -eq $exStyleTopmost
    )
}

function Complete-NativeOverlayClaim {
    param(
        [Parameter(Mandatory = $true)][string]$ClaimId,
        [ValidateSet("minimap", "quest-list")][string]$OverlayKind = "minimap",
        [ValidateSet(1, 2)][int]$ProtocolVersion = 1,
        [string]$WindowTitle
    )

    Remove-ExpiredNativeOverlayClaims
    if (-not $script:nativeOverlayClaims.ContainsKey($ClaimId)) {
        if ($ProtocolVersion -eq 2 -and $script:nativeOverlayCompletedClaims.ContainsKey($ClaimId)) {
            $completedClaim = $script:nativeOverlayCompletedClaims[$ClaimId]
            if (
                $completedClaim.overlayKind -ceq $OverlayKind -and
                $completedClaim.windowTitle -ceq $WindowTitle -and
                $script:nativeOverlayRecords.ContainsKey($OverlayKind) -and
                $script:nativeOverlayRecords[$OverlayKind].overlayId -ceq $completedClaim.overlayId -and
                $null -ne (Get-CurrentNativeOverlayWindow -OverlayKind $OverlayKind)
            ) {
                return Get-NativeOverlayResponse -OverlayKind $OverlayKind -ProtocolVersion $ProtocolVersion
            }
        }
        return [pscustomobject]@{ errorCode = "CLAIM_NOT_FOUND" }
    }
    $claim = $script:nativeOverlayClaims[$ClaimId]
    [void]$script:nativeOverlayClaims.Remove($ClaimId)
    if (
        $claim.overlayKind -cne $OverlayKind -or
        ($OverlayKind -ceq "quest-list" -and $WindowTitle -cne $nativeOverlayQuestListWindowTitle)
    ) {
        Remove-NativeOverlayClaimMarker -Claim $claim
        return [pscustomobject]@{ errorCode = "CLAIM_NOT_FOUND" }
    }
    if ($script:nativeOverlayRecords.ContainsKey($OverlayKind)) {
        $existingRecord = $script:nativeOverlayRecords[$OverlayKind]
        if ($null -ne (Get-CurrentNativeOverlayWindow -OverlayKind $OverlayKind)) {
            Remove-NativeOverlayClaimMarker -Claim $claim
            return [pscustomobject]@{ errorCode = "OVERLAY_ALREADY_ATTACHED" }
        }
        if ([TarkovHelper.NativeOverlayBridge]::IsWindowHandle($existingRecord.handle)) {
            Remove-NativeOverlayClaimMarker -Claim $claim
            return [pscustomobject]@{ errorCode = "OVERLAY_ALREADY_ATTACHED" }
        }
        if ($OverlayKind -ceq "minimap") {
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        }
        Remove-NativeOverlayRecordState -OverlayKind $OverlayKind
    }

    $browserWindows = @()
    $matches = @()
    $inspectionDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds(750)
    do {
        $browserWindows = @(Get-NativeBrowserWindows)
    $matches = @(if ($OverlayKind -ceq "quest-list") {
        $browserWindows | Where-Object {
                $_.handle -eq $claim.boundWindow.handle -and
                $_.processId -eq $claim.boundWindow.processId -and
                $_.processStartTimeUtc -ceq $claim.boundWindow.processStartTimeUtc -and
                $_.className -ceq $claim.boundWindow.className -and
                $_.threadId -eq $claim.boundWindow.threadId -and
                $_.title -ceq $nativeOverlayQuestListWindowTitle -and
                [TarkovHelper.NativeOverlayBridge]::HasWindowMarker(
                    [long]$_.handle,
                    [string]$claim.markerName
                )
        }
    } else {
        $browserWindows | Where-Object {
            Test-NativeOverlayCandidate -Window $_ -Claim $claim -OverlayKind $OverlayKind
        }
    })
        if ($matches.Count -ne 0 -or $OverlayKind -ceq "minimap") { break }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $inspectionDeadlineUtc)
    Write-PortableLog "Native $OverlayKind overlay claim inspected $($browserWindows.Count) browser windows and found $($matches.Count) eligible new windows."
    if ($matches.Count -eq 0) {
        Remove-NativeOverlayClaimMarker -Claim $claim
        return [pscustomobject]@{ errorCode = "WINDOW_NOT_FOUND" }
    }
    if ($matches.Count -ne 1) {
        Remove-NativeOverlayClaimMarker -Claim $claim
        return [pscustomobject]@{ errorCode = "AMBIGUOUS_WINDOW" }
    }

    $window = $matches[0]
    $overlayId = Get-RandomToken
    $record = $null
    try {
        $originalRegionData = [TarkovHelper.NativeOverlayBridge]::CaptureRegion([long]$window.handle)
        $record = [pscustomobject]@{
            overlayKind = $OverlayKind
            overlayId = $overlayId
            handle = [long]$window.handle
            processId = [int]$window.processId
            threadId = [int]$window.threadId
            processStartTimeUtc = [string]$window.processStartTimeUtc
            className = [string]$window.className
            windowTitle = [string]$window.title
            markerName = if ($OverlayKind -ceq "quest-list") { [string]$claim.markerName } else { $null }
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
            nativeOpacity = [double]1
            globalHotkeysAvailable = $false
            mode = "UNLOCKED"
        }
        $script:nativeOverlayRecords[$OverlayKind] = $record
        if ($OverlayKind -ceq "minimap") {
            $registeredHotKeys = [TarkovHelper.NativeOverlayBridge]::StartHotKeys()
            $record.globalHotkeysAvailable = $registeredHotKeys -eq 4
            Write-PortableLog "Native overlay hotkey bridge registered $registeredHotKeys of 4 shortcuts."
        } else {
            # A quest popup must behave like a PiP companion immediately while
            # retaining its normal frame so the user can still move and resize it.
            $null = Set-NativeOverlayMode -OverlayKind $OverlayKind `
                -OverlayId $overlayId -Mode "UNLOCKED" -ProtocolVersion $ProtocolVersion
        }
        if ($ProtocolVersion -eq 2) {
            $script:nativeOverlayCompletedClaims[$ClaimId] = [pscustomobject]@{
                overlayKind = $OverlayKind
                overlayId = $overlayId
                windowTitle = $WindowTitle
                expiresAtUtc = [DateTime]::UtcNow.AddSeconds($nativeOverlayClaimLifetimeSeconds)
            }
        }
        return Get-NativeOverlayResponse -OverlayKind $OverlayKind -ProtocolVersion $ProtocolVersion
    } catch {
        try {
            if ($script:nativeOverlayRecords.ContainsKey($OverlayKind)) {
                $null = Remove-NativeOverlay -OverlayKind $OverlayKind -OverlayId $overlayId
            } else {
                Remove-NativeOverlayClaimMarker -Claim $claim
            }
        } catch {
            Write-PortableLog "Native $OverlayKind overlay attach rollback failed."
        }
        throw
    }
}

function Get-NativeOverlayResponse {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("minimap", "quest-list")][string]$OverlayKind,
        [ValidateSet(1, 2)][int]$ProtocolVersion = 1
    )

    $record = $script:nativeOverlayRecords[$OverlayKind]
    $current = Get-CurrentNativeOverlayWindow -OverlayKind $OverlayKind
    $bounds = if ($record.mode -eq "UNLOCKED") {
        $physicalBounds = if ($null -ne $current) { $current.rect } else { $record.originalRect }
        Convert-NativeRectToDips -Handle $record.handle -Rect $physicalBounds
    } else {
        $record.lockedBoundsDip
    }
    $response = [ordered]@{
        protocolVersion = $ProtocolVersion
    }
    if ($ProtocolVersion -eq 2) {
        $response.overlayKind = $OverlayKind
    }
    $response.overlayId = $record.overlayId
    $response.state = "ATTACHED"
    $response.mode = $record.mode
    $response.globalHotkeysAvailable = [bool]$record.globalHotkeysAvailable
    $response.bounds = [pscustomobject]@{
            left = [int]$bounds.left
            top = [int]$bounds.top
            width = [int]$bounds.width
            height = [int]$bounds.height
    }
    return [pscustomobject]$response
}

function Get-NativeOverlayIdentityWindow {
    param([Parameter(Mandatory = $true)][ValidateSet("minimap", "quest-list")][string]$OverlayKind)

    if (-not $script:nativeOverlayRecords.ContainsKey($OverlayKind)) { return $null }
    $record = $script:nativeOverlayRecords[$OverlayKind]
    return @(
        Get-NativeBrowserWindows |
            Where-Object {
                $identityMatches = (
                    $_.handle -eq $record.handle -and
                    $_.processId -eq $record.processId -and
                    $_.processStartTimeUtc -ceq $record.processStartTimeUtc
                )
                if (-not $identityMatches) { return $false }
                if ($OverlayKind -ceq "minimap") {
                    return $true
                }
                return (
                    $_.className -ceq $record.className -and
                    $_.threadId -eq $record.threadId -and
                    [TarkovHelper.NativeOverlayBridge]::HasWindowMarker(
                        [long]$_.handle,
                        [string]$record.markerName
                    )
                )
            }
    ) | Select-Object -First 1
}

function Get-CurrentNativeOverlayWindow {
    param([Parameter(Mandatory = $true)][ValidateSet("minimap", "quest-list")][string]$OverlayKind)

    if (-not $script:nativeOverlayRecords.ContainsKey($OverlayKind)) { return $null }
    $record = $script:nativeOverlayRecords[$OverlayKind]
    $identityWindow = Get-NativeOverlayIdentityWindow -OverlayKind $OverlayKind
    if ($null -eq $identityWindow -or $identityWindow.title -cne $record.windowTitle) { return $null }
    return $identityWindow
}

function Set-NativeOverlayMode {
    param(
        [ValidateSet("minimap", "quest-list")][string]$OverlayKind = "minimap",
        [Parameter(Mandatory = $true)][string]$OverlayId,
        [Parameter(Mandatory = $true)][ValidateSet("UNLOCKED", "LOCKED", "CLICK_THROUGH")][string]$Mode,
        [Nullable[int]]$Width,
        [Nullable[int]]$Height,
        [Nullable[double]]$Opacity,
        [ValidateSet(1, 2)][int]$ProtocolVersion = 1
    )

    if (@("UNLOCKED", "LOCKED", "CLICK_THROUGH") -cnotcontains $Mode) {
        throw [ArgumentException]::new("The native overlay mode is invalid.")
    }
    if ($null -ne $Opacity) {
        [void](Convert-NativeOpacityToAlpha -Opacity ([double]$Opacity))
    }
    if (
        -not $script:nativeOverlayRecords.ContainsKey($OverlayKind) -or
        $script:nativeOverlayRecords[$OverlayKind].overlayId -cne $OverlayId
    ) {
        return [pscustomobject]@{ errorCode = "OVERLAY_NOT_FOUND" }
    }
    $record = $script:nativeOverlayRecords[$OverlayKind]
    $current = Get-CurrentNativeOverlayWindow -OverlayKind $OverlayKind
    if ($null -eq $current) {
        if ($OverlayKind -ceq "quest-list") {
            if ($null -ne (Get-NativeOverlayIdentityWindow -OverlayKind $OverlayKind)) {
                $null = Remove-NativeOverlay -OverlayKind $OverlayKind -IgnoreIdentifier
            } else {
                Remove-NativeOverlayRecordState -OverlayKind $OverlayKind
            }
            return [pscustomobject]@{ errorCode = "OVERLAY_NOT_FOUND" }
        }
        if ([TarkovHelper.NativeOverlayBridge]::IsWindowHandle($record.handle)) {
            throw [InvalidOperationException]::new("The overlay window identity could not be verified.")
        }
        if ($OverlayKind -ceq "minimap") {
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        }
        Remove-NativeOverlayRecordState -OverlayKind $OverlayKind
        return [pscustomobject]@{ errorCode = "OVERLAY_NOT_FOUND" }
    }

    $nextOpacity = if ($null -ne $Opacity) {
        [double]$Opacity
    } else {
        [double]$record.nativeOpacity
    }

    if ($Mode -ceq "UNLOCKED") {
        # Keep the normal, movable window geometry while retaining the layered
        # compositor surface. This makes the configured opacity work before
        # the user pins the overlay as well as after it is locked.
        $transparentNormalExStyle = $record.normalExStyle -bor [long]0x00080000
        $normalTopmost = ($record.normalExStyle -band [long]0x00000008) -ne 0
        if ($OverlayKind -ceq "quest-list") {
            $transparentNormalExStyle = $transparentNormalExStyle -bor [long]0x00000008
            $normalTopmost = $true
        }
        [TarkovHelper.NativeOverlayBridge]::ApplyOriginal(
            $record.handle,
            $record.normalStyle,
            $transparentNormalExStyle,
            $record.normalRect.left,
            $record.normalRect.top,
            $record.normalRect.width,
            $record.normalRect.height,
            $normalTopmost,
            $record.normalRegionData
        )
        [TarkovHelper.NativeOverlayBridge]::SetLayeredAlpha(
            $record.handle,
            (Convert-NativeOpacityToAlpha -Opacity $nextOpacity)
        )
        $record.nativeOpacity = $nextOpacity
        $record.mode = "UNLOCKED"
        return Get-NativeOverlayResponse -OverlayKind $OverlayKind -ProtocolVersion $ProtocolVersion
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
        $nextBoundsDip.width = [int]$Width
        $nextBoundsDip.height = [int]$Height
    }

    # Chromium enforces its large normal-window minimum while caption/thick-frame
    # styles are present. Remove only the native frame bits for a locked crop;
    # the renderer is remeasured after this transition before the HRGN is applied.
    $windowDecorationMask = [long]0x00CF0000
    $pinnedStyle = $record.originalStyle -band (-bnot $windowDecorationMask)
    $pinnedExStyle = $record.originalExStyle -bor [long]0x00000008
    # A layered top-level surface is required for the transparent document
    # background to reveal the desktop behind the map. Its alpha is updated
    # after the crop is applied below.
    $pinnedExStyle = $pinnedExStyle -bor [long]0x00080000
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
        $pinnedExStyle = $pinnedExStyle -band (-bnot [long]0x00000020)
    }
    $appliedContent = [TarkovHelper.NativeOverlayBridge]::ApplyCroppedDips(
        $record.handle,
        $pinnedStyle,
        $pinnedExStyle,
        $nextVisibleRect.left,
        $nextVisibleRect.top,
        $nextBoundsDip.width,
        $nextBoundsDip.height
    )
    [TarkovHelper.NativeOverlayBridge]::SetLayeredAlpha(
        $record.handle,
        (Convert-NativeOpacityToAlpha -Opacity $nextOpacity)
    )
    $nextVisibleRect.left = [int]$appliedContent.Left
    $nextVisibleRect.top = [int]$appliedContent.Top
    $nextVisibleRect.width = [int]$appliedContent.Width
    $nextVisibleRect.height = [int]$appliedContent.Height
    $appliedTopLeftDip = [TarkovHelper.NativeOverlayBridge]::ScreenPointToDips(
        $record.handle,
        $nextVisibleRect.left,
        $nextVisibleRect.top
    )
    $nextBoundsDip.left = [int]$appliedTopLeftDip.X
    $nextBoundsDip.top = [int]$appliedTopLeftDip.Y
    $record.lockedVisibleRect = $nextVisibleRect
    $record.lockedBoundsDip = $nextBoundsDip
    $record.nativeOpacity = $nextOpacity
    $record.mode = $Mode
    return Get-NativeOverlayResponse -OverlayKind $OverlayKind -ProtocolVersion $ProtocolVersion
}

function Remove-NativeOverlay {
    param(
        [ValidateSet("minimap", "quest-list")][string]$OverlayKind = "minimap",
        [string]$OverlayId,
        [switch]$IgnoreIdentifier
    )

    if (-not $script:nativeOverlayRecords.ContainsKey($OverlayKind)) {
        return $true
    }
    if (-not $IgnoreIdentifier -and $script:nativeOverlayRecords[$OverlayKind].overlayId -cne $OverlayId) {
        return $false
    }

    $record = $script:nativeOverlayRecords[$OverlayKind]
    foreach ($claimId in @($script:nativeOverlayCompletedClaims.Keys)) {
        if (
            $script:nativeOverlayCompletedClaims[$claimId].overlayKind -ceq $OverlayKind -and
            $script:nativeOverlayCompletedClaims[$claimId].overlayId -ceq $record.overlayId
        ) {
            [void]$script:nativeOverlayCompletedClaims.Remove($claimId)
        }
    }
    $current = if ($OverlayKind -ceq "quest-list") {
        Get-NativeOverlayIdentityWindow -OverlayKind $OverlayKind
    } else {
        Get-CurrentNativeOverlayWindow -OverlayKind $OverlayKind
    }
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
        if ($OverlayKind -ceq "quest-list") {
            try {
                if (-not [TarkovHelper.NativeOverlayBridge]::RemoveWindowMarker(
                    $record.handle,
                    [string]$record.markerName
                )) {
                    Write-PortableLog "The detached quest overlay marker was already absent."
                }
            } catch {
                Write-PortableLog "The detached quest overlay marker could not be removed."
            }
        }
        if ($OverlayKind -ceq "minimap") {
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        }
        Remove-NativeOverlayRecordState -OverlayKind $OverlayKind
    } else {
        if ([TarkovHelper.NativeOverlayBridge]::IsWindowHandle($record.handle)) {
            throw [InvalidOperationException]::new("The overlay window identity could not be verified.")
        }
        if ($OverlayKind -ceq "minimap") {
            [TarkovHelper.NativeOverlayBridge]::StopHotKeys()
        }
        Remove-NativeOverlayRecordState -OverlayKind $OverlayKind
    }
    return $true
}

function Remove-AllNativeOverlays {
    $failed = $false
    foreach ($overlayKind in @($script:nativeOverlayRecords.Keys)) {
        try {
            $null = Remove-NativeOverlay -OverlayKind $overlayKind -IgnoreIdentifier
        } catch {
            $failed = $true
            Write-PortableLog "Native $overlayKind overlay restoration failed during shutdown."
        }
    }
    foreach ($claimId in @($script:nativeOverlayClaims.Keys)) {
        Remove-NativeOverlayClaimMarker -Claim $script:nativeOverlayClaims[$claimId]
        [void]$script:nativeOverlayClaims.Remove($claimId)
    }
    $script:nativeOverlayCompletedClaims.Clear()
    if ($failed) {
        throw [InvalidOperationException]::new("One or more native overlays could not be restored.")
    }
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

function Get-AppUpdateDirectory {
    $directory = Join-Path (Initialize-StateDirectory) "app-update"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw [IO.IOException]::new("The app update state directory must not be a reparse point.")
    }
    return $directory
}

function Get-AppUpdateStatusPath { return Join-Path (Get-AppUpdateDirectory) "status.json" }
function Get-AppUpdateCandidatePath { return Join-Path (Get-AppUpdateDirectory) "candidate.json" }
function Get-AppUpdatePendingPath { return Join-Path (Get-AppUpdateDirectory) "pending.json" }
function Get-AppUpdateWorkerPath { return Join-Path (Get-AppUpdateDirectory) "worker.json" }

function Enter-AppUpdateTransactionLock {
    param([ValidateRange(0, 30000)][int]$TimeoutMilliseconds = 0)

    $stateRoot = [IO.Path]::GetFullPath((Initialize-StateDirectory))
    if (([IO.File]::GetAttributes($stateRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw [IO.IOException]::new("The runtime state directory is unsafe for update locking.")
    }
    $lockPath = Join-Path ($stateRoot) "app-update.transaction.lock"
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        try {
            $existingLockEntry = $null
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($stateRoot)) {
                if ([IO.Path]::GetFileName($entry).Equals("app-update.transaction.lock", [StringComparison]::OrdinalIgnoreCase)) { $existingLockEntry = $entry; break }
            }
            if ($null -ne $existingLockEntry) {
                $lockAttributes = [IO.File]::GetAttributes($existingLockEntry)
                if (($lockAttributes -band [IO.FileAttributes]::Directory) -ne 0) { throw [IO.IOException]::new("The update transaction lock path is occupied by a directory; run state repair.") }
                if (($lockAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The update transaction lock path must not be a reparse point.") }
            }
            $stream = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::WriteThrough)
            if (([IO.File]::GetAttributes($lockPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $stream.Dispose()
                throw [IO.IOException]::new("The update transaction lock path must not be a reparse point.")
            }
            return $stream
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 50
        }
    } while ($true)
}

function Exit-AppUpdateTransactionLock {
    param([object]$Lock)
    if ($null -ne $Lock) { try { $Lock.Dispose() } catch { } }
}

function Write-AppUpdateJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value)
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 12
    $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($json)
    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try {
        if ([IO.File]::Exists($Path)) {
            $backup = Join-Path $directory ("." + [IO.Path]::GetFileName($Path) + "." + [Guid]::NewGuid().ToString("N") + ".bak")
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) } finally { if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) } }
        }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Read-AppUpdateJson {
    param([string]$Path, [ValidateRange(1, 4194304)][int]$MaximumBytes = 65536)
    try {
        $file = [IO.FileInfo]::new([IO.Path]::GetFullPath($Path))
        if (-not $file.Exists -or $file.Length -le 0 -or $file.Length -gt $MaximumBytes) { return $null }
        $bytes = [IO.File]::ReadAllBytes($file.FullName)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { return $null }
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        return $encoding.GetString($bytes) | ConvertFrom-Json
    } catch { return $null }
}

function Test-AppUpdateObjectShape {
    param([object]$Value, [string[]]$Properties)
    if ($null -eq $Value -or $Value -is [string]) { return $false }
    $actual = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @("NoteProperty", "Property") } | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Properties.Count) { return $false }
    foreach ($property in $Properties) { if (-not ($actual -ccontains $property)) { return $false } }
    return $true
}

function Test-AppUpdateVersion {
    param([object]$Value)
    if ($Value -isnot [string] -or $Value.Length -gt 64 -or $Value -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { return $false }
    foreach ($part in $Value.Split('.')) { [long]$parsed = 0; if (-not [long]::TryParse($part, [ref]$parsed) -or $parsed -gt 9007199254740991) { return $false } }
    return $true
}

function Compare-AppUpdateVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    if (-not (Test-AppUpdateVersion $Left) -or -not (Test-AppUpdateVersion $Right)) {
        throw [ArgumentException]::new("The app update version is invalid.")
    }
    $leftParts = @($Left.Split('.') | ForEach-Object { [decimal]$_ })
    $rightParts = @($Right.Split('.') | ForEach-Object { [decimal]$_ })
    for ($index = 0; $index -lt 3; $index++) {
        $comparison = [decimal]::Compare($leftParts[$index], $rightParts[$index])
        if ($comparison -ne 0) { return $comparison }
    }
    return 0
}

function Test-AppUpdateInteger {
    param([object]$Value, [long]$Minimum = 0, [long]$Maximum = 9007199254740991)
    if ($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64] -and $Value -isnot [decimal]) { return $false }
    try { $number = [decimal]$Value; return [decimal]::Truncate($number) -eq $number -and $number -ge $Minimum -and $number -le $Maximum } catch { return $false }
}

function Get-AppUpdateContext {
    param([Parameter(Mandatory = $true)][string]$AppRoot)
    $currentVersion = "0.0.0"
    $currentCommit = "0000000000000000000000000000000000000000"
    $packageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expectedAppRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot "app")).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $actualAppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $actualAppRoot.Equals($expectedAppRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ Enabled = $false; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = $null; PackageRoot = $packageRoot; Configuration = $null }
    }
    $version = Read-AppUpdateJson -Path (Join-Path $actualAppRoot "version.json") -MaximumBytes 8192
    if (
        -not (Test-AppUpdateObjectShape $version @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion")) -or
        $version.schemaVersion -ne 1 -or $version.product -cne "tarkov-helper-web" -or -not (Test-AppUpdateVersion $version.version) -or
        $version.commit -isnot [string] -or $version.commit -notmatch '^[0-9a-f]{40}$' -or $version.updaterProtocolVersion -ne 1
    ) {
        return [pscustomobject]@{ Enabled = $false; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = $null; PackageRoot = $packageRoot; Configuration = $null }
    }
    $currentVersion = [string]$version.version
    $currentCommit = [string]$version.commit
    if ($DisablePackageUpdates) {
        # Isolated recovery deliberately shares the immutable package tree but
        # not its runtime state. Never let that state boundary authorize a
        # package mutation or cleanup belonging to the normal installation.
        return [pscustomobject]@{ Enabled = $false; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = $null; PackageRoot = $packageRoot; Configuration = $null }
    }
    $configuration = Read-AppUpdateJson -Path (Join-Path $packageRoot "UPDATE_CONFIG.json") -MaximumBytes 65536
    if ($null -eq $configuration) {
        return [pscustomobject]@{ Enabled = $false; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = $null; PackageRoot = $packageRoot; Configuration = $null }
    }
    if ($configuration.updaterEnabled -ceq $false) {
        if (-not (Test-AppUpdateObjectShape $configuration @("schemaVersion", "updaterEnabled", "protocolVersion")) -or $configuration.schemaVersion -ne 1 -or $configuration.protocolVersion -ne 1) { $configuration = $null }
        return [pscustomobject]@{ Enabled = $false; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = $null; PackageRoot = $packageRoot; Configuration = $configuration }
    }
    $valid = (
        (Test-AppUpdateObjectShape $configuration @("schemaVersion", "updaterEnabled", "protocolVersion", "repository", "releaseApi", "manifestAsset", "signatureAsset", "requireImmutableRelease", "signing")) -and
        (Test-AppUpdateObjectShape $configuration.signing @("algorithm", "keyId", "publicKeySpkiPem")) -and
        $configuration.schemaVersion -eq 1 -and $configuration.updaterEnabled -ceq $true -and $configuration.protocolVersion -eq 1 -and
        $configuration.repository -is [string] -and $configuration.repository -match '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -and
        $configuration.manifestAsset -ceq "update-manifest-v1.json" -and $configuration.signatureAsset -ceq "update-manifest-v1.sig" -and
        $configuration.requireImmutableRelease -ceq $true -and $configuration.signing.algorithm -ceq "RSA-SHA256" -and
        $configuration.signing.keyId -is [string] -and $configuration.signing.keyId -match '^sha256:[0-9a-f]{64}$' -and
        $configuration.signing.publicKeySpkiPem -is [string]
    )
    if ($valid) {
        $expectedApi = "https://api.github.com/repos/$($configuration.repository)/releases/latest"
        if ($env:TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP -ceq "1") {
            try { $testApi = [Uri]$configuration.releaseApi; $valid = $testApi.Scheme -ceq "http" -and $testApi.Host -ceq "127.0.0.1" -and $testApi.AbsolutePath.EndsWith("/repos/$($configuration.repository)/releases/latest", [StringComparison]::Ordinal) } catch { $valid = $false }
        } else { $valid = $configuration.releaseApi -ceq $expectedApi }
    }
    if (-not $valid) { return [pscustomobject]@{ Enabled = $false; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = $null; PackageRoot = $packageRoot; Configuration = $null } }
    return [pscustomobject]@{ Enabled = $true; CurrentVersion = $currentVersion; CurrentCommit = $currentCommit; Repository = [string]$configuration.repository; PackageRoot = $packageRoot; Configuration = $configuration }
}

function Test-AppUpdateWorkerAlive {
    $record = Read-AppUpdateJson -Path (Get-AppUpdateWorkerPath) -MaximumBytes 8192
    if (-not (Test-AppUpdateObjectShape $record @("protocolVersion", "pid", "processStartTimeUtc", "operation")) -or $record.protocolVersion -ne 1 -or $record.pid -isnot [int] -or $record.processStartTimeUtc -isnot [string] -or $record.operation -notin @("CHECK", "STAGE")) { return $false }
    try {
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        return $process.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture) -ceq [string]$record.processStartTimeUtc
    } catch { return $false }
}

function Enter-AppUpdateLoopbackPortReservation {
    param([ValidateRange(1, 65535)][int]$PendingPort)

    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $PendingPort)
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start()
        return $listener
    } catch {
        if ($null -ne $listener) { try { $listener.Stop() } catch { } }
        return $null
    }
}

function Try-ArchiveStalePendingAppUpdate {
    param(
        [object]$Pending,
        [Parameter(Mandatory = $true)][string]$ExpectedPackageRoot
    )

    if ($DisablePackageUpdates) { return $false }

    $transactionLock = $null
    $legacyMutex = $null
    $hasLegacyMutex = $false
    $workerLock = $null
    $portReservation = $null
    try {
        # The sibling file lock crosses Windows sessions. The legacy mutex and
        # worker.lock also serialize already-published brokers/workers in this
        # session. Every acquisition is nonblocking, so mixed-version lock
        # ordering cannot deadlock and a busy transaction is simply preserved.
        $transactionLock = Enter-AppUpdateTransactionLock
        $legacyMutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "UpdateApply"))
        try { $hasLegacyMutex = $legacyMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasLegacyMutex = $true }
        if (-not $hasLegacyMutex) { return $false }
        $sourceDirectory = [IO.Path]::GetFullPath((Get-AppUpdateDirectory))
        $workerLockPath = Join-Path $sourceDirectory "worker.lock"
        try { $workerLock = [IO.FileStream]::new($workerLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch [IO.IOException] { return $false }
        if (Test-AppUpdateWorkerAlive) { return $false }

        $pendingPath = Join-Path $sourceDirectory "pending.json"
        $pendingInfo = [IO.FileInfo]::new($pendingPath)
        $pendingInfo.Refresh()
        if (-not $pendingInfo.Exists -or ($pendingInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $Pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
        $candidateProperty = if ($null -ne $Pending) { $Pending.PSObject.Properties["candidateId"] } else { $null }
        $hasCandidateId = $null -ne $candidateProperty
        $portProperty = if ($null -ne $Pending) { $Pending.PSObject.Properties["port"] } else { $null }
        $hasRecordedPort = $null -ne $portProperty
        if (
            $null -eq $Pending -or $Pending.state -cne "READY_TO_RESTART" -or
            ($hasCandidateId -and ($Pending.candidateId -isnot [string] -or $Pending.candidateId -notmatch '^[A-Za-z0-9_-]{40,64}$')) -or
            ($hasRecordedPort -and -not (Test-AppUpdateInteger -Value $Pending.port -Minimum 1 -Maximum 65535)) -or
            $Pending.packageRoot -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Pending.packageRoot) -or
            -not (Test-AppUpdateVersion $Pending.latestVersion)
        ) { return $false }
        $journalPath = Join-Path $sourceDirectory "apply-journal.json"
        if (Test-LegacyAppUpdatePathOccupied -Path $journalPath) { return $false }
        # Pre-tag metadata did not always record the port. Only absence receives
        # the fixed port selected for this Start; a present malformed value is
        # never downgraded into the legacy compatibility path.
        $pendingPort = if ($hasRecordedPort) { [int]$Pending.port } else { [int]$Port }
        if ($pendingPort -lt 1 -or $pendingPort -gt 65535) { return $false }
        $recordedInstance = Read-PortableInstance
        if ($null -ne $recordedInstance -and $recordedInstance.port -eq $pendingPort) { return $false }
        # A missing/corrupt instance record does not prove the foreign server is
        # gone. Reserve the exact loopback port exclusively and hold it through
        # pending-last archival, closing the probe-to-mutation TOCTOU window.
        $portReservation = Enter-AppUpdateLoopbackPortReservation -PendingPort $pendingPort
        if ($null -eq $portReservation) { return $false }

        $pendingPackageRoot = [IO.Path]::GetFullPath([string]$Pending.packageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $normalizedExpectedRoot = [IO.Path]::GetFullPath($ExpectedPackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if ($pendingPackageRoot.Equals($normalizedExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $pendingRootInfo = [IO.DirectoryInfo]::new($pendingPackageRoot)
        $pendingRootInfo.Refresh()
        $pendingRootOccupied = Test-LegacyAppUpdatePathOccupied -Path $pendingPackageRoot
        if ($pendingRootOccupied -and (-not $pendingRootInfo.Exists -or ($pendingRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
        $pendingLeaf = [IO.Path]::GetFileName($pendingPackageRoot)
        $pendingParentPath = Split-Path -Parent $pendingPackageRoot
        if ([string]::IsNullOrWhiteSpace($pendingLeaf) -or [string]::IsNullOrWhiteSpace($pendingParentPath) -or -not [IO.Directory]::Exists($pendingParentPath)) { return $false }
        $pendingParent = [IO.DirectoryInfo]::new($pendingParentPath)
        $pendingParent.Refresh()
        if (-not $pendingParent.Exists -or ($pendingParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $rollbackRoot = Join-Path $pendingParent.FullName ("." + $pendingLeaf + ".update-backup")
        if (Test-LegacyAppUpdatePathOccupied -Path $rollbackRoot) { return $false }
        if ($hasCandidateId) {
            $cleanupRoot = Join-Path $pendingParent.FullName ("." + $pendingLeaf + ".update-cleanup-" + [string]$Pending.candidateId)
            $failedRoot = Join-Path $pendingParent.FullName ("." + $pendingLeaf + ".update-failed-" + [string]$Pending.candidateId)
            foreach ($evidenceRoot in @($cleanupRoot, $failedRoot)) {
                if (Test-LegacyAppUpdatePathOccupied -Path $evidenceRoot) { return $false }
            }
        } else {
            # Early protocol-1 pending records did not carry candidateId. They
            # can still be retired once the current install is at or above the
            # staged version, but only if no candidate-bound apply evidence for
            # that foreign package exists under any identifier.
            $stagePrefix = "." + $pendingLeaf + ".update-stage-"
            $cleanupPrefix = "." + $pendingLeaf + ".update-cleanup-"
            $failedPrefix = "." + $pendingLeaf + ".update-failed-"
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($pendingParent.FullName)) {
                $entryName = [IO.Path]::GetFileName($entry)
                if (
                    $entryName.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
                    $entryName.StartsWith($cleanupPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                    $entryName.StartsWith($failedPrefix, [StringComparison]::OrdinalIgnoreCase)
                ) { return $false }
            }
        }

        $version = Read-AppUpdateJson -Path (Join-Path $normalizedExpectedRoot "app\version.json") -MaximumBytes 8192
        if (
            -not (Test-AppUpdateObjectShape $version @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion")) -or
            $version.schemaVersion -ne 1 -or $version.product -cne "tarkov-helper-web" -or
            -not (Test-AppUpdateVersion $version.version) -or
            (Compare-AppUpdateVersion -Left ([string]$version.version) -Right ([string]$Pending.latestVersion)) -lt 0
        ) { return $false }

        $stateDirectory = [IO.Path]::GetFullPath((Initialize-StateDirectory))
        $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmssfff", [Globalization.CultureInfo]::InvariantCulture)
        $candidate = ([string]$Pending.candidateId -replace '[^A-Za-z0-9_-]', '')
        if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = [Guid]::NewGuid().ToString("N") }
        if ($candidate.Length -gt 12) { $candidate = $candidate.Substring(0, 12) }
        $backupDirectory = Join-Path $stateDirectory ("app-update-stale-backup-$stamp-$candidate")
        if ([IO.Directory]::Exists($backupDirectory)) { $backupDirectory = Join-Path $stateDirectory ("app-update-stale-backup-$stamp-$candidate-$([Guid]::NewGuid().ToString('N'))") }
        # Preserve operational logs and worker.lock in place. Move only bounded
        # authoritative leaves, with pending.json last as the transaction trigger.
        $archiveNames = @("candidate.json", "status.json", "worker.json")
        if ($Pending.brokerSha256 -is [string] -and $Pending.brokerSha256 -match '^[0-9a-f]{64}$') { $archiveNames += ("broker-" + [string]$Pending.brokerSha256 + ".ps1") }
        $archivePaths = New-Object 'Collections.Generic.List[object]'
        foreach ($archiveName in $archiveNames) {
            $sourcePath = Join-Path $sourceDirectory $archiveName
            if (-not (Test-LegacyAppUpdatePathOccupied -Path $sourcePath)) { continue }
            $sourceInfo = [IO.FileInfo]::new($sourcePath); $sourceInfo.Refresh()
            if (-not $sourceInfo.Exists -or ($sourceInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            if ($sourceInfo.Length -gt 4194304) { return $false }
            $archivePaths.Add([pscustomobject]@{ Source = $sourcePath; Name = $archiveName })
        }
        [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
        foreach ($archivePath in $archivePaths) {
            [IO.File]::Move([string]$archivePath.Source, (Join-Path $backupDirectory ([string]$archivePath.Name)))
        }
        [IO.File]::Move($pendingPath, (Join-Path $backupDirectory "pending.json"))
        Write-PortableLog "Archived stale staged update state from package '$pendingPackageRoot' as '$backupDirectory'; current version '$($version.version)' is already at or above staged version '$($Pending.latestVersion)'."
        [Console]::Error.WriteLine("An old staged update from another installation was archived; the current installation is already up to date.")
        return $true
    } catch {
        Write-PortableLog "A stale staged update could not be archived safely: $($_.Exception.Message)"
        return $false
    } finally {
        if ($null -ne $portReservation) { try { $portReservation.Stop() } catch { } }
        if ($null -ne $workerLock) { try { $workerLock.Dispose() } catch { } }
        if ($hasLegacyMutex) { try { $legacyMutex.ReleaseMutex() } catch { } }
        if ($null -ne $legacyMutex) { try { $legacyMutex.Dispose() } catch { } }
        Exit-AppUpdateTransactionLock -Lock $transactionLock
    }
}

function Get-AppUpdateStatus {
    param([object]$Context)
    if (-not $Context.Enabled) { return [pscustomobject]@{ state = "DISABLED"; currentVersion = [string]$Context.CurrentVersion; reason = "NOT_CONFIGURED" } }
    $status = Read-AppUpdateJson -Path (Get-AppUpdateStatusPath) -MaximumBytes 65536
    if ($null -eq $status -or $status.state -isnot [string] -or $status.currentVersion -cne $Context.CurrentVersion) { return [pscustomobject]@{ state = "IDLE"; currentVersion = [string]$Context.CurrentVersion } }
    $candidatePattern = '^[A-Za-z0-9_-]{40,64}$'; $datePattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
    $valid = switch ($status.state) {
        "IDLE" { Test-AppUpdateObjectShape $status @("state", "currentVersion"); break }
        "CHECKING" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "startedAt")) -and $status.startedAt -is [string] -and $status.startedAt -match $datePattern; break }
        "CURRENT" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "checkedAt")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.checkedAt -is [string] -and $status.checkedAt -match $datePattern; break }
        "AVAILABLE" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "publishedAt", "releasePageUrl", "downloadBytes", "candidateId")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.publishedAt -is [string] -and $status.publishedAt -match $datePattern -and $status.releasePageUrl -ceq "https://github.com/$($Context.Repository)/releases/tag/v$($status.latestVersion)" -and (Test-AppUpdateInteger $status.downloadBytes 1 536870912) -and $status.candidateId -is [string] -and $status.candidateId -match $candidatePattern; break }
        "DOWNLOADING" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "candidateId", "downloadedBytes", "downloadBytes", "startedAt")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.candidateId -is [string] -and $status.candidateId -match $candidatePattern -and (Test-AppUpdateInteger $status.downloadedBytes 0 536870912) -and (Test-AppUpdateInteger $status.downloadBytes 1 536870912) -and [long]$status.downloadedBytes -le [long]$status.downloadBytes -and $status.startedAt -is [string] -and $status.startedAt -match $datePattern; break }
        "VERIFYING" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "candidateId", "startedAt")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.candidateId -is [string] -and $status.candidateId -match $candidatePattern -and $status.startedAt -is [string] -and $status.startedAt -match $datePattern; break }
        "READY_TO_RESTART" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "candidateId", "stagedAt")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.candidateId -is [string] -and $status.candidateId -match $candidatePattern -and $status.stagedAt -is [string] -and $status.stagedAt -match $datePattern -and [IO.File]::Exists((Get-AppUpdatePendingPath)); break }
        "APPLYING" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "startedAt")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.startedAt -is [string] -and $status.startedAt -match $datePattern; break }
        "ROLLING_BACK" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "latestVersion", "startedAt")) -and (Test-AppUpdateVersion $status.latestVersion) -and $status.startedAt -is [string] -and $status.startedAt -match $datePattern; break }
        "UPDATED" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "previousVersion", "updatedAt")) -and (Test-AppUpdateVersion $status.previousVersion) -and $status.updatedAt -is [string] -and $status.updatedAt -match $datePattern; break }
        "ERROR" { (Test-AppUpdateObjectShape $status @("state", "currentVersion", "operation", "code", "message")) -and $status.operation -in @("CHECK", "STAGE", "APPLY", "ROLLBACK") -and $status.code -is [string] -and $status.code -match '^[A-Z][A-Z0-9_]{1,63}$' -and $status.message -is [string] -and $status.message.Length -ge 1 -and $status.message.Length -le 500; break }
        default { $false }
    }
    if (-not $valid) { return [pscustomobject]@{ state = "IDLE"; currentVersion = [string]$Context.CurrentVersion } }
    if ($status.state -in @("CHECKING", "DOWNLOADING", "VERIFYING") -and -not (Test-AppUpdateWorkerAlive)) {
        $operation = if ($status.state -eq "CHECKING") { "CHECK" } else { "STAGE" }
        $status = [pscustomobject]@{ state = "ERROR"; currentVersion = [string]$Context.CurrentVersion; operation = $operation; code = "WORKER_EXITED"; message = "The background update worker stopped unexpectedly." }
        Write-AppUpdateJson -Path (Get-AppUpdateStatusPath) -Value $status
    }
    return $status
}

function Start-AppUpdateWorker {
    param([ValidateSet("Check", "Stage")][string]$WorkerAction, [object]$Context, [string]$ReviewedCandidate, [ValidateRange(1, 65535)][int]$BoundPort)
    if ($DisablePackageUpdates) { throw [InvalidOperationException]::new("Package updates are disabled in isolated recovery mode.") }
    $updateDirectory = Get-AppUpdateDirectory
    foreach ($transactionName in @("pending.json", "apply-journal.json")) {
        $transactionPath = Join-Path $updateDirectory $transactionName
        try { $transactionExists = Test-Path -LiteralPath $transactionPath -ErrorAction Stop }
        catch { throw [InvalidOperationException]::new("The prior app update transaction state could not be inspected.") }
        if ($transactionExists) {
            throw [InvalidOperationException]::new("A prior app update transaction still requires cleanup.")
        }
    }
    $current = Get-AppUpdateStatus -Context $Context
    if ($current.state -in @("CHECKING", "DOWNLOADING", "VERIFYING", "APPLYING", "ROLLING_BACK")) { throw [InvalidOperationException]::new("An update operation is already in progress.") }
    if ($WorkerAction -eq "Stage" -and ($current.state -ne "AVAILABLE" -or $current.candidateId -cne $ReviewedCandidate)) { throw [ArgumentException]::new("The reviewed update candidate is no longer available.") }
    $worker = Join-Path $Context.PackageRoot "app-update-worker.ps1"
    if (-not [IO.File]::Exists($worker)) { throw [IO.FileNotFoundException]::new("The app update worker is missing.", $worker) }
    $now = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    if ($WorkerAction -eq "Check") { $initial = [pscustomobject]@{ state = "CHECKING"; currentVersion = [string]$Context.CurrentVersion; startedAt = $now } }
    else { $initial = [pscustomobject]@{ state = "DOWNLOADING"; currentVersion = [string]$Context.CurrentVersion; latestVersion = [string]$current.latestVersion; candidateId = $ReviewedCandidate; downloadedBytes = [long]0; downloadBytes = [long]$current.downloadBytes; startedAt = $now } }
    Write-AppUpdateJson -Path (Get-AppUpdateStatusPath) -Value $initial
    $powershell = Join-Path $PSHOME "powershell.exe"; if (-not [IO.File]::Exists($powershell)) { $powershell = "powershell.exe" }
    $arguments = @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $worker, "-Action", $WorkerAction, "-PackageRoot", $Context.PackageRoot, "-StateDirectory", $StateDirectory, "-Port", [string]$BoundPort, "-StartedAt", $now)
    if ($WorkerAction -eq "Stage") { $arguments += @("-CandidateId", $ReviewedCandidate) }
    $argumentLine = ($arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join " "
    $child = Start-Process -FilePath $powershell -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
    $startedAt = $child.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    Write-AppUpdateJson -Path (Get-AppUpdateWorkerPath) -Value ([pscustomobject]@{ protocolVersion = 1; pid = $child.Id; processStartTimeUtc = $startedAt; operation = $WorkerAction.ToUpperInvariant() })
    return $initial
}

function Read-PortableInstance {
    try {
        $instancePath = Get-InstancePath
        if (-not [IO.File]::Exists($instancePath)) { return $null }
        $info = [IO.FileInfo]::new($instancePath)
        if (
            ($info.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0 -or
            $info.Length -lt 2 -or
            $info.Length -gt 32768
        ) {
            return $null
        }
        $stream = [IO.FileStream]::new(
            $instancePath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        try {
            if ($stream.Length -lt 2 -or $stream.Length -gt 32768) { return $null }
            $bytes = New-Object byte[] ([int]$stream.Length)
            $offset = 0
            while ($offset -lt $bytes.Length) {
                $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
                if ($read -le 0) { return $null }
                $offset += $read
            }
            if ($stream.Length -ne $bytes.Length) { return $null }
        } finally {
            $stream.Dispose()
        }
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $instance = ConvertFrom-Json -InputObject $strictUtf8.GetString($bytes) -ErrorAction Stop
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

function Get-FileSha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = $hasher.ComputeHash($stream)
            return ([BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Test-AppUpdateTreeDigest {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][int]$ExpectedFileCount,
        [Parameter(Mandatory = $true)][long]$ExpectedBytes,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    try {
        $root = [IO.Path]::GetFullPath($RootPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $rootInfo = [IO.DirectoryInfo]::new($root)
        $rootInfo.Refresh()
        if (-not $rootInfo.Exists -or ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }

        $directories = New-Object 'Collections.Generic.Stack[string]'
        $files = New-Object 'Collections.Generic.List[string]'
        $directories.Push($root)
        while ($directories.Count -gt 0) {
            $directory = $directories.Pop()
            $directoryAttributes = [IO.File]::GetAttributes($directory)
            if (($directoryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
                $attributes = [IO.File]::GetAttributes($entry)
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
                if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $directories.Push($entry) }
                else { $files.Add($entry.Substring($root.Length + 1).Replace("\", "/")) }
            }
        }
        if ($files.Count -ne $ExpectedFileCount) { return $false }
        $files.Sort([StringComparer]::Ordinal)

        [long]$totalBytes = 0
        $manifest = New-Object Text.StringBuilder
        foreach ($relative in $files) {
            $file = Join-Path $root $relative.Replace("/", [string][IO.Path]::DirectorySeparatorChar)
            $attributes = [IO.File]::GetAttributes($file)
            if (($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { return $false }
            $info = [IO.FileInfo]::new($file)
            $info.Refresh()
            $totalBytes += [long]$info.Length
            if ($totalBytes -gt $ExpectedBytes) { return $false }
            $null = $manifest.Append((Get-FileSha256Hex -Path $file)).Append("  ").Append($info.Length.ToString([Globalization.CultureInfo]::InvariantCulture)).Append("  ").Append($relative).Append("`n")
        }
        if ($totalBytes -ne $ExpectedBytes) { return $false }

        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($manifest.ToString())
            $digest = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
        return $digest -ceq $ExpectedSha256
    } catch {
        return $false
    }
}

function Test-LegacyAppUpdatePathOccupied {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if (-not [IO.Directory]::Exists($parent)) { return $false }
    $leaf = [IO.Path]::GetFileName($fullPath)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($parent)) {
        if ([IO.Path]::GetFileName($entry).Equals($leaf, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Test-LegacyAppUpdateRegularFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($Path)) { return $false }
    try {
        $attributes = [IO.File]::GetAttributes([IO.Path]::GetFullPath($Path))
        return ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -eq 0
    } catch {
        return $false
    }
}

function Test-LegacyAppUpdateTopDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.Directory]::Exists($Path)) { return $false }
    try {
        return (([IO.File]::GetAttributes([IO.Path]::GetFullPath($Path)) -band [IO.FileAttributes]::ReparsePoint) -eq 0)
    } catch {
        return $false
    }
}

function Read-LegacyAppUpdateText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(1, 1048576)][int]$MaximumBytes = 65536
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-LegacyAppUpdateRegularFile -Path $fullPath)) {
        throw [IO.InvalidDataException]::new("A legacy package metadata file is missing or unsafe.")
    }
    $file = [IO.FileInfo]::new($fullPath)
    if ($file.Length -le 0 -or $file.Length -gt $MaximumBytes) {
        throw [IO.InvalidDataException]::new("A legacy package metadata file is outside its size limit.")
    }
    $bytes = [IO.File]::ReadAllBytes($fullPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
        throw [IO.InvalidDataException]::new("A legacy package metadata file has an unexpected byte-order mark.")
    }
    return (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
}

function Test-LegacyAppUpdateCriticalChecksums {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    try {
        $manifestPath = Join-Path $PackageRoot "SHA256SUMS.txt"
        $manifest = Read-LegacyAppUpdateText -Path $manifestPath -MaximumBytes 1048576
        if (-not $manifest.EndsWith("`n", [StringComparison]::Ordinal) -or $manifest.Contains("`r")) { return $false }
        $records = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
        $previousPath = $null
        foreach ($line in $manifest.Substring(0, $manifest.Length - 1).Split("`n")) {
            $match = [Text.RegularExpressions.Regex]::Match($line, '^([0-9a-f]{64})  (0|[1-9]\d*)  (.+)$')
            if (-not $match.Success) { return $false }
            $relative = $match.Groups[3].Value
            if (
                [string]::IsNullOrWhiteSpace($relative) -or
                $relative.Contains("\") -or $relative.Contains([char]0) -or
                $relative.StartsWith("/", [StringComparison]::Ordinal) -or
                $relative -match '^[A-Za-z]:'
            ) { return $false }
            foreach ($segment in $relative.Split('/')) {
                if ([string]::IsNullOrEmpty($segment) -or $segment -in @(".", "..")) { return $false }
            }
            if ($null -ne $previousPath -and [string]::CompareOrdinal([string]$previousPath, $relative) -ge 0) { return $false }
            if ($records.ContainsKey($relative)) { return $false }
            [long]$size = 0
            if (-not [long]::TryParse($match.Groups[2].Value, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$size) -or $size -lt 0) { return $false }
            $records.Add($relative, [pscustomobject]@{ Sha256 = $match.Groups[1].Value; Size = $size })
            $previousPath = $relative
        }

        foreach ($relative in @("PACKAGE_INFO.txt", "app/version.json")) {
            if (-not $records.ContainsKey($relative)) { return $false }
            $filePath = Join-Path $PackageRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
            if (-not (Test-LegacyAppUpdateRegularFile -Path $filePath)) { return $false }
            $record = $records[$relative]
            if ([IO.FileInfo]::new($filePath).Length -ne [long]$record.Size) { return $false }
            if ((Get-FileSha256Hex -Path $filePath) -cne [string]$record.Sha256) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

function Get-LegacyAppUpdatePackageIdentity {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    try {
        $root = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $appRoot = Join-Path $root "app"
        $versionPath = Join-Path $appRoot "version.json"
        if (
            -not (Test-LegacyAppUpdateTopDirectory -Path $root) -or
            -not (Test-LegacyAppUpdateTopDirectory -Path $appRoot) -or
            -not (Test-LegacyAppUpdateRegularFile -Path $versionPath)
        ) { return $null }
        $version = Read-AppUpdateJson -Path $versionPath -MaximumBytes 8192
        if (
            -not (Test-AppUpdateObjectShape $version @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion")) -or
            $version.schemaVersion -ne 1 -or $version.product -cne "tarkov-helper-web" -or
            -not (Test-AppUpdateVersion $version.version) -or
            $version.commit -isnot [string] -or $version.commit -notmatch '^[0-9a-f]{40}$' -or
            $version.updaterProtocolVersion -ne 1
        ) { return $null }

        $packageInfo = Read-LegacyAppUpdateText -Path (Join-Path $root "PACKAGE_INFO.txt") -MaximumBytes 65536
        $versionMatches = [Text.RegularExpressions.Regex]::Matches($packageInfo, '(?m)^Version: ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\r?$')
        $commitMatches = [Text.RegularExpressions.Regex]::Matches($packageInfo, '(?m)^Source commit: ([0-9a-f]{40})\r?$')
        $protocolMatches = [Text.RegularExpressions.Regex]::Matches($packageInfo, '(?m)^Updater protocol: (1)\r?$')
        if (
            $versionMatches.Count -ne 1 -or $commitMatches.Count -ne 1 -or $protocolMatches.Count -ne 1 -or
            $versionMatches[0].Groups[1].Value -cne [string]$version.version -or
            $commitMatches[0].Groups[1].Value -cne [string]$version.commit -or
            -not (Test-LegacyAppUpdateCriticalChecksums -PackageRoot $root)
        ) { return $null }
        return [pscustomobject]@{ Version = [string]$version.version; Commit = [string]$version.commit }
    } catch {
        return $null
    }
}

function Test-LegacyAppUpdateTreeNoReparse {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    try {
        $root = [IO.Path]::GetFullPath($RootPath)
        if (-not (Test-LegacyAppUpdateTopDirectory -Path $root)) { return $false }
        $pending = New-Object 'Collections.Generic.Stack[string]'
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
                $attributes = [IO.File]::GetAttributes($entry)
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
                if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $pending.Push($entry) }
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Test-LegacyAppUpdateTreeBoundedNoReparse {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [ValidateRange(1, 10000)][int]$MaximumEntries = 10000,
        [ValidateRange(1, 1073741824)][long]$MaximumBytes = 1073741824
    )

    try {
        $root = [IO.Path]::GetFullPath($RootPath)
        if (-not (Test-LegacyAppUpdateTopDirectory -Path $root)) { return $false }
        $pending = New-Object 'Collections.Generic.Stack[string]'
        $pending.Push($root)
        [int]$entryCount = 0
        [long]$totalBytes = 0
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
                $entryCount += 1
                if ($entryCount -gt $MaximumEntries) { return $false }
                $attributes = [IO.File]::GetAttributes($entry)
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
                if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                    $pending.Push($entry)
                } else {
                    $length = [long]([IO.FileInfo]::new($entry).Length)
                    if ($length -lt 0 -or $length -gt ($MaximumBytes - $totalBytes)) { return $false }
                    $totalBytes += $length
                }
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Remove-LegacyAppUpdateTreeNoReparse {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [ValidateRange(1, 10000)][int]$MaximumEntries = 10000,
        [ValidateRange(1, 1073741824)][long]$MaximumBytes = 1073741824
    )

    $root = [IO.Path]::GetFullPath($RootPath)
    if (-not (Test-LegacyAppUpdateTreeBoundedNoReparse -RootPath $root -MaximumEntries $MaximumEntries -MaximumBytes $MaximumBytes)) {
        throw [IO.IOException]::new("Refusing to remove a cleanup tree containing an unsafe or unbounded path.")
    }
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $directories = New-Object 'Collections.Generic.List[string]'
    [int]$entryCount = 0
    [long]$totalBytes = 0
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        $attributes = [IO.File]::GetAttributes($directory)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw [IO.IOException]::new("A legacy cleanup directory changed during removal.")
        }
        $directories.Add($directory)
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $entryCount += 1
            if ($entryCount -gt $MaximumEntries) {
                throw [IO.IOException]::new("A cleanup tree exceeded its entry limit during removal.")
            }
            $entryAttributes = [IO.File]::GetAttributes($entry)
            if (($entryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw [IO.IOException]::new("A legacy cleanup entry changed during removal.")
            }
            if (($entryAttributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push($entry)
            } else {
                $length = [long]([IO.FileInfo]::new($entry).Length)
                if ($length -lt 0 -or $length -gt ($MaximumBytes - $totalBytes)) {
                    throw [IO.IOException]::new("A cleanup tree exceeded its byte limit during removal.")
                }
                $totalBytes += $length
                if (($entryAttributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
                    [IO.File]::SetAttributes($entry, ($entryAttributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
                }
                [IO.File]::Delete($entry)
            }
        }
    }
    for ($index = $directories.Count - 1; $index -ge 0; $index -= 1) {
        $directory = $directories[$index]
        $attributes = [IO.File]::GetAttributes($directory)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw [IO.IOException]::new("A legacy cleanup directory changed before removal.")
        }
        if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
            [IO.File]::SetAttributes($directory, ($attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
        }
        [IO.Directory]::Delete($directory, $false)
    }
}

function Get-LegacyAppUpdateCleanupRoot {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$CurrentVersion,
        [Parameter(Mandatory = $true)][string]$CurrentCommit,
        [Parameter(Mandatory = $true)][string]$PreviousVersion,
        [Parameter(Mandatory = $true)][string]$PreviousCommit
    )

    $root = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $canonicalRoot = $root.ToUpperInvariant()
    $seed = "$canonicalRoot`n$CurrentVersion`n$CurrentCommit`n$PreviousVersion`n$PreviousCommit"
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hasher.ComputeHash((New-Object Text.UTF8Encoding($false, $true)).GetBytes($seed))
    } finally {
        $hasher.Dispose()
    }
    $identifier = ([BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    $parent = Split-Path -Parent $root
    $leaf = [IO.Path]::GetFileName($root)
    return Join-Path $parent ("." + $leaf + ".update-cleanup-legacy-" + $identifier)
}

function Test-LegacyAppUpdateReceipt {
    param(
        [object]$Receipt,
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$BackupRoot,
        [object]$CurrentIdentity
    )

    if (
        -not (Test-AppUpdateObjectShape $Receipt @("schemaVersion", "state", "packageRoot", "backupRoot", "cleanupRoot", "currentVersion", "currentCommit", "previousVersion", "previousCommit", "updatedAt", "createdAt")) -or
        $Receipt.schemaVersion -ne 1 -or $Receipt.state -cne "READY_TO_DELETE" -or
        $Receipt.packageRoot -isnot [string] -or $Receipt.backupRoot -isnot [string] -or $Receipt.cleanupRoot -isnot [string] -or
        $Receipt.currentVersion -cne [string]$CurrentIdentity.Version -or $Receipt.currentCommit -cne [string]$CurrentIdentity.Commit -or
        -not (Test-AppUpdateVersion $Receipt.previousVersion) -or
        (Compare-AppUpdateVersion -Left ([string]$Receipt.previousVersion) -Right ([string]$Receipt.currentVersion)) -ge 0 -or
        $Receipt.previousCommit -isnot [string] -or $Receipt.previousCommit -notmatch '^[0-9a-f]{40}$' -or
        $Receipt.updatedAt -isnot [string] -or $Receipt.updatedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$' -or
        $Receipt.createdAt -isnot [string] -or
        $Receipt.createdAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
    ) { return $false }
    $expectedCleanupRoot = Get-LegacyAppUpdateCleanupRoot -PackageRoot $PackageRoot -CurrentVersion ([string]$Receipt.currentVersion) -CurrentCommit ([string]$Receipt.currentCommit) -PreviousVersion ([string]$Receipt.previousVersion) -PreviousCommit ([string]$Receipt.previousCommit)
    return (
        ([string]$Receipt.packageRoot).Equals([IO.Path]::GetFullPath($PackageRoot), [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$Receipt.backupRoot).Equals([IO.Path]::GetFullPath($BackupRoot), [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$Receipt.cleanupRoot).Equals([IO.Path]::GetFullPath($expectedCleanupRoot), [StringComparison]::OrdinalIgnoreCase)
    )
}

function Invoke-LegacyAppUpdateBackupCleanup {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    if ($DisablePackageUpdates) { return "DONE" }

    try {
        $updateDirectory = Get-AppUpdateDirectory
        $pendingPath = Join-Path $updateDirectory "pending.json"
        $journalPath = Join-Path $updateDirectory "apply-journal.json"
        if (
            (Test-LegacyAppUpdatePathOccupied -Path $pendingPath) -or
            (Test-LegacyAppUpdatePathOccupied -Path $journalPath) -or
            (Test-AppUpdateWorkerAlive)
        ) { return "RETRY" }

        $context = Get-AppUpdateContext -AppRoot $AppRoot
        if (-not $context.Enabled) { return "DONE" }
        $packageRoot = [IO.Path]::GetFullPath([string]$context.PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $parent = Split-Path -Parent $packageRoot
        $leaf = [IO.Path]::GetFileName($packageRoot)
        $backupRoot = Join-Path $parent ("." + $leaf + ".update-backup")
        $receiptPath = Join-Path $updateDirectory "legacy-cleanup.json"
        if (
            -not (Test-LegacyAppUpdateTopDirectory -Path $parent) -or
            -not (Test-LegacyAppUpdateTopDirectory -Path $packageRoot)
        ) { return "DONE" }
        $currentIdentity = Get-LegacyAppUpdatePackageIdentity -PackageRoot $packageRoot
        if (
            $null -eq $currentIdentity -or
            $currentIdentity.Version -cne [string]$context.CurrentVersion -or
            $currentIdentity.Commit -cne [string]$context.CurrentCommit
        ) { return "DONE" }

        $receipt = $null
        if (Test-LegacyAppUpdatePathOccupied -Path $receiptPath) {
            if (-not (Test-LegacyAppUpdateRegularFile -Path $receiptPath)) { return "DONE" }
            $receipt = Read-AppUpdateJson -Path $receiptPath -MaximumBytes 65536
            if (-not (Test-LegacyAppUpdateReceipt -Receipt $receipt -PackageRoot $packageRoot -BackupRoot $backupRoot -CurrentIdentity $currentIdentity)) { return "DONE" }
        } else {
            if (-not (Test-LegacyAppUpdatePathOccupied -Path $backupRoot)) { return "DONE" }
            if (-not (Test-LegacyAppUpdateTopDirectory -Path $backupRoot)) { return "DONE" }
            $previousIdentity = Get-LegacyAppUpdatePackageIdentity -PackageRoot $backupRoot
            if (
                $null -eq $previousIdentity -or
                (Compare-AppUpdateVersion -Left ([string]$previousIdentity.Version) -Right ([string]$currentIdentity.Version)) -ge 0 -or
                -not (Test-LegacyAppUpdateTreeNoReparse -RootPath $backupRoot)
            ) { return "DONE" }
            $cleanupRoot = Get-LegacyAppUpdateCleanupRoot -PackageRoot $packageRoot -CurrentVersion ([string]$currentIdentity.Version) -CurrentCommit ([string]$currentIdentity.Commit) -PreviousVersion ([string]$previousIdentity.Version) -PreviousCommit ([string]$previousIdentity.Commit)
            if (Test-LegacyAppUpdatePathOccupied -Path $cleanupRoot) { return "DONE" }
            $receipt = [pscustomobject][ordered]@{
                schemaVersion = 1
                state = "READY_TO_DELETE"
                packageRoot = $packageRoot
                backupRoot = [IO.Path]::GetFullPath($backupRoot)
                cleanupRoot = [IO.Path]::GetFullPath($cleanupRoot)
                currentVersion = [string]$currentIdentity.Version
                currentCommit = [string]$currentIdentity.Commit
                previousVersion = [string]$previousIdentity.Version
                previousCommit = [string]$previousIdentity.Commit
                updatedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
                createdAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
            }
            Write-AppUpdateJson -Path $receiptPath -Value $receipt
            $durableReceipt = Read-AppUpdateJson -Path $receiptPath -MaximumBytes 65536
            if (-not (Test-LegacyAppUpdateReceipt -Receipt $durableReceipt -PackageRoot $packageRoot -BackupRoot $backupRoot -CurrentIdentity $currentIdentity)) { return "RETRY" }
            $receipt = $durableReceipt
            if ($env:TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_CRASH_AFTER_RECEIPT -ceq "1") {
                [Environment]::Exit(85)
            }
        }

        $cleanupRoot = [IO.Path]::GetFullPath([string]$receipt.cleanupRoot)
        $backupOccupied = Test-LegacyAppUpdatePathOccupied -Path $backupRoot
        $cleanupOccupied = Test-LegacyAppUpdatePathOccupied -Path $cleanupRoot
        if ($backupOccupied) {
            if ($cleanupOccupied -or -not (Test-LegacyAppUpdateTopDirectory -Path $backupRoot)) { return "DONE" }
            $previousIdentity = Get-LegacyAppUpdatePackageIdentity -PackageRoot $backupRoot
            if (
                $null -eq $previousIdentity -or
                $previousIdentity.Version -cne [string]$receipt.previousVersion -or
                $previousIdentity.Commit -cne [string]$receipt.previousCommit -or
                -not (Test-LegacyAppUpdateTreeNoReparse -RootPath $backupRoot)
            ) { return "DONE" }
            try {
                $backupAttributes = [IO.File]::GetAttributes($backupRoot)
                [IO.File]::SetAttributes($backupRoot, ($backupAttributes -bor [IO.FileAttributes]::Hidden))
            } catch {
                Write-PortableLog "The authenticated legacy backup could not be hidden before rename."
            }
            [IO.Directory]::Move($backupRoot, $cleanupRoot)
            try {
                $cleanupAttributes = [IO.File]::GetAttributes($cleanupRoot)
                [IO.File]::SetAttributes($cleanupRoot, ($cleanupAttributes -bor [IO.FileAttributes]::Hidden))
            } catch {
                Write-PortableLog "The renamed legacy cleanup tree could not be hidden."
            }
            if ($env:TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_CRASH_AFTER_RENAME -ceq "1") {
                [Environment]::Exit(86)
            }
            $cleanupOccupied = $true
        }

        if (-not $cleanupOccupied) {
            try { [IO.File]::Delete($receiptPath) } catch { return "RETRY" }
            return "DONE"
        }
        if (-not (Test-LegacyAppUpdateTopDirectory -Path $cleanupRoot)) { return "DONE" }
        try {
            $cleanupAttributes = [IO.File]::GetAttributes($cleanupRoot)
            [IO.File]::SetAttributes($cleanupRoot, ($cleanupAttributes -bor [IO.FileAttributes]::Hidden))
        } catch {
            Write-PortableLog "The deferred legacy cleanup tree could not be hidden."
        }
        if (-not (Test-LegacyAppUpdateTreeNoReparse -RootPath $cleanupRoot)) { return "DONE" }

        $deleteFailuresRemaining = 0
        if (-not [int]::TryParse([string]$env:TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_DELETE_FAILURES, [ref]$deleteFailuresRemaining) -or $deleteFailuresRemaining -lt 0) {
            $deleteFailuresRemaining = 0
        }
        for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
            try {
                if ($deleteFailuresRemaining -gt 0) {
                    $deleteFailuresRemaining -= 1
                    throw [IO.IOException]::new("Injected transient legacy cleanup failure.")
                }
                Remove-LegacyAppUpdateTreeNoReparse -RootPath $cleanupRoot
                try { [IO.File]::Delete($receiptPath) } catch { return "RETRY" }
                return "DONE"
            } catch [IO.IOException] {
                if ($attempt -lt 7) { Start-Sleep -Milliseconds ([Math]::Min(250, [int](25 * [Math]::Pow(2, $attempt)))) }
            } catch [UnauthorizedAccessException] {
                if ($attempt -lt 7) { Start-Sleep -Milliseconds ([Math]::Min(250, [int](25 * [Math]::Pow(2, $attempt)))) }
            }
        }
        try {
            $cleanupAttributes = [IO.File]::GetAttributes($cleanupRoot)
            [IO.File]::SetAttributes($cleanupRoot, ($cleanupAttributes -bor [IO.FileAttributes]::Hidden))
        } catch { }
        return "RETRY"
    } catch {
        Write-PortableLog "Legacy committed backup cleanup was deferred: $($_.Exception.GetType().Name)"
        return "RETRY"
    }
}

function Invoke-LegacyAppUpdateBackupCleanupFromServe {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    $controlPurpose = "Control"
    $mutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose $controlPurpose))
    $hasMutex = $false
    try {
        try {
            $hasMutex = $mutex.WaitOne(0)
        } catch [Threading.AbandonedMutexException] {
            $hasMutex = $true
        }
        if (-not $hasMutex) { return "RETRY" }
        return Invoke-LegacyAppUpdateBackupCleanup -AppRoot $AppRoot
    } catch {
        Write-PortableLog "The replacement server deferred legacy backup cleanup."
        return "RETRY"
    } finally {
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
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
        $identityHashes = @(Get-FileSha256Hex -Path $index)
        $dataPath = Join-Path $normalizedRoot "data\tarkov-data.json"
        if ([IO.File]::Exists($dataPath)) {
            $identityHashes += Get-FileSha256Hex -Path $dataPath
        }
        $appIdentity = $identityHashes -join ":"
    }

    $launcherIdentity = Get-FileSha256Hex -Path $PSCommandPath
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

function Get-SupportedPortableBrowserPath {
    if (-not $IsWindowsPlatform) { return $null }

    # Use only fixed installation roots. In particular, do not resolve these
    # executables through PATH or a per-user App Paths override.
    $candidates = @(
        $(if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
            Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
        }),
        $(if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
            Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"
        }),
        $(if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
            Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
        }),
        $(if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
            Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
        }),
        $(if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"
        })
    )

    foreach ($candidatePath in $candidates) {
        try {
            $fullPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidatePath))
            $fileName = [IO.Path]::GetFileName($fullPath)
            if (
                @("msedge.exe", "chrome.exe") -ccontains $fileName -and
                [IO.File]::Exists($fullPath)
            ) {
                return $fullPath
            }
        } catch {
            # Ignore malformed environment paths and continue through the fixed
            # browser installation candidates.
        }
    }
    return $null
}

function Open-PortableBrowser {
    param([string]$Url)

    if ($NoBrowser) { return }
    try {
        $supportedBrowserPath = Get-SupportedPortableBrowserPath
        if ($null -ne $supportedBrowserPath) {
            try {
                $startInfo = New-Object Diagnostics.ProcessStartInfo
                $startInfo.FileName = $supportedBrowserPath
                $startInfo.Arguments = ConvertTo-ProcessArgument -Value $Url
                $startInfo.UseShellExecute = $false
                [Diagnostics.Process]::Start($startInfo) | Out-Null
                return
            } catch {
                Write-PortableLog "The supported browser could not be opened; falling back to the default browser."
            }
            [Diagnostics.Process]::Start($Url) | Out-Null
        } else {
            Write-PortableLog "Edge or Chrome was not found; native overlay features will be unavailable in the default browser."
            [Diagnostics.Process]::Start($Url) | Out-Null
        }
    } catch {
        Write-PortableLog "A supported browser could not be opened."
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

function Invoke-PendingAppUpdate {
    param(
        [switch]$ValidateOnly,
        [string]$ExpectedCandidate = ""
    )

    if ($DisablePackageUpdates) {
        Write-PortableLog "A staged app update was preserved because package updates are disabled for isolated recovery."
        return 2
    }

    $pendingPath = Get-AppUpdatePendingPath
    if (-not [IO.File]::Exists($pendingPath)) { return $null }
    if ($Port -eq 0) {
        [Console]::Error.WriteLine("A staged update requires a fixed local port.")
        Write-PortableLog "Staged update apply was refused because the local port is not fixed."
        return 2
    }
    $pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
    $expectedPackageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expectedAppRoot = [IO.Path]::GetFullPath((Join-Path $expectedPackageRoot "app")).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ([string]::IsNullOrWhiteSpace($ExpectedCandidate) -and (Try-ArchiveStalePendingAppUpdate -Pending $pending -ExpectedPackageRoot $expectedPackageRoot)) {
        return $null
    }
    # The archive decision is made under cross-session transaction locks. Read
    # the trigger again after that critical section so strict apply validation
    # never continues with a stale pre-lock object.
    $pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
    if (
        -not (Test-AppUpdateObjectShape $pending @("schemaVersion", "state", "candidateId", "packageRoot", "stageRoot", "stateDirectory", "port", "currentVersion", "currentCommit", "latestVersion", "latestCommit", "treeSha256", "fileCount", "unpackedBytes", "brokerSha256", "healthNonce", "stagedAt")) -or
        $pending.schemaVersion -ne 1 -or $pending.state -cne "READY_TO_RESTART" -or
        (-not [string]::IsNullOrWhiteSpace($ExpectedCandidate) -and $pending.candidateId -cne $ExpectedCandidate) -or
        -not ([string]$pending.packageRoot).Equals($expectedPackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$pending.stateDirectory).Equals([IO.Path]::GetFullPath($StateDirectory), [StringComparison]::OrdinalIgnoreCase) -or
        $pending.port -ne $Port -or
        -not ([IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)).Equals($expectedAppRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $pending.brokerSha256 -isnot [string] -or $pending.brokerSha256 -notmatch '^[0-9a-f]{64}$'
    ) {
        [Console]::Error.WriteLine("The staged update state is invalid and was preserved.")
        Write-PortableLog "Staged update apply was refused because pending state validation failed."
        return 2
    }
    $source = Join-Path $expectedPackageRoot "app-update-broker.ps1"
    $sourceTrusted = $false
    if (Test-LegacyAppUpdateRegularFile -Path $source) {
        try { $sourceTrusted = (Get-FileSha256Hex -Path $source) -ceq [string]$pending.brokerSha256 } catch { $sourceTrusted = $false }
    }
    if (-not $sourceTrusted) {
        # The broker that owns a first-hop swap is copied from the installed
        # (old) package. After NEW_MOVED, the current root contains the new
        # broker, so a crash recovery must authenticate that old broker from
        # the broker-created fixed rollback tree. Never trust the state copy by
        # itself and never search arbitrary paths.
        try {
            $packageInfo = [IO.DirectoryInfo]::new($expectedPackageRoot)
            $packageInfo.Refresh()
            if ($packageInfo.Exists -and ($packageInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and $null -ne $packageInfo.Parent) {
                $packageInfo.Parent.Refresh()
                $backupRoot = Join-Path $packageInfo.Parent.FullName ("." + $packageInfo.Name + ".update-backup")
                $backupSource = Join-Path $backupRoot "app-update-broker.ps1"
                if (
                    ($packageInfo.Parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
                    (Test-LegacyAppUpdateTopDirectory -Path $backupRoot) -and
                    (Test-LegacyAppUpdateRegularFile -Path $backupSource)
                ) {
                    $backupVersion = Read-AppUpdateJson -Path (Join-Path $backupRoot "app\version.json") -MaximumBytes 8192
                    if (
                        (Test-AppUpdateObjectShape $backupVersion @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion")) -and
                        $backupVersion.schemaVersion -eq 1 -and $backupVersion.product -ceq "tarkov-helper-web" -and
                        $backupVersion.version -ceq $pending.currentVersion -and
                        $backupVersion.commit -ceq $pending.currentCommit -and
                        $backupVersion.updaterProtocolVersion -eq 1 -and
                        (Get-FileSha256Hex -Path $backupSource) -ceq [string]$pending.brokerSha256
                    ) {
                        $source = $backupSource
                        $sourceTrusted = $true
                        Write-PortableLog "Recovered the pinned update broker from the authenticated rollback package."
                    }
                }
            }
        } catch {
            $sourceTrusted = $false
        }
    }
    if (-not $sourceTrusted) {
        [Console]::Error.WriteLine("The trusted app update broker does not match the staged update state.")
        Write-PortableLog "Staged update apply was refused because the trusted broker digest did not match."
        return 2
    }
    $directory = Get-AppUpdateDirectory
    $broker = Join-Path $directory ("broker-" + [string]$pending.brokerSha256 + ".ps1")
    if (-not [IO.File]::Exists($broker) -or (Get-FileSha256Hex -Path $broker) -cne [string]$pending.brokerSha256) {
        $temporary = "$broker.$([Guid]::NewGuid().ToString('N')).tmp"
        [IO.File]::Copy($source, $temporary, $false)
        try {
            if ((Get-FileSha256Hex -Path $temporary) -cne [string]$pending.brokerSha256) { throw [Security.Cryptography.CryptographicException]::new("The copied app update broker hash does not match.") }
            if ([IO.File]::Exists($broker)) {
                $brokerBackup = "$broker.$PID.bak"
                try { [IO.File]::Replace($temporary, $broker, $brokerBackup, $true) } finally { if ([IO.File]::Exists($brokerBackup)) { [IO.File]::Delete($brokerBackup) } }
            } else { [IO.File]::Move($temporary, $broker) }
        } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    }
    if ($ValidateOnly) { return 0 }
    # The broker performs the same full signed-tree hash pass as the live
    # handoff. A fixed one-minute wait killed healthy work on slow disks or
    # while antivirus scanned a large staged package, causing every restart to
    # repeat the same failure. Use the already validated size/file-count budget
    # so both apply entry points share one bounded liveness contract.
    $brokerTimeoutSeconds = Get-AppUpdateApplyTimeoutSeconds -Pending $pending
    $powershell = Join-Path $PSHOME "powershell.exe"; if (-not [IO.File]::Exists($powershell)) { $powershell = "powershell.exe" }
    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $broker,
        "-PlanPath", $pendingPath, "-ExpectedPackageRoot", $expectedPackageRoot, "-StateDirectory", $StateDirectory, "-Port", [string]$Port
    )
    if ($env:TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE -ceq "1") { $arguments += "-SkipRunOnce" }
    if ($env:TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH -ceq "1") { $arguments += "-TestFailHealth" }
    if ($env:TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE -in @("PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED", "ROLLING_BACK", "ROLLED_BACK")) {
        $arguments += @("-TestCrashAfterPhase", [string]$env:TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TARKOV_HELPER_UPDATE_TEST_APPLY_VERIFY_DELAY_MS)) {
        $applyVerifyDelay = 0
        if (
            -not [int]::TryParse([string]$env:TARKOV_HELPER_UPDATE_TEST_APPLY_VERIFY_DELAY_MS, [ref]$applyVerifyDelay) -or
            $applyVerifyDelay -lt 0 -or
            $applyVerifyDelay -gt 120000
        ) {
            throw [ArgumentOutOfRangeException]::new("TARKOV_HELPER_UPDATE_TEST_APPLY_VERIFY_DELAY_MS")
        }
        $arguments += @("-TestApplyVerifyDelayMilliseconds", [string]$applyVerifyDelay)
    }
    $argumentLine = ($arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join " "
    # Explorer may start this launcher with the package directory as the process
    # working directory. Windows will not rename a directory while any live
    # process uses it as its current directory, so move both this waiting launcher
    # process and the external update broker onto the persistent state directory
    # before swapping the package tree.
    [IO.Directory]::SetCurrentDirectory([IO.Path]::GetFullPath($StateDirectory))
    # Windows PowerShell 5.1 loses Process.ExitCode when Start-Process owns
    # redirected output handles. The broker writes durable status/journal state,
    # so keep the hidden process unredirected and retain a reliable exit code.
    $process = Start-Process -FilePath $powershell -ArgumentList $argumentLine -WorkingDirectory $StateDirectory -WindowStyle Hidden -PassThru
    # Windows PowerShell's Start-Process -Wait follows the entire descendant tree.
    # A successful broker intentionally leaves the replacement server running, so
    # wait on the broker Process object itself instead of its long-lived child.
    $deadline = [DateTime]::UtcNow.AddSeconds($brokerTimeoutSeconds)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $process.Refresh()
    }
    if (-not $process.HasExited) {
        try { $process.Kill(); $null = $process.WaitForExit(5000) } catch { }
        [Console]::Error.WriteLine("The staged update broker did not finish within the safety timeout.")
        Write-PortableLog "App update broker exceeded its bounded package-verification safety timeout."
        return 2
    }
    $process.WaitForExit()
    $process.Refresh()
    Write-PortableLog "App update broker exited with code $($process.ExitCode)."
    $instance = Read-PortableInstance
    if ($null -ne $instance -and (Test-PortableInstance -Instance $instance)) {
        $url = "http://127.0.0.1:$($instance.port)/"
        [Console]::Out.WriteLine("TARKOV_HELPER_URL=$url")
        Open-PortableBrowser -Url $url
    }
    if ($process.ExitCode -eq 0) { return 0 }
    [Console]::Error.WriteLine("The staged update could not be applied; the previous version was restored when possible.")
    return 2
}

function Test-PendingAppUpdateCommittedCleanupRecovery {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    if ($DisablePackageUpdates) { return $false }

    try {
        $pendingPath = Get-AppUpdatePendingPath
        if (-not [IO.File]::Exists($pendingPath)) { return $false }
        $pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
        if (
            -not (Test-AppUpdateObjectShape $pending @("schemaVersion", "state", "candidateId", "packageRoot", "stageRoot", "stateDirectory", "port", "currentVersion", "currentCommit", "latestVersion", "latestCommit", "treeSha256", "fileCount", "unpackedBytes", "brokerSha256", "healthNonce", "stagedAt")) -or
            $pending.schemaVersion -ne 1 -or $pending.state -cne "READY_TO_RESTART" -or
            -not (Test-AppUpdateVersion $pending.currentVersion) -or -not (Test-AppUpdateVersion $pending.latestVersion) -or
            (Compare-AppUpdateVersion -Left ([string]$pending.currentVersion) -Right ([string]$pending.latestVersion)) -ge 0
        ) { return $false }
        $context = Get-AppUpdateContext -AppRoot $AppRoot
        $status = Get-AppUpdateStatus -Context $context
        if (
            -not $context.Enabled -or
            $context.CurrentVersion -cne [string]$pending.latestVersion -or $context.CurrentCommit -cne [string]$pending.latestCommit -or
            $status.state -cne "UPDATED" -or $status.currentVersion -cne [string]$pending.latestVersion -or
            $status.previousVersion -cne [string]$pending.currentVersion
        ) { return $false }
        $expectedPackageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $parent = Split-Path -Parent $expectedPackageRoot
        $leaf = [IO.Path]::GetFileName($expectedPackageRoot)
        foreach ($path in @(
            [string]$pending.stageRoot,
            (Join-Path $parent ("." + $leaf + ".update-backup")),
            (Get-AppUpdateCandidatePath),
            (Join-Path (Get-AppUpdateDirectory) "apply-journal.json")
        )) {
            if (Test-LegacyAppUpdatePathOccupied -Path $path) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

function Complete-PendingAppUpdateCommittedCleanupRecovery {
    param(
        [Parameter(Mandatory = $true)][string]$AppRoot,
        [object]$ExpectedInstance = $null
    )

    if ($DisablePackageUpdates) { return $false }

    $transactionLock = $null
    $legacyMutex = $null
    $hasLegacyMutex = $false
    $workerLock = $null
    $portReservation = $null
    try {
        $transactionLock = Enter-AppUpdateTransactionLock
        $legacyMutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "UpdateApply"))
        try { $hasLegacyMutex = $legacyMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasLegacyMutex = $true }
        if (-not $hasLegacyMutex) { return $false }

        $updateDirectory = Get-AppUpdateDirectory
        $workerLockPath = Join-Path $updateDirectory "worker.lock"
        if ((Test-LegacyAppUpdatePathOccupied -Path $workerLockPath) -and -not (Test-LegacyAppUpdateRegularFile -Path $workerLockPath)) { return $false }
        try { $workerLock = [IO.FileStream]::new($workerLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { return $false }
        if (-not (Test-LegacyAppUpdateRegularFile -Path $workerLockPath) -or (Test-AppUpdateWorkerAlive)) { return $false }

        $pendingPath = Join-Path $updateDirectory "pending.json"
        if (-not (Test-LegacyAppUpdateRegularFile -Path $pendingPath)) { return $false }
        $pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
        if (
            -not (Test-AppUpdateObjectShape $pending @("schemaVersion", "state", "candidateId", "packageRoot", "stageRoot", "stateDirectory", "port", "currentVersion", "currentCommit", "latestVersion", "latestCommit", "treeSha256", "fileCount", "unpackedBytes", "brokerSha256", "healthNonce", "stagedAt")) -or
            $pending.schemaVersion -isnot [int] -or $pending.schemaVersion -ne 1 -or $pending.state -cne "READY_TO_RESTART" -or
            $pending.candidateId -isnot [string] -or $pending.candidateId -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
            $pending.packageRoot -isnot [string] -or $pending.stateDirectory -isnot [string] -or
            $pending.stageRoot -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$pending.stageRoot) -or
            $pending.port -isnot [int] -or $pending.port -lt 1 -or $pending.port -gt 65535 -or $pending.port -ne $Port -or
            -not (Test-AppUpdateVersion $pending.currentVersion) -or -not (Test-AppUpdateVersion $pending.latestVersion) -or
            (Compare-AppUpdateVersion -Left ([string]$pending.currentVersion) -Right ([string]$pending.latestVersion)) -ge 0 -or
            $pending.currentCommit -isnot [string] -or $pending.currentCommit -notmatch '^[0-9a-f]{40}$' -or
            $pending.latestCommit -isnot [string] -or $pending.latestCommit -notmatch '^[0-9a-f]{40}$' -or
            $pending.treeSha256 -isnot [string] -or $pending.treeSha256 -notmatch '^[0-9a-f]{64}$' -or
            $pending.fileCount -isnot [int] -or $pending.fileCount -lt 1 -or $pending.fileCount -gt 10000 -or
            (-not (($pending.unpackedBytes -is [int]) -or ($pending.unpackedBytes -is [long]))) -or
            [long]$pending.unpackedBytes -lt 1 -or [long]$pending.unpackedBytes -gt 1073741824 -or
            $pending.brokerSha256 -isnot [string] -or $pending.brokerSha256 -notmatch '^[0-9a-f]{64}$' -or
            $pending.healthNonce -isnot [string] -or $pending.healthNonce -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
            $pending.stagedAt -isnot [string]
        ) { return $false }

        $expectedPackageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $expectedStateRoot = [IO.Path]::GetFullPath($StateDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $expectedAppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if (
            -not ([string]$pending.packageRoot).Equals($expectedPackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$pending.stateDirectory).Equals($expectedStateRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not $expectedAppRoot.Equals((Join-Path $expectedPackageRoot "app"), [StringComparison]::OrdinalIgnoreCase)
        ) { return $false }
        if ($null -eq $ExpectedInstance) {
            if (Test-LegacyAppUpdatePathOccupied -Path (Get-InstancePath)) { return $false }
        }

        $packageInfo = [IO.DirectoryInfo]::new($expectedPackageRoot)
        $packageInfo.Refresh()
        if (-not $packageInfo.Exists -or ($packageInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $null -eq $packageInfo.Parent) { return $false }
        $packageInfo.Parent.Refresh()
        if (($packageInfo.Parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $parent = $packageInfo.Parent.FullName
        $leaf = $packageInfo.Name
        $stageRoot = [IO.Path]::GetFullPath([string]$pending.stageRoot)
        $stageNamePattern = "^\." + [Regex]::Escape($leaf) + "\.update-stage-[A-Za-z0-9_-]{40,64}$"
        if (
            -not (Split-Path -Parent $stageRoot).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($stageRoot) -notmatch $stageNamePattern
        ) { return $false }
        $backupRoot = Join-Path $parent ("." + $leaf + ".update-backup")
        $cleanupRoot = Join-Path $parent ("." + $leaf + ".update-cleanup-" + [string]$pending.candidateId)
        $failedRoot = Join-Path $parent ("." + $leaf + ".update-failed-" + [string]$pending.candidateId)
        foreach ($tree in @($stageRoot, $backupRoot, $failedRoot)) {
            if (Test-LegacyAppUpdatePathOccupied -Path $tree) { return $false }
        }
        $cleanupOccupied = Test-LegacyAppUpdatePathOccupied -Path $cleanupRoot
        if ($cleanupOccupied -and -not (Test-LegacyAppUpdateTreeBoundedNoReparse -RootPath $cleanupRoot -MaximumEntries 10000 -MaximumBytes 1073741824)) {
            return $false
        }

        $installedIdentity = Get-LegacyAppUpdatePackageIdentity -PackageRoot $expectedPackageRoot
        if (
            $null -eq $installedIdentity -or
            $installedIdentity.Version -cne [string]$pending.latestVersion -or
            $installedIdentity.Commit -cne [string]$pending.latestCommit
        ) { return $false }

        $journalPath = Join-Path $updateDirectory "apply-journal.json"
        $journalOccupied = Test-LegacyAppUpdatePathOccupied -Path $journalPath
        $journal = $null
        if ($journalOccupied) {
            if (-not (Test-LegacyAppUpdateRegularFile -Path $journalPath)) { return $false }
            $journal = Read-AppUpdateJson -Path $journalPath -MaximumBytes 65536
            if (
                -not (Test-AppUpdateObjectShape $journal @("schemaVersion", "candidateId", "phase", "packageRoot", "stageRoot", "backupRoot", "failedRoot", "currentVersion", "latestVersion", "port", "serverPid", "serverProcessStartTimeUtc", "updatedAt")) -or
                $journal.schemaVersion -isnot [int] -or $journal.schemaVersion -ne 1 -or $journal.candidateId -cne $pending.candidateId -or $journal.phase -cne "COMMITTED" -or
                -not ([string]$journal.packageRoot).Equals($expectedPackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
                -not ([string]$journal.stageRoot).Equals($stageRoot, [StringComparison]::OrdinalIgnoreCase) -or
                -not ([string]$journal.backupRoot).Equals($backupRoot, [StringComparison]::OrdinalIgnoreCase) -or
                -not ([string]$journal.failedRoot).Equals($failedRoot, [StringComparison]::OrdinalIgnoreCase) -or
                $journal.currentVersion -cne $pending.currentVersion -or $journal.latestVersion -cne $pending.latestVersion -or
                $journal.port -isnot [int] -or $journal.port -ne $pending.port -or $journal.serverPid -isnot [int] -or $journal.serverPid -lt 0 -or
                $journal.serverProcessStartTimeUtc -isnot [string] -or
                -not (($journal.serverPid -eq 0 -and $journal.serverProcessStartTimeUtc.Length -eq 0) -or ($journal.serverPid -gt 0 -and $journal.serverProcessStartTimeUtc -match '^\d{4}-\d{2}-\d{2}T')) -or
                $journal.updatedAt -isnot [string]
            ) { return $false }
        } else {
            if ($cleanupOccupied) { return $false }
            $statusPath = Get-AppUpdateStatusPath
            if (-not (Test-LegacyAppUpdateRegularFile -Path $statusPath)) { return $false }
            $status = Read-AppUpdateJson -Path $statusPath -MaximumBytes 65536
            if (
                -not (Test-AppUpdateObjectShape $status @("state", "currentVersion", "previousVersion", "updatedAt")) -or
                $status.state -cne "UPDATED" -or $status.currentVersion -cne $pending.latestVersion -or
                $status.previousVersion -cne $pending.currentVersion -or $status.updatedAt -isnot [string] -or
                $status.updatedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
            ) { return $false }
        }

        $expectedBuildIdentity = Get-AppBuildIdentity -AppRoot $expectedAppRoot
        $instance = $null
        if ($null -ne $ExpectedInstance) {
            $instance = Read-PortableInstance
            if (
                -not (Test-AppUpdateObjectShape $instance @("protocolVersion", "pid", "processStartTimeUtc", "port", "controlToken", "buildIdentity", "rootPath", "updateNonce", "startedAt")) -or
                $instance.protocolVersion -ne 1 -or $instance.pid -isnot [int] -or $instance.pid -le 0 -or
                $instance.pid -ne $ExpectedInstance.pid -or $instance.processStartTimeUtc -cne $ExpectedInstance.processStartTimeUtc -or
                $instance.port -ne $pending.port -or $instance.controlToken -isnot [string] -or $instance.controlToken -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
                $instance.buildIdentity -cne $expectedBuildIdentity -or
                -not ([string]$instance.rootPath).Equals($expectedAppRoot, [StringComparison]::OrdinalIgnoreCase) -or
                $instance.updateNonce -cne $pending.healthNonce -or $instance.startedAt -isnot [string] -or
                ($journalOccupied -and ($journal.serverPid -ne $instance.pid -or $journal.serverProcessStartTimeUtc -cne $instance.processStartTimeUtc)) -or
                -not (Test-PortableInstance -Instance $instance)
            ) { return $false }
        }

        if (-not (Test-AppUpdateTreeDigest -RootPath $expectedPackageRoot -ExpectedFileCount ([int]$pending.fileCount) -ExpectedBytes ([long]$pending.unpackedBytes) -ExpectedSha256 ([string]$pending.treeSha256))) { return $false }
        if ($null -ne $ExpectedInstance) {
            $instanceAfterVerification = Read-PortableInstance
            if (
                $null -eq $instanceAfterVerification -or
                $instanceAfterVerification.pid -ne $instance.pid -or
                $instanceAfterVerification.processStartTimeUtc -cne $instance.processStartTimeUtc -or
                -not (Test-PortableInstance -Instance $instanceAfterVerification)
            ) { return $false }
        } elseif (Test-LegacyAppUpdatePathOccupied -Path (Get-InstancePath)) {
            return $false
        }

        if ($null -eq $ExpectedInstance -and $journalOccupied -and $journal.serverPid -gt 0) {
            # A terminal broker may have durably recorded its replacement child
            # before instance.json was published. The reserved loopback port
            # proves that no server is reachable, but metadata cannot be retired
            # while that exact PID/start identity may still mutate state. Stop
            # only the recorded child, wait for a bounded exit, and fail closed
            # on every inspection or termination error.
            $terminalChild = $null
            try {
                if ($env:TARKOV_HELPER_UPDATE_TEST_TERMINAL_CHILD_INSPECTION_FAILURE -ceq "1") {
                    throw [UnauthorizedAccessException]::new("Injected terminal child inspection failure.")
                }
                try {
                    $terminalChild = [Diagnostics.Process]::GetProcessById([int]$journal.serverPid)
                } catch [ArgumentException] {
                    $terminalChild = $null
                }
                if ($null -ne $terminalChild -and -not $terminalChild.HasExited) {
                    $recordedStart = [DateTime]::Parse(
                        [string]$journal.serverProcessStartTimeUtc,
                        [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::RoundtripKind
                    ).ToUniversalTime()
                    $actualStart = $terminalChild.StartTime.ToUniversalTime()
                    if ([Math]::Abs(($actualStart - $recordedStart).TotalMilliseconds) -lt 1000) {
                        if ($env:TARKOV_HELPER_UPDATE_TEST_TERMINAL_CHILD_STOP_FAILURE -ceq "1") {
                            throw [UnauthorizedAccessException]::new("Injected terminal child stop failure.")
                        }
                        $terminalChild.Kill()
                        if (-not $terminalChild.WaitForExit(5000)) { return $false }
                        $terminalChild.Refresh()
                        if (-not $terminalChild.HasExited) { return $false }
                    }
                }
            } catch {
                return $false
            } finally {
                if ($null -ne $terminalChild) { try { $terminalChild.Dispose() } catch { } }
            }
        }

        if ($null -eq $ExpectedInstance) {
            # Recheck instance.json after any exact journal child exit, then
            # reserve the port and hold it through cleanup. Reserving before the
            # exact-child proof would make a live COMMITTED child impossible to
            # retire after its instance record was lost.
            if (Test-LegacyAppUpdatePathOccupied -Path (Get-InstancePath)) { return $false }
            $portReservation = Enter-AppUpdateLoopbackPortReservation -PendingPort ([int]$pending.port)
            if ($null -eq $portReservation) { return $false }
        }

        if ($cleanupOccupied) {
            $cleanupDeleteFailuresRemaining = 0
            if (
                -not [int]::TryParse([string]$env:TARKOV_HELPER_UPDATE_TEST_TERMINAL_CLEANUP_DELETE_FAILURES, [ref]$cleanupDeleteFailuresRemaining) -or
                $cleanupDeleteFailuresRemaining -lt 0
            ) { $cleanupDeleteFailuresRemaining = 0 }
            $cleanupDeleted = $false
            for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
                try {
                    # Revalidate the complete exact sibling on every attempt;
                    # locks and antivirus races must never turn retry into an
                    # unbounded or reparse-following recursive delete.
                    if (-not (Test-LegacyAppUpdateTreeBoundedNoReparse -RootPath $cleanupRoot -MaximumEntries 10000 -MaximumBytes 1073741824)) {
                        return $false
                    }
                    if ($cleanupDeleteFailuresRemaining -gt 0) {
                        $cleanupDeleteFailuresRemaining -= 1
                        throw [IO.IOException]::new("Injected transient terminal cleanup failure.")
                    }
                    Remove-LegacyAppUpdateTreeNoReparse -RootPath $cleanupRoot -MaximumEntries 10000 -MaximumBytes 1073741824
                    if (Test-LegacyAppUpdatePathOccupied -Path $cleanupRoot) { throw [IO.IOException]::new("The terminal cleanup tree remains occupied.") }
                    $cleanupDeleted = $true
                    break
                } catch [IO.IOException] {
                    if ($attempt -lt 7) { Start-Sleep -Milliseconds ([Math]::Min(250, [int](25 * [Math]::Pow(2, $attempt)))) }
                } catch [UnauthorizedAccessException] {
                    if ($attempt -lt 7) { Start-Sleep -Milliseconds ([Math]::Min(250, [int](25 * [Math]::Pow(2, $attempt)))) }
                } catch {
                    return $false
                }
            }
            if (-not $cleanupDeleted -or (Test-LegacyAppUpdatePathOccupied -Path $cleanupRoot)) { return $false }
        }

        $candidatePath = Get-AppUpdateCandidatePath
        if (Test-LegacyAppUpdatePathOccupied -Path $candidatePath) {
            if (-not (Test-LegacyAppUpdateRegularFile -Path $candidatePath)) { return $false }
            [IO.File]::Delete($candidatePath)
        }
        if ($journalOccupied) { [IO.File]::Delete($journalPath) }
        try {
            $runOnceName = "TarkovHelperWebUpdate-" + ([string]$pending.candidateId).Substring(0, 12)
            Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name $runOnceName -Force -ErrorAction SilentlyContinue
        } catch { }
        [IO.File]::Delete($pendingPath)
        Write-PortableLog "Retired authenticated terminal app update state without executing the previous-version broker."
        return $true
    } catch {
        Write-PortableLog "Terminal app update cleanup recovery was refused or deferred: $($_.Exception.GetType().Name)"
        return $false
    } finally {
        if ($null -ne $portReservation) { try { $portReservation.Stop() } catch { } }
        if ($null -ne $workerLock) { try { $workerLock.Dispose() } catch { } }
        if ($hasLegacyMutex) { try { $legacyMutex.ReleaseMutex() } catch { } }
        if ($null -ne $legacyMutex) { try { $legacyMutex.Dispose() } catch { } }
        Exit-AppUpdateTransactionLock -Lock $transactionLock
    }
}

function Stop-AppUpdateHandoffProcess {
    param([object]$Handoff)

    if ($null -eq $Handoff -or $null -eq $Handoff.Process) { return }
    $process = [Diagnostics.Process]$Handoff.Process
    $processId = [int]$Handoff.ProcessId
    $processStartTimeUtc = [string]$Handoff.ProcessStartTimeUtc
    $isExactProcessRunning = {
        $current = $null
        try {
            $current = [Diagnostics.Process]::GetProcessById($processId)
        } catch [ArgumentException] {
            # GetProcessById proves that the exact PID no longer exists.
            return $false
        } catch {
            # An access or inspection failure is not proof of exit.
            return $true
        }
        try {
            if ($current.HasExited) { return $false }
            $currentStart = $current.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
            return $currentStart -ceq $processStartTimeUtc
        } catch {
            # Metadata failure is likewise not proof of exit. Keep the old
            # request blocked until exact helper termination is established.
            return $true
        } finally {
            if ($null -ne $current) { $current.Dispose() }
        }
    }
    if (-not (& $isExactProcessRunning)) { return }

    try {
        Write-AppUpdateJson -Path ([string]$Handoff.CancelPath) -Value $Handoff.CancelValue
    } catch {
        Write-PortableLog "The live update cancellation marker could not be written; exact helper termination is required."
    }

    $cooperativeDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ((& $isExactProcessRunning) -and [DateTime]::UtcNow -lt $cooperativeDeadline) {
        Start-Sleep -Milliseconds 100
    }
    if ((& $isExactProcessRunning) -and $env:TARKOV_HELPER_UPDATE_TEST_FAIL_HANDOFF_KILL -cne "1") {
        try {
            $process.Kill()
        } catch {
            Write-PortableLog "The live update handoff helper rejected forced termination; waiting for exact exit."
        }
    }

    # Never resume the old request loop while the exact acknowledged helper is
    # still alive. It could otherwise observe a later tab-close/Stop and apply a
    # request whose response was reported as failed.
    while (& $isExactProcessRunning) {
        Start-Sleep -Milliseconds 100
    }
    if ([IO.File]::Exists([string]$Handoff.CancelPath)) {
        [IO.File]::Delete([string]$Handoff.CancelPath)
    }
}

function Get-AppUpdateHandoffAckTimeoutSeconds {
    param([object]$Pending)

    if (
        $Pending.fileCount -isnot [int] -or
        $Pending.fileCount -lt 1 -or
        $Pending.fileCount -gt 10000 -or
        (-not (($Pending.unpackedBytes -is [int]) -or ($Pending.unpackedBytes -is [long]))) -or
        [long]$Pending.unpackedBytes -lt 1 -or
        [long]$Pending.unpackedBytes -gt 1073741824
    ) {
        throw [IO.InvalidDataException]::new("The staged update verification budget is invalid.")
    }
    $sizeMiB = [Math]::Ceiling(([double][long]$Pending.unpackedBytes) / 1048576.0)
    $fileBatches = [Math]::Ceiling(([double][int]$Pending.fileCount) / 100.0)
    # Budget for a conservative 0.5 MiB/s hash pass plus 100 files/s metadata
    # overhead, bounded to 45 minutes for the worker's 1 GiB / 10,000-file caps.
    return [int][Math]::Min(2700.0, [Math]::Max(30.0, 30.0 + (2.0 * $sizeMiB) + $fileBatches))
}

function Get-AppUpdateApplyTimeoutSeconds {
    param([object]$Pending)

    $verificationSeconds = Get-AppUpdateHandoffAckTimeoutSeconds -Pending $Pending
    # A non-live apply verifies the staged tree, verifies the installed tree a
    # second time, starts and authenticates the replacement server, then removes
    # the rollback tree. Keep that whole durable transaction within the browser's
    # 90-minute reconnect window while leaving bounded room for AV/file cleanup.
    return [int][Math]::Min(5100.0, [Math]::Max(120.0, (2.0 * $verificationSeconds) + 300.0))
}

function Start-AppUpdateHandoff {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateId,
        [ValidateRange(1, 65535)][int]$BoundPort
    )

    if ($DisablePackageUpdates) { throw [InvalidOperationException]::new("Package updates are disabled in isolated recovery mode.") }
    if ((Invoke-PendingAppUpdate -ValidateOnly -ExpectedCandidate $CandidateId) -ne 0) {
        throw [IO.InvalidDataException]::new("The staged update could not be prepared for live handoff.")
    }
    $pendingPath = Get-AppUpdatePendingPath
    $pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
    $instance = Read-PortableInstance
    $expectedRootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $currentProcessStartTimeUtc = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    if (
        $null -eq $pending -or
        $pending.candidateId -cne $CandidateId -or
        $pending.port -ne $BoundPort -or
        $null -eq $instance -or
        $instance.pid -ne $PID -or
        $instance.processStartTimeUtc -cne $currentProcessStartTimeUtc -or
        $instance.port -ne $BoundPort -or
        $instance.buildIdentity -cne $buildIdentity -or
        -not ([string]$instance.rootPath).Equals($expectedRootPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-RecordedProcessIdentity -Instance $instance)
    ) {
        throw [Security.SecurityException]::new("The running server does not match the staged live update.")
    }
    $ackTimeoutSeconds = Get-AppUpdateHandoffAckTimeoutSeconds -Pending $pending

    $directory = Get-AppUpdateDirectory
    $broker = Join-Path $directory ("broker-" + [string]$pending.brokerSha256 + ".ps1")
    if (
        -not [IO.File]::Exists($broker) -or
        (Get-FileSha256Hex -Path $broker) -cne [string]$pending.brokerSha256
    ) {
        throw [Security.Cryptography.CryptographicException]::new("The trusted live update broker is unavailable.")
    }
    $handoffNonce = Get-RandomToken
    $ackPath = Join-Path $directory ("handoff-" + $handoffNonce + ".json")
    $cancelPath = Join-Path $directory ("handoff-" + $handoffNonce + ".cancel.json")
    if ([IO.File]::Exists($ackPath) -or [IO.File]::Exists($cancelPath)) {
        throw [IO.IOException]::new("The live update handoff path is already occupied.")
    }

    $powershell = Join-Path $PSHOME "powershell.exe"
    if (-not [IO.File]::Exists($powershell)) { $powershell = "powershell.exe" }
    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $broker,
        "-PlanPath", $pendingPath,
        "-ExpectedPackageRoot", [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar),
        "-StateDirectory", $StateDirectory,
        "-Port", [string]$BoundPort,
        "-WaitForProcessId", [string]$PID,
        "-WaitForProcessStartTimeUtc", [string]$instance.processStartTimeUtc,
        "-ExpectedOldBuildIdentity", $buildIdentity,
        "-ExpectedCandidate", $CandidateId,
        "-HandoffNonce", $handoffNonce,
        "-HandoffAckPath", $ackPath,
        "-HandoffCancelPath", $cancelPath
    )
    if ($env:TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE -ceq "1") { $arguments += "-SkipRunOnce" }
    if ($env:TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH -ceq "1") { $arguments += "-TestFailHealth" }
    if ($env:TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE -in @("PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED", "ROLLING_BACK", "ROLLED_BACK")) {
        $arguments += @("-TestCrashAfterPhase", [string]$env:TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TARKOV_HELPER_UPDATE_TEST_HANDOFF_VERIFY_DELAY_MS)) {
        $handoffVerifyDelay = 0
        if (
            -not [int]::TryParse([string]$env:TARKOV_HELPER_UPDATE_TEST_HANDOFF_VERIFY_DELAY_MS, [ref]$handoffVerifyDelay) -or
            $handoffVerifyDelay -lt 0 -or
            $handoffVerifyDelay -gt 120000
        ) {
            throw [ArgumentOutOfRangeException]::new("TARKOV_HELPER_UPDATE_TEST_HANDOFF_VERIFY_DELAY_MS")
        }
        $arguments += @("-TestHandoffVerifyDelayMilliseconds", [string]$handoffVerifyDelay)
    }
    $argumentLine = ($arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join " "
    $child = $null
    $handoff = $null
    try {
        if ($env:TARKOV_HELPER_UPDATE_TEST_FAIL_HANDOFF_START -ceq "1") {
            throw [InvalidOperationException]::new("Injected live update handoff start failure.")
        }
        $child = Start-Process -FilePath $powershell -ArgumentList $argumentLine -WorkingDirectory $StateDirectory -WindowStyle Hidden -PassThru
        $childStartTime = $child.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        $handoff = [pscustomobject]@{
            Process = $child
            ProcessId = $child.Id
            ProcessStartTimeUtc = $childStartTime
            CancelPath = $cancelPath
            CancelValue = [ordered]@{
                schemaVersion = 1
                state = "CANCEL"
                handoffNonce = $handoffNonce
                candidateId = $CandidateId
                packageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
                port = $BoundPort
                oldProcessId = $PID
                oldProcessStartTimeUtc = [string]$instance.processStartTimeUtc
                brokerPid = $child.Id
                brokerProcessStartTimeUtc = $childStartTime
            }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds($ackTimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            $child.Refresh()
            if ($child.HasExited) {
                throw [InvalidOperationException]::new("The live update handoff helper exited before acknowledgement.")
            }
            $ack = Read-AppUpdateJson -Path $ackPath -MaximumBytes 65536
            if ($null -ne $ack) {
                if (
                    -not (Test-AppUpdateObjectShape $ack @("schemaVersion", "state", "handoffNonce", "candidateId", "packageRoot", "port", "oldProcessId", "oldProcessStartTimeUtc", "oldBuildIdentity", "brokerPid", "brokerProcessStartTimeUtc")) -or
                    $ack.schemaVersion -ne 1 -or
                    $ack.state -cne "READY" -or
                    $ack.handoffNonce -cne $handoffNonce -or
                    $ack.candidateId -cne $CandidateId -or
                    -not ([string]$ack.packageRoot).Equals([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -or
                    $ack.port -ne $BoundPort -or
                    $ack.oldProcessId -ne $PID -or
                    $ack.oldProcessStartTimeUtc -cne [string]$instance.processStartTimeUtc -or
                    $ack.oldBuildIdentity -cne $buildIdentity -or
                    $ack.brokerPid -ne $child.Id -or
                    $ack.brokerProcessStartTimeUtc -cne $childStartTime
                ) {
                    throw [Security.SecurityException]::new("The live update handoff acknowledgement is invalid.")
                }
                return $handoff
            }
            Start-Sleep -Milliseconds 100
        }
        throw [TimeoutException]::new("The live update handoff helper did not acknowledge readiness.")
    } catch {
        if ($null -ne $handoff) {
            Stop-AppUpdateHandoffProcess -Handoff $handoff
        } elseif ($null -ne $child) {
            # Start-Process succeeded but the exact cancellation identity could
            # not be constructed. Do not return to the old request loop until
            # that Process object has definitely exited.
            try { $child.Kill() } catch { }
            $child.WaitForExit()
        }
        throw
    } finally {
        if ([IO.File]::Exists($ackPath)) {
            try {
                if ($env:TARKOV_HELPER_UPDATE_TEST_FAIL_HANDOFF_ACK_DELETE -ceq "1") {
                    throw [IO.IOException]::new("Injected live update acknowledgement cleanup failure.")
                }
                [IO.File]::Delete($ackPath)
            } catch {
                # The nonce-scoped ACK is neither an apply trigger nor reused.
                # Cleanup must not override a verified handoff return and leave
                # its already-running broker unowned by the caller.
                Write-PortableLog "A stale live update acknowledgement could not be removed."
            }
        }
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
            Write-PortableLog "Startup was refused because another startup owns the control mutex."
            return 2
        }

        $expectedRootPath = [IO.Path]::GetFullPath($Root)
        $expectedStateDirectory = Initialize-StateDirectory
        $expectedScreenshotFolder = ""
        if (-not [string]::IsNullOrWhiteSpace($ScreenshotFolder)) {
            $expectedScreenshotFolder = [IO.Path]::GetFullPath($ScreenshotFolder)
        }
        $expectedBuildIdentity = Get-AppBuildIdentity -AppRoot $expectedRootPath
        $instancePath = Get-InstancePath
        $stateExists = [IO.File]::Exists($instancePath)
        $existing = Read-PortableInstance
        if ($stateExists -and $null -eq $existing) {
            [Console]::Error.WriteLine("The Tarkov Helper instance state is invalid and was preserved; startup cannot continue safely.")
            Write-PortableLog "Startup was refused because instance state is invalid."
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
                Write-PortableLog "Startup was refused because the recorded running instance could not be authenticated."
                return 2
            }
            if ($DisablePackageUpdates) {
                # The v1 instance record authenticates the process and build but
                # does not attest whether its update API was disabled. Never
                # reuse an older or directly-started Serve process as read-only.
                [Console]::Error.WriteLine("A Tarkov Helper server is already running, but its read-only isolated recovery mode cannot be verified. Stop it before starting isolated recovery.")
                Write-PortableLog "Read-only recovery refused to reuse a server whose package-update mode was not attested."
                return 2
            }

            if (-not $DisablePackageUpdates) {
                $pendingRecoveryPath = Get-AppUpdatePendingPath
                $journalRecoveryPath = Join-Path (Get-AppUpdateDirectory) "apply-journal.json"
                if (
                    [IO.File]::Exists($pendingRecoveryPath) -and
                    ([IO.File]::Exists($journalRecoveryPath) -or (Test-PendingAppUpdateCommittedCleanupRecovery -AppRoot $expectedRootPath))
                ) {
                    $terminalCleanupRecovered = Complete-PendingAppUpdateCommittedCleanupRecovery -AppRoot $expectedRootPath -ExpectedInstance $existing
                    if (-not $terminalCleanupRecovered) {
                        $recoveryResult = Invoke-PendingAppUpdate
                        if ($null -ne $recoveryResult) { return [int]$recoveryResult }
                    }
                }
            }

            $existingRootPath = [string]($existing.rootPath)
            if (
                $existing.buildIdentity -cne $expectedBuildIdentity -or
                -not $existingRootPath.Equals($expectedRootPath, [StringComparison]::OrdinalIgnoreCase)
            ) {
                [Console]::Error.WriteLine("A different Tarkov Helper build is already running. Use Tarkov Helper Stop, then restart this build.")
                Write-PortableLog "Startup was refused because a different authenticated build is already running."
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

        if (-not $DisablePackageUpdates) {
            $pendingRecoveryPath = Get-AppUpdatePendingPath
            $journalRecoveryPath = Join-Path (Get-AppUpdateDirectory) "apply-journal.json"
            if (
                [IO.File]::Exists($pendingRecoveryPath) -and
                ([IO.File]::Exists($journalRecoveryPath) -or (Test-PendingAppUpdateCommittedCleanupRecovery -AppRoot $expectedRootPath))
            ) {
                $null = Complete-PendingAppUpdateCommittedCleanupRecovery -AppRoot $expectedRootPath
            }

            $updateResult = Invoke-PendingAppUpdate
            if ($null -ne $updateResult) { return [int]$updateResult }
            $null = Invoke-LegacyAppUpdateBackupCleanup -AppRoot $expectedRootPath
        }

        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not [IO.File]::Exists($powershellPath)) { $powershellPath = "powershell.exe" }
        $serveArguments = @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", $PSCommandPath,
            "-Action", "Serve",
            "-Root", $expectedRootPath,
            "-Port", [string]$Port,
            "-NoBrowser",
            "-StateDirectory", $expectedStateDirectory
        )
        if (-not [string]::IsNullOrWhiteSpace($expectedScreenshotFolder)) {
            $serveArguments += @("-ScreenshotFolder", $expectedScreenshotFolder)
        }
        if ($DisablePackageUpdates) {
            $serveArguments += "-DisablePackageUpdates"
        }
        $argumentLine = ($serveArguments | ForEach-Object { ConvertTo-ProcessArgument -Value ([string]$_) }) -join " "
        $child = Start-Process -FilePath $powershellPath -ArgumentList $argumentLine `
            -WorkingDirectory $expectedStateDirectory -WindowStyle Hidden -PassThru

        # Antivirus scans and first-run PowerShell/JIT startup can make a cold
        # launch exceed ten seconds even though the child is healthy. Keep the
        # readiness window bounded, but give the authenticated health probe
        # enough time to complete on slower machines.
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
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
        $childResult = if ($child.HasExited) { " Child exit code: $($child.ExitCode)." } else { " Readiness timed out." }
        Write-PortableLog "Background server startup failed.$childResult"
        return 2
    } catch {
        [Console]::Error.WriteLine("Tarkov Helper could not start.")
        Write-PortableLog "Background server startup failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
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
            Write-PortableLog "Shutdown was refused because another control operation is in progress."
            return 2
        }

        $instancePath = Get-InstancePath
        $stateExists = [IO.File]::Exists($instancePath)
        $instance = Read-PortableInstance
        if ($null -eq $instance) {
            if ($stateExists) {
                [Console]::Error.WriteLine("The Tarkov Helper instance state is invalid and was preserved; it cannot be authenticated safely.")
                Write-PortableLog "Shutdown was refused because instance state is invalid."
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
            Write-PortableLog "Authenticated shutdown timed out."
            return 2
        } catch {
            if (-not (Test-RecordedProcessIdentity -Instance $instance)) {
                Remove-OwnedInstance -ProcessId ([int]($instance.pid)) -ControlToken ([string]($instance.controlToken))
                return 0
            }
            [Console]::Error.WriteLine("The recorded Tarkov Helper instance could not be authenticated and was not terminated: $($_.Exception.Message)")
            Write-PortableLog "Authenticated shutdown failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
            return 2
        }
    } finally {
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Repair-PortableState {
    $mutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Control"))
    $hasMutex = $false
    $serveMutex = $null
    $hasServeMutex = $false
    $transactionLock = $null
    $legacyUpdateMutex = $null
    $hasLegacyUpdateMutex = $false
    $workerLock = $null
    $repairPortReservation = $null
    $repairTransactionLockDirectory = $false
    $transactionLockPath = $null
    $repairJournal = $false
    $repairPreparedTransaction = $false
    $journalIsDirectory = $false
    $journalPath = $null
    $journalQuarantinePath = $null
    try {
        try {
            $hasMutex = $mutex.WaitOne(15000)
        } catch [Threading.AbandonedMutexException] {
            $hasMutex = $true
        }
        if (-not $hasMutex) {
            [Console]::Error.WriteLine("Tarkov Helper startup or shutdown is already in progress; state repair was refused.")
            Write-PortableLog "State repair was refused because another control operation is in progress."
            return 2
        }

        $serveMutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Serve"))
        try { $hasServeMutex = $serveMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasServeMutex = $true }
        if (-not $hasServeMutex) {
            [Console]::Error.WriteLine("A Tarkov Helper server is still running; state repair was refused.")
            Write-PortableLog "State repair was refused because the serve mutex is owned."
            return 2
        }

        if ($Port -lt 1) {
            [Console]::Error.WriteLine("State repair requires the fixed local port used by this installation.")
            Write-PortableLog "State repair was refused because no fixed local port was supplied."
            return 2
        }
        try {
            $repairPortReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
            $repairPortReservation.Server.ExclusiveAddressUse = $true
            $repairPortReservation.Start()
        } catch {
            if ($null -ne $repairPortReservation) { try { $repairPortReservation.Stop() } catch { }; $repairPortReservation = $null }
            [Console]::Error.WriteLine("A server still owns the requested local port, or the port could not be reserved; state repair was refused.")
            Write-PortableLog "State repair refused all mutation because the requested loopback port could not be reserved exclusively."
            return 2
        }

        $stateRoot = [IO.Path]::GetFullPath((Initialize-StateDirectory))
        $transactionLockPath = Join-Path $stateRoot "app-update.transaction.lock"
        if (Test-LegacyAppUpdatePathOccupied -Path $transactionLockPath) {
            $lockAttributes = [IO.File]::GetAttributes($transactionLockPath)
            if (($lockAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                [Console]::Error.WriteLine("The update transaction lock path is a reparse point and cannot be repaired safely.")
                Write-PortableLog "Update state repair refused a transaction lock reparse point."
                return 2
            }
            $repairTransactionLockDirectory = ($lockAttributes -band [IO.FileAttributes]::Directory) -ne 0
        }
        if (-not $repairTransactionLockDirectory) {
            try { $transactionLock = Enter-AppUpdateTransactionLock }
            catch {
                [Console]::Error.WriteLine("Update state repair was refused because the transaction lock is busy or unsafe.")
                Write-PortableLog "Update state repair refused an unavailable transaction lock: $($_.Exception.GetType().Name)"
                return 2
            }
        }
        $legacyUpdateMutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "UpdateApply"))
        try { $hasLegacyUpdateMutex = $legacyUpdateMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasLegacyUpdateMutex = $true }
        if (-not $hasLegacyUpdateMutex) {
            [Console]::Error.WriteLine("An update apply process is still running; state repair was refused.")
            Write-PortableLog "Update state repair was refused because the legacy apply mutex is owned."
            return 2
        }

        $updateDirectory = Get-AppUpdateDirectory
        $workerLockPath = Join-Path $updateDirectory "worker.lock"
        try { $workerLock = [IO.FileStream]::new($workerLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] {
            [Console]::Error.WriteLine("An update worker is still running or its lock path is unsafe; state repair was refused.")
            Write-PortableLog "Update state repair was refused because worker.lock could not be acquired."
            return 2
        }
        if (Test-AppUpdateWorkerAlive) {
            [Console]::Error.WriteLine("An update worker is still running; state repair was refused.")
            Write-PortableLog "Update state repair was refused because a recorded worker is alive."
            return 2
        }

        $instancePath = Get-InstancePath
        $instanceOccupied = Test-LegacyAppUpdatePathOccupied -Path $instancePath
        $instanceIsDirectory = $false
        if ($instanceOccupied) {
            $instanceAttributes = [IO.File]::GetAttributes($instancePath)
            if (($instanceAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                [Console]::Error.WriteLine("The Tarkov Helper instance state is a reparse point and cannot be repaired safely.")
                Write-PortableLog "State repair refused an instance state reparse point."
                return 2
            }
            $instanceIsDirectory = ($instanceAttributes -band [IO.FileAttributes]::Directory) -ne 0

            $existing = Read-PortableInstance
            if ($null -ne $existing -and (Test-RecordedProcessIdentity -Instance $existing)) {
                [Console]::Error.WriteLine("A recorded Tarkov Helper process is still running. Use Tarkov Helper Stop before repairing state.")
                Write-PortableLog "State repair was refused because a recorded process is still running."
                return 2
            }
        }

        $pendingPath = Join-Path $updateDirectory "pending.json"
        $pendingOccupied = Test-LegacyAppUpdatePathOccupied -Path $pendingPath
        $repairPending = $false
        if ($pendingOccupied) {
            $pendingAttributes = [IO.File]::GetAttributes($pendingPath)
            if (($pendingAttributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) {
                [Console]::Error.WriteLine("The pending update state is not a regular file and was preserved; update repair was refused.")
                Write-PortableLog "Update state repair refused a nonregular or reparse pending path."
                return 2
            }
            $pendingInfo = [IO.FileInfo]::new($pendingPath)
            if ($pendingInfo.Length -lt 2 -or $pendingInfo.Length -gt 65536) {
                [Console]::Error.WriteLine("The pending update state cannot be safely attributed to this installation and was preserved.")
                Write-PortableLog "Update state repair refused an unbounded pending file."
                return 2
            }
            $pending = Read-AppUpdateJson -Path $pendingPath -MaximumBytes 65536
            $expectedPackageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
            $expectedStateRoot = [IO.Path]::GetFullPath((Initialize-StateDirectory)).TrimEnd([IO.Path]::DirectorySeparatorChar)
            if (
                $null -eq $pending -or
                $pending.packageRoot -isnot [string] -or
                $pending.stateDirectory -isnot [string] -or
                -not (Test-AppUpdateInteger -Value $pending.port -Minimum 1 -Maximum 65535) -or
                $pending.port -ne $Port -or
                [string]::IsNullOrWhiteSpace([string]$pending.packageRoot) -or
                [string]::IsNullOrWhiteSpace([string]$pending.stateDirectory)
            ) {
                [Console]::Error.WriteLine("The pending update state cannot be safely attributed to this installation and was preserved.")
                Write-PortableLog "Update state repair refused an unparseable or unbound pending file."
                return 2
            }
            try {
                $boundPackageRoot = [IO.Path]::GetFullPath([string]$pending.packageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
                $boundStateRoot = [IO.Path]::GetFullPath([string]$pending.stateDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
            } catch {
                [Console]::Error.WriteLine("The pending update state contains unsafe paths and was preserved.")
                Write-PortableLog "Update state repair refused invalid pending paths."
                return 2
            }
            if (
                -not $boundPackageRoot.Equals($expectedPackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
                -not $boundStateRoot.Equals($expectedStateRoot, [StringComparison]::OrdinalIgnoreCase)
            ) {
                [Console]::Error.WriteLine("The pending update belongs to another installation and was preserved.")
                Write-PortableLog "Update state repair refused pending state bound to another installation."
                return 2
            }
            $boundRootInfo = [IO.DirectoryInfo]::new($boundPackageRoot); $boundRootInfo.Refresh()
            if (-not $boundRootInfo.Exists -or ($boundRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $null -eq $boundRootInfo.Parent) {
                [Console]::Error.WriteLine("The package root recorded by the pending update is missing or unsafe; evidence was preserved.")
                Write-PortableLog "Update state repair refused a missing or unsafe bound package root."
                return 2
            }
            $boundRootInfo.Parent.Refresh()
            if (($boundRootInfo.Parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                [Console]::Error.WriteLine("The package parent recorded by the pending update is unsafe; evidence was preserved.")
                Write-PortableLog "Update state repair refused an unsafe bound package parent."
                return 2
            }
            $backupRoot = Join-Path $boundRootInfo.Parent.FullName ("." + $boundRootInfo.Name + ".update-backup")
            if (Test-LegacyAppUpdatePathOccupied -Path $backupRoot) {
                [Console]::Error.WriteLine("A rollback package still exists; the update may be mid-swap and all evidence was preserved.")
                Write-PortableLog "Update state repair refused to abandon pending state while a rollback package exists."
                return 2
            }
            if ($pending.candidateId -is [string] -and $pending.candidateId -match '^[A-Za-z0-9_-]{40,64}$') {
                $cleanupRoot = Join-Path $boundRootInfo.Parent.FullName ("." + $boundRootInfo.Name + ".update-cleanup-" + [string]$pending.candidateId)
                $failedRoot = Join-Path $boundRootInfo.Parent.FullName ("." + $boundRootInfo.Name + ".update-failed-" + [string]$pending.candidateId)
                foreach ($evidenceRoot in @($cleanupRoot, $failedRoot)) {
                    if (Test-LegacyAppUpdatePathOccupied -Path $evidenceRoot) {
                        [Console]::Error.WriteLine("Candidate-bound cleanup or failed package evidence still exists; update repair was refused and all evidence was preserved.")
                        Write-PortableLog "Update state repair preserved a candidate-bound cleanup or failed package tree."
                        return 2
                    }
                }
            }

            $pendingIsStrict = (
                (Test-AppUpdateObjectShape $pending @("schemaVersion", "state", "candidateId", "packageRoot", "stageRoot", "stateDirectory", "port", "currentVersion", "currentCommit", "latestVersion", "latestCommit", "treeSha256", "fileCount", "unpackedBytes", "brokerSha256", "healthNonce", "stagedAt")) -and
                $pending.schemaVersion -eq 1 -and $pending.state -ceq "READY_TO_RESTART" -and
                $pending.candidateId -is [string] -and $pending.candidateId -match '^[A-Za-z0-9_-]{40,64}$' -and
                $pending.stageRoot -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$pending.stageRoot) -and
                (Test-AppUpdateVersion $pending.currentVersion) -and (Test-AppUpdateVersion $pending.latestVersion) -and
                (Compare-AppUpdateVersion -Left ([string]$pending.currentVersion) -Right ([string]$pending.latestVersion)) -lt 0 -and
                $pending.currentCommit -is [string] -and $pending.currentCommit -match '^[0-9a-f]{40}$' -and
                $pending.latestCommit -is [string] -and $pending.latestCommit -match '^[0-9a-f]{40}$' -and
                $pending.treeSha256 -is [string] -and $pending.treeSha256 -match '^[0-9a-f]{64}$' -and
                $pending.fileCount -is [int] -and $pending.fileCount -ge 1 -and $pending.fileCount -le 10000 -and
                (($pending.unpackedBytes -is [int]) -or ($pending.unpackedBytes -is [long])) -and
                [long]$pending.unpackedBytes -ge 1 -and [long]$pending.unpackedBytes -le 1073741824 -and
                $pending.brokerSha256 -is [string] -and $pending.brokerSha256 -match '^[0-9a-f]{64}$' -and
                $pending.healthNonce -is [string] -and $pending.healthNonce -match '^[A-Za-z0-9_-]{40,64}$' -and
                $pending.stagedAt -is [string]
            )
            $stageRoot = $null
            if ($pendingIsStrict) {
                try {
                    $stageRoot = [IO.Path]::GetFullPath([string]$pending.stageRoot)
                    $stageNamePattern = "^\." + [Regex]::Escape($boundRootInfo.Name) + "\.update-stage-[A-Za-z0-9_-]{40,64}$"
                    $pendingIsStrict = (
                        (Split-Path -Parent $stageRoot).Equals($boundRootInfo.Parent.FullName, [StringComparison]::OrdinalIgnoreCase) -and
                        [IO.Path]::GetFileName($stageRoot) -match $stageNamePattern
                    )
                } catch { $pendingIsStrict = $false }
            }
            $stageOccupied = $false
            $stageIsSafeDirectory = $false
            $installedBrokerTrusted = $false
            if ($pendingIsStrict) {
                $stageOccupied = Test-LegacyAppUpdatePathOccupied -Path $stageRoot
                if ($stageOccupied) {
                    $stageAttributes = [IO.File]::GetAttributes($stageRoot)
                    $stageIsSafeDirectory = ($stageAttributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -eq [IO.FileAttributes]::Directory
                    if (-not $stageIsSafeDirectory) {
                        [Console]::Error.WriteLine("The staged update path is nonregular or a reparse point; all evidence was preserved.")
                        Write-PortableLog "Update state repair refused an unsafe occupied stage path."
                        return 2
                    }
                }
                $installedBrokerPath = Join-Path $boundPackageRoot "app-update-broker.ps1"
                if ((Test-LegacyAppUpdatePathOccupied -Path $installedBrokerPath) -and -not (Test-LegacyAppUpdateRegularFile -Path $installedBrokerPath)) {
                    [Console]::Error.WriteLine("The installed update broker path is nonregular or a reparse point; all evidence was preserved.")
                    Write-PortableLog "Update state repair refused an unsafe installed broker path."
                    return 2
                }
                if (Test-LegacyAppUpdateRegularFile -Path $installedBrokerPath) {
                    try { $installedBrokerTrusted = (Get-FileSha256Hex -Path $installedBrokerPath) -ceq [string]$pending.brokerSha256 } catch { $installedBrokerTrusted = $false }
                }
            }
            $rootIdentity = Read-AppUpdateJson -Path (Join-Path $boundPackageRoot "app\version.json") -MaximumBytes 8192
            $rootIdentityIsStrict = (
                (Test-AppUpdateObjectShape $rootIdentity @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion")) -and
                $rootIdentity.schemaVersion -eq 1 -and $rootIdentity.product -ceq "tarkov-helper-web" -and
                (Test-AppUpdateVersion $rootIdentity.version) -and $rootIdentity.commit -is [string] -and
                $rootIdentity.commit -match '^[0-9a-f]{40}$' -and $rootIdentity.updaterProtocolVersion -eq 1
            )
            $rootIsCurrent = $rootIdentityIsStrict -and $rootIdentity.version -ceq $pending.currentVersion -and $rootIdentity.commit -ceq $pending.currentCommit
            $rootIsLatest = $rootIdentityIsStrict -and $rootIdentity.version -ceq $pending.latestVersion -and $rootIdentity.commit -ceq $pending.latestCommit
            $authenticatedRootIdentity = Get-LegacyAppUpdatePackageIdentity -PackageRoot $boundPackageRoot
            $rootIsAuthenticatedCurrent = (
                $rootIsCurrent -and $null -ne $authenticatedRootIdentity -and
                $authenticatedRootIdentity.Version -ceq $pending.currentVersion -and
                $authenticatedRootIdentity.Commit -ceq $pending.currentCommit
            )
            $pendingIsRecoverable = $pendingIsStrict -and $installedBrokerTrusted -and (($rootIsCurrent -and $stageIsSafeDirectory) -or ($rootIsLatest -and -not $stageOccupied))

            $journalPath = Join-Path $updateDirectory "apply-journal.json"
            if (Test-LegacyAppUpdatePathOccupied -Path $journalPath) {
                $journalAttributes = [IO.File]::GetAttributes($journalPath)
                if (($journalAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    [Console]::Error.WriteLine("The apply journal is a reparse point and was preserved; update repair was refused.")
                    Write-PortableLog "Update state repair refused an apply journal reparse point."
                    return 2
                }
                if (-not $pendingIsStrict) {
                    [Console]::Error.WriteLine("An apply journal still exists; the update may be recoverable and all evidence was preserved.")
                    Write-PortableLog "Update state repair refused to abandon invalid pending state while an apply journal exists."
                    return 2
                }
                $journalIsDirectory = ($journalAttributes -band [IO.FileAttributes]::Directory) -ne 0
                $journal = if ($journalIsDirectory) { $null } else { Read-AppUpdateJson -Path $journalPath -MaximumBytes 65536 }
                $failedRoot = Join-Path $boundRootInfo.Parent.FullName ("." + $boundRootInfo.Name + ".update-failed-" + [string]$pending.candidateId)
                $journalIsStrict = (
                    -not $journalIsDirectory -and
                    (Test-AppUpdateObjectShape $journal @("schemaVersion", "candidateId", "phase", "packageRoot", "stageRoot", "backupRoot", "failedRoot", "currentVersion", "latestVersion", "port", "serverPid", "serverProcessStartTimeUtc", "updatedAt")) -and
                    $journal.schemaVersion -eq 1 -and $journal.candidateId -ceq $pending.candidateId -and
                    $journal.phase -is [string] -and $journal.phase -in @("PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED", "ROLLING_BACK", "ROLLED_BACK") -and
                    ([string]$journal.packageRoot).Equals($boundPackageRoot, [StringComparison]::OrdinalIgnoreCase) -and
                    ([string]$journal.stageRoot).Equals($stageRoot, [StringComparison]::OrdinalIgnoreCase) -and
                    ([string]$journal.backupRoot).Equals([IO.Path]::GetFullPath($backupRoot), [StringComparison]::OrdinalIgnoreCase) -and
                    ([string]$journal.failedRoot).Equals([IO.Path]::GetFullPath($failedRoot), [StringComparison]::OrdinalIgnoreCase) -and
                    $journal.currentVersion -ceq $pending.currentVersion -and $journal.latestVersion -ceq $pending.latestVersion -and
                    $journal.port -eq $pending.port -and $journal.serverPid -is [int] -and $journal.serverPid -ge 0 -and
                    $journal.serverProcessStartTimeUtc -is [string] -and
                    (($journal.serverPid -eq 0 -and $journal.serverProcessStartTimeUtc.Length -eq 0) -or ($journal.serverPid -gt 0 -and $journal.serverProcessStartTimeUtc -match '^\d{4}-\d{2}-\d{2}T')) -and
                    $journal.updatedAt -is [string]
                )
                if ($journalIsStrict) {
                    $repairPreparedTransaction = (
                        $journal.phase -ceq "PREPARED" -and
                        $rootIsAuthenticatedCurrent -and
                        $stageIsSafeDirectory -and
                        -not $installedBrokerTrusted -and
                        -not (Test-LegacyAppUpdatePathOccupied -Path $failedRoot)
                    )
                    if ($repairPreparedTransaction) {
                        # PREPARED is the only durable phase before either
                        # package root has moved. If the authenticated current
                        # package can no longer supply the hash-pinned broker,
                        # neither the journal nor the pending trigger can make
                        # progress. Explicit Repair may abandon this exact
                        # pre-swap pair while leaving the verified stage and all
                        # other evidence untouched.
                        $repairJournal = $true
                    } else {
                        [Console]::Error.WriteLine("A valid apply journal still exists; the update remains recoverable or may be mid-swap and was preserved.")
                        Write-PortableLog "Update state repair preserved a valid apply journal outside the provably pre-swap unrecoverable case."
                        return 2
                    }
                }

                if (-not $journalIsStrict -and ((Test-LegacyAppUpdatePathOccupied -Path $failedRoot) -or -not $pendingIsRecoverable)) {
                    [Console]::Error.WriteLine("The package topology does not prove that the corrupt apply journal can be reconstructed; evidence was preserved.")
                    Write-PortableLog "Update state repair refused corrupt journal quarantine because package topology was ambiguous."
                    return 2
                }
                if (-not $journalIsStrict) { $repairJournal = $true }
            }

            if ($pendingIsRecoverable -and -not $repairJournal -and -not $repairTransactionLockDirectory) {
                [Console]::Error.WriteLine("The pending update may still be valid or recoverable and was preserved.")
                Write-PortableLog "Update state repair refused to abandon a strict pending transaction."
                return 2
            }
            $repairPending = $repairPreparedTransaction -or (-not $pendingIsRecoverable -and -not $repairJournal)
        }

        if (-not $instanceOccupied -and -not $repairPending -and -not $repairJournal -and -not $repairTransactionLockDirectory) {
            [Console]::Out.WriteLine("No Tarkov Helper instance or update state needs repair.")
            return 0
        }

        $timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss", [Globalization.CultureInfo]::InvariantCulture)
        if ($repairTransactionLockDirectory) {
            $lockQuarantineName = "app-update.transaction-lock-corrupt-$timestamp-$([Guid]::NewGuid().ToString('N')).directory"
            $lockQuarantinePath = Join-Path $stateRoot $lockQuarantineName
            [IO.Directory]::Move($transactionLockPath, $lockQuarantinePath)
            Write-PortableLog "A directory occupying the update transaction lock path was quarantined by an explicit repair request."
            try { $transactionLock = Enter-AppUpdateTransactionLock }
            catch {
                [Console]::Error.WriteLine("The damaged update lock was quarantined, but another update transaction started; remaining state was preserved.")
                Write-PortableLog "Update state repair stopped after lock-path quarantine because the transaction lock became busy."
                return 2
            }
        }
        if ($repairJournal) {
            $journalQuarantineExtension = if ($journalIsDirectory) { ".directory" } else { ".json" }
            $journalQuarantinePrefix = if ($repairPreparedTransaction) { "app-update.apply-journal-abandoned-prepared" } else { "app-update.apply-journal-corrupt" }
            $journalQuarantineName = "$journalQuarantinePrefix-$timestamp-$([Guid]::NewGuid().ToString('N'))$journalQuarantineExtension"
            $journalQuarantinePath = Join-Path $stateRoot $journalQuarantineName
            if ($journalIsDirectory) { [IO.Directory]::Move($journalPath, $journalQuarantinePath) }
            else { [IO.File]::Move($journalPath, $journalQuarantinePath) }
            if ($repairPreparedTransaction) { Write-PortableLog "An unrecoverable authenticated PREPARED journal was quarantined before its pending trigger." }
            else { Write-PortableLog "A corrupt apply journal was quarantined while its strict pending plan was preserved." }
        }
        if ($repairPending) {
            # Leave stage, candidate, status, and logs untouched as recovery
            # evidence. When both repairs are requested, retire the update
            # trigger before instance.json so a failed pending move can never
            # erase the only surviving server identity.
            $pendingQuarantinePrefix = if ($repairPreparedTransaction) { "app-update.pending-abandoned-prepared" } else { "app-update.pending-corrupt" }
            $pendingQuarantineName = "$pendingQuarantinePrefix-$timestamp-$([Guid]::NewGuid().ToString('N')).json"
            $pendingQuarantinePath = Join-Path (Initialize-StateDirectory) $pendingQuarantineName
            try {
                if ($env:TARKOV_HELPER_UPDATE_TEST_FAIL_REPAIR_PENDING_MOVE -ceq "1") {
                    throw [IO.IOException]::new("Injected pending repair quarantine failure.")
                }
                [IO.File]::Move($pendingPath, $pendingQuarantinePath)
            } catch {
                # For paired PREPARED abandonment, pending.json is the update
                # trigger and therefore moves last. If that atomic move fails,
                # restore the already-moved journal so the original transaction
                # identity and all evidence remain together for a later retry.
                if (
                    $repairPreparedTransaction -and
                    $null -ne $journalQuarantinePath -and
                    (Test-LegacyAppUpdateRegularFile -Path $journalQuarantinePath) -and
                    -not (Test-LegacyAppUpdatePathOccupied -Path $journalPath)
                ) {
                    try {
                        [IO.File]::Move($journalQuarantinePath, $journalPath)
                        Write-PortableLog "PREPARED transaction repair restored its journal after pending quarantine failed."
                    } catch {
                        Write-PortableLog "PREPARED transaction repair could not restore its journal after pending quarantine failed."
                        throw [IO.IOException]::new("The pending trigger and apply journal could not be kept together during repair.")
                    }
                }
                throw
            }
            if ($repairPreparedTransaction) { Write-PortableLog "The pending trigger for an unrecoverable authenticated PREPARED transaction was quarantined last." }
            else { Write-PortableLog "A bound invalid pending update was quarantined by an explicit repair request." }
        }
        if ($instanceOccupied) {
            $quarantineExtension = if ($instanceIsDirectory) { ".directory" } else { ".json" }
            $quarantineName = "instance.corrupt-$timestamp-$([Guid]::NewGuid().ToString('N'))$quarantineExtension"
            $quarantinePath = Join-Path (Initialize-StateDirectory) $quarantineName
            if ($instanceIsDirectory) {
                [IO.Directory]::Move($instancePath, $quarantinePath)
            } else {
                [IO.File]::Move($instancePath, $quarantinePath)
            }
            Write-PortableLog "Unusable instance state was quarantined by an explicit repair request."
        }
        if ($instanceOccupied -and ($repairPending -or $repairJournal -or $repairTransactionLockDirectory)) { [Console]::Out.WriteLine("The unusable instance and update state were quarantined for recovery. Start Tarkov Helper again.") }
        elseif ($instanceOccupied) { [Console]::Out.WriteLine("The unusable instance state was quarantined for recovery. Start Tarkov Helper again.") }
        elseif ($repairPreparedTransaction) { [Console]::Out.WriteLine("The unrecoverable PREPARED update transaction was quarantined before any package swap. Start Tarkov Helper again.") }
        elseif ($repairJournal) { [Console]::Out.WriteLine("The corrupt apply journal was quarantined; the staged update remains ready for recovery. Start Tarkov Helper again.") }
        elseif ($repairTransactionLockDirectory -and -not $repairPending) { [Console]::Out.WriteLine("The unusable update transaction lock was quarantined for recovery. Start Tarkov Helper again.") }
        else { [Console]::Out.WriteLine("The unusable update state was quarantined for recovery. Start Tarkov Helper again.") }
        return 0
    } catch {
        [Console]::Error.WriteLine("Tarkov Helper instance state could not be repaired safely.")
        Write-PortableLog "State repair failed: $($_.Exception.GetType().Name)"
        return 2
    } finally {
        if ($null -ne $repairPortReservation) { try { $repairPortReservation.Stop() } catch { } }
        if ($null -ne $workerLock) { try { $workerLock.Dispose() } catch { } }
        if ($hasLegacyUpdateMutex) { try { $legacyUpdateMutex.ReleaseMutex() } catch { } }
        if ($null -ne $legacyUpdateMutex) { try { $legacyUpdateMutex.Dispose() } catch { } }
        Exit-AppUpdateTransactionLock -Lock $transactionLock
        if ($hasServeMutex) { try { $serveMutex.ReleaseMutex() } catch { } }
        if ($null -ne $serveMutex) { try { $serveMutex.Dispose() } catch { } }
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
if ($Action -eq "Repair") {
    if ($DisablePackageUpdates) {
        [Console]::Error.WriteLine("State repair is not available in read-only isolated recovery mode.")
        exit 2
    }
    exit (Repair-PortableState)
}

$serverCompletedNormally = $false
try {
    $rootPath = [IO.Path]::GetFullPath($Root)
    $Root = $rootPath
    if (-not [string]::IsNullOrWhiteSpace($ScreenshotFolder)) {
        $ScreenshotFolder = [IO.Path]::GetFullPath($ScreenshotFolder)
    }
} catch {
    [Console]::Error.WriteLine("Invalid app or screenshot directory.")
    Write-PortableLog "Server startup rejected an invalid app or screenshot directory: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    exit 2
}

$indexPath = Join-Path $rootPath "index.html"
if (-not [IO.File]::Exists($indexPath)) {
    [Console]::Error.WriteLine("The app directory must contain index.html: $rootPath")
    Write-PortableLog "Server startup failed because app/index.html is missing from '$rootPath'."
    exit 2
}

try {
    # Direct diagnostic Serve can be launched while Explorer's current
    # directory is the portable package. Move this long-lived process onto
    # persistent state before it can participate in a live directory swap.
    $serveWorkingDirectory = Initialize-StateDirectory
    $StateDirectory = [IO.Path]::GetFullPath($serveWorkingDirectory)
    [IO.Directory]::SetCurrentDirectory([IO.Path]::GetFullPath($serveWorkingDirectory))
} catch {
    [Console]::Error.WriteLine("The local runtime directory could not be used as the server working directory.")
    Write-PortableLog "Server startup could not use the runtime working directory: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    exit 2
}

$serveMutex = $null
$hasServeMutex = $false
try {
    $buildIdentity = Get-AppBuildIdentity -AppRoot $rootPath
    $healthResponse = "tarkov-helper-web-portable-v1:$buildIdentity"
    $controlToken = Get-RandomToken
    $nativeOverlayToken = Get-RandomToken
    $appUpdateToken = Get-RandomToken
    $appUpdateContext = Get-AppUpdateContext -AppRoot $rootPath
    $serveMutex = [Threading.Mutex]::new($false, (Get-StateMutexName -Purpose "Serve"))
    try {
        $hasServeMutex = $serveMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $hasServeMutex = $true
    }
    if (-not $hasServeMutex) {
        $existing = Read-PortableInstance
        if (
            -not $DisablePackageUpdates -and
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
        Write-PortableLog "Server startup was refused because another server owns the runtime mutex."
        exit 2
    }
    $rootPrefix = $rootPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
} catch {
    Write-PortableLog "Server preflight failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    if ($hasServeMutex) { try { $serveMutex.ReleaseMutex() } catch { } }
    if ($null -ne $serveMutex) { try { $serveMutex.Dispose() } catch { } }
    throw
}

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
            if ($DisablePackageUpdates) { throw "Read-only isolated recovery cannot reuse a server whose package-update mode was not attested." }
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
            Write-PortableLog "Loopback listener startup failed: $reuseFailure"
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
            updateNonce = if ([string]::IsNullOrWhiteSpace($UpdateNonce)) { "" } else { $UpdateNonce }
            startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        })
        $ownsInstanceState = $true
        Write-PortableLog "Server started on loopback port $boundPort."
    } catch {
        [Console]::Error.WriteLine("The local runtime state could not be written.")
        Write-PortableLog "Runtime state initialization failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
        exit 2
    }

    Start-ScreenshotWatcher

    [Console]::Out.WriteLine("TARKOV_HELPER_URL=$url")
    [Console]::Out.WriteLine("Tarkov Helper is running locally.")
    [Console]::Out.WriteLine("Keep this window open. Press Ctrl+C to stop.")
    [Console]::Out.Flush()

    Open-PortableBrowser -Url $url

    while (-not $script:shutdownRequested -and ($MaxRequests -eq 0 -or $handledRequests -lt $MaxRequests)) {
        Complete-ModdingPreviewJob
        while (-not $script:shutdownRequested -and -not $listener.Pending()) {
            Complete-ModdingPreviewJob
            Update-ClientLeases
            if ([DateTime]::UtcNow -ge $script:trackerNextMapBootstrapUtc) {
                $script:trackerNextMapBootstrapUtc = [DateTime]::UtcNow.AddMilliseconds(
                    $trackerMapBootstrapIntervalMilliseconds
                )
                $null = @(Get-TrackerMapStateEvents -AdvanceBootstrap)
            }
            Update-ScreenshotWatcher
            Update-NativeOverlayBridge
            if (
                -not $DisablePackageUpdates -and
                -not $script:legacyAppUpdateCleanupFinished -and
                -not [string]::IsNullOrWhiteSpace($UpdateNonce) -and
                [DateTime]::UtcNow -ge $script:legacyAppUpdateCleanupDeadlineUtc
            ) {
                $script:legacyAppUpdateCleanupFinished = $true
            } elseif (
                -not $DisablePackageUpdates -and
                -not $script:legacyAppUpdateCleanupFinished -and
                -not [string]::IsNullOrWhiteSpace($UpdateNonce) -and
                [DateTime]::UtcNow -ge $script:legacyAppUpdateCleanupNextAttemptUtc
            ) {
                $script:legacyAppUpdateCleanupNextAttemptUtc = [DateTime]::UtcNow.AddSeconds(2)
                if ((Invoke-LegacyAppUpdateBackupCleanupFromServe -AppRoot $rootPath) -ceq "DONE") {
                    $script:legacyAppUpdateCleanupFinished = $true
                }
            }
            Start-Sleep -Milliseconds 100
        }
        if ($script:shutdownRequested) { break }
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
            $updateHeaders = @()
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
                if ($headerName.Equals("X-Tarkov-Update", [StringComparison]::OrdinalIgnoreCase)) {
                    $updateHeaders += $headerValue
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

            if ($requestPath -ceq "/api/modding/preview") {
                if ($method -cne "POST") {
                    Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" -Code "METHOD_NOT_ALLOWED" -Message "Preview requires POST."
                    continue
                }
                if ($originHeaders.Count -ne 1 -or $originHeaders[0] -cne "http://127.0.0.1:$boundPort" -or
                    $secFetchSiteHeaders.Count -ne 1 -or $secFetchSiteHeaders[0] -cne "same-origin") {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" -Code "FORBIDDEN" -Message "Preview requires a same-origin request."
                    continue
                }
                try {
                    $previewRequest = Read-JsonRequestObject -Stream $stream -ContentLengthHeaders $contentLengthHeaders `
                        -ContentTypeHeaders $contentTypeHeaders -TransferEncodingHeaders $transferEncodingHeaders -MaximumBytes 65536
                    if ($requestTarget -cne $requestPath) { throw [ArgumentException]::new("Preview queries are not supported.") }
                    $previewBuild = Convert-ModdingPreviewBuild $previewRequest
                } catch {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" -Code "INVALID_BUILD" -Message "A bounded valid weapon build and preview angle are required."
                    continue
                }
                $previewKey = Get-ModdingPreviewHash (ConvertTo-Json -InputObject $previewBuild -Compress -Depth 8)
                if ($script:moddingPreviewCache.Contains($previewKey)) {
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value $script:moddingPreviewCache[$previewKey]
                    continue
                }
                if ($script:moddingPreviewCooldownUtc -gt [DateTime]::UtcNow) {
                    Send-JsonResponse -Stream $stream -StatusCode 429 -Reason "Too Many Requests" -Value @{ error = @{
                        code = "RATE_LIMITED"; message = "The preview provider requested a pause."
                        retryAfterSeconds = [long][Math]::Ceiling(($script:moddingPreviewCooldownUtc - [DateTime]::UtcNow).TotalSeconds)
                    } }
                    continue
                }
                if ($null -ne $script:moddingPreviewJob) {
                    Send-JsonResponse -Stream $stream -StatusCode 503 -Reason "Service Unavailable" -Value @{ error = @{
                        code = "PREVIEW_BUSY"; message = "Another preview is in progress."; retryAfterSeconds = 2
                    } }
                    continue
                }
                Start-ModdingPreviewJob -Build $previewBuild -Key $previewKey -Client $client -Stream $stream
                # The background runspace owns only this response socket. Keep the
                # main loop available to screenshots, maps and client heartbeats.
                $client = $null
                $stream = $null
                continue
            }

            $appUpdatePaths = @(
                "/api/v1/app-update/session",
                "/api/v1/app-update/status",
                "/api/v1/app-update/check",
                "/api/v1/app-update/stage",
                "/api/v1/app-update/apply"
            )
            if ($appUpdatePaths -contains $requestPath) {
                $expectedOrigin = "http://127.0.0.1:$boundPort"
                $sameOriginGet = (
                    ($originHeaders.Count -eq 0 -or ($originHeaders.Count -eq 1 -and $originHeaders[0] -ceq $expectedOrigin)) -and
                    $secFetchSiteHeaders.Count -eq 1 -and $secFetchSiteHeaders[0] -ceq "same-origin"
                )
                if ($requestTarget -cne $requestPath) {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" -Code "INVALID_REQUEST" -Message "Update API queries are not supported."
                    continue
                }
                if ($requestPath -eq "/api/v1/app-update/session") {
                    if ($method -ne "GET") {
                        Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                        continue
                    }
                    if (-not $sameOriginGet -or $updateHeaders.Count -ne 0 -or $contentLengthHeaders.Count -ne 0 -or $contentTypeHeaders.Count -ne 0 -or $transferEncodingHeaders.Count -ne 0) {
                        Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" -Code "FORBIDDEN" -Message "The update session request was not same-origin."
                        continue
                    }
                    $status = Get-AppUpdateStatus -Context $appUpdateContext
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value ([ordered]@{
                        protocolVersion = $appUpdateProtocolVersion
                        capability = "PUBLIC_GITHUB_RELEASES"
                        token = $appUpdateToken
                        repository = if ($appUpdateContext.Enabled) { [string]$appUpdateContext.Repository } else { $null }
                        status = $status
                    })
                    continue
                }
                if (
                    $updateHeaders.Count -ne 1 -or $updateHeaders[0] -cne $appUpdateToken -or
                    $secFetchSiteHeaders.Count -ne 1 -or $secFetchSiteHeaders[0] -cne "same-origin"
                ) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" -Code "FORBIDDEN" -Message "The app update request could not be authenticated."
                    continue
                }
                if ($requestPath -eq "/api/v1/app-update/status") {
                    if ($method -ne "GET") {
                        Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                        continue
                    }
                    if (-not $sameOriginGet -or $contentLengthHeaders.Count -ne 0 -or $contentTypeHeaders.Count -ne 0 -or $transferEncodingHeaders.Count -ne 0) {
                        Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" -Code "FORBIDDEN" -Message "The app update status request was not same-origin."
                        continue
                    }
                    try { $publicUpdateStatus = Get-AppUpdateStatus -Context $appUpdateContext }
                    catch {
                        Write-PortableLog "App update status serialization failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
                        Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Code "UPDATE_STATUS_FAILED" -Message "The app update status could not be read."
                        continue
                    }
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value ([ordered]@{ protocolVersion = $appUpdateProtocolVersion; status = $publicUpdateStatus })
                    continue
                }
                if ($method -ne "POST") {
                    Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                    continue
                }
                if ($originHeaders.Count -ne 1 -or $originHeaders[0] -cne $expectedOrigin) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" -Code "FORBIDDEN" -Message "The app update mutation was not same-origin."
                    continue
                }
                try {
                    $updateRequest = Read-JsonRequestObject -Stream $stream `
                        -ContentLengthHeaders $contentLengthHeaders -ContentTypeHeaders $contentTypeHeaders -TransferEncodingHeaders $transferEncodingHeaders
                    if ($requestPath -eq "/api/v1/app-update/check") {
                        try { Assert-JsonObjectShape -Value $updateRequest -AllowedProperties @() }
                        catch [ArgumentException] { throw [FormatException]::new("The check request must be an empty object.", $_.Exception) }
                    } else {
                        try { Assert-JsonObjectShape -Value $updateRequest -AllowedProperties @("candidateId") -RequiredProperties @("candidateId") }
                        catch [ArgumentException] { throw [FormatException]::new("The stage request must contain exactly one candidateId.", $_.Exception) }
                        if ($updateRequest.candidateId -isnot [string] -or $updateRequest.candidateId -notmatch '^[A-Za-z0-9_-]{40,64}$') { throw [FormatException]::new("The reviewed candidate identifier is invalid.") }
                    }
                    # Consume and validate the bounded POST body before any semantic
                    # conflict response. Closing a Windows socket with unread body
                    # bytes can reset and truncate an otherwise valid JSON reply.
                    if (-not $appUpdateContext.Enabled) {
                        Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "NOT_CONFIGURED" -Message "Public updates are not configured for this package."
                        continue
                    }
                    $currentUpdateStatus = Get-AppUpdateStatus -Context $appUpdateContext
                    if ($requestPath -eq "/api/v1/app-update/apply") {
                        if ($currentUpdateStatus.state -ne "READY_TO_RESTART") {
                            Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "UPDATE_NOT_READY" -Message "A verified update is not ready to apply."
                            continue
                        }
                        if ($currentUpdateStatus.candidateId -cne [string]$updateRequest.candidateId) {
                            Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "CANDIDATE_MISMATCH" -Message "The reviewed update candidate is no longer available."
                            continue
                        }
                        if ((Invoke-PendingAppUpdate -ValidateOnly -ExpectedCandidate ([string]$updateRequest.candidateId)) -ne 0) {
                            Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "UPDATE_INVALID" -Message "The staged update could not be validated."
                            continue
                        }
                        $handoff = $null
                        try {
                            $handoff = Start-AppUpdateHandoff -CandidateId ([string]$updateRequest.candidateId) -BoundPort $boundPort
                        } catch {
                            Write-PortableLog "Live app update handoff failed before shutdown: $($_.Exception.GetType().Name): $($_.Exception.Message)"
                            Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Code "UPDATE_HANDOFF_FAILED" -Message "The update could not be prepared for a safe restart."
                            continue
                        }
                        $initialStatus = [pscustomobject]@{
                            state = "APPLYING"
                            currentVersion = [string]$currentUpdateStatus.currentVersion
                            latestVersion = [string]$currentUpdateStatus.latestVersion
                            startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
                        }
                        try {
                            # Only acknowledge the mutation after an exact, hash-pinned broker
                            # is running from persistent state and waiting for this Serve
                            # process identity to exit. A response-write failure cancels that
                            # helper and leaves the old server untouched.
                            if ($env:TARKOV_HELPER_UPDATE_TEST_FAIL_APPLY_RESPONSE -ceq "1") {
                                throw [IO.IOException]::new("Injected live update response-write failure.")
                            }
                            Send-JsonResponse -Stream $stream -StatusCode 202 -Reason "Accepted" -Value ([ordered]@{ protocolVersion = $appUpdateProtocolVersion; status = $initialStatus })
                        } catch {
                            Write-PortableLog "Live app update response failed; cancelling the acknowledged helper before continuing."
                            Stop-AppUpdateHandoffProcess -Handoff $handoff
                            Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Code "UPDATE_HANDOFF_CANCELLED" -Message "The update response could not be delivered, so the safe restart was cancelled."
                            continue
                        }
                        $script:shutdownRequested = $true
                        continue
                    }
                    if ($currentUpdateStatus.state -eq "READY_TO_RESTART") {
                        Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "UPDATE_READY" -Message "The staged update is ready to apply."
                        continue
                    }
                    if ($requestPath -eq "/api/v1/app-update/check") {
                        $initialStatus = Start-AppUpdateWorker -WorkerAction "Check" -Context $appUpdateContext -BoundPort $boundPort
                    } else {
                        $initialStatus = Start-AppUpdateWorker -WorkerAction "Stage" -Context $appUpdateContext -ReviewedCandidate ([string]$updateRequest.candidateId) -BoundPort $boundPort
                    }
                    Send-JsonResponse -Stream $stream -StatusCode 202 -Reason "Accepted" -Value ([ordered]@{ protocolVersion = $appUpdateProtocolVersion; status = $initialStatus })
                } catch [InvalidOperationException] {
                    Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "UPDATE_BUSY" -Message "An app update operation is already in progress."
                } catch [ArgumentException] {
                    Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" -Code "CANDIDATE_MISMATCH" -Message "The reviewed update candidate is no longer available."
                } catch [FormatException] {
                    Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" -Code "INVALID_REQUEST" -Message "The update request shape is invalid."
                } catch [IO.InvalidDataException] {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" -Code "INVALID_JSON" -Message "A bounded JSON object is required."
                } catch {
                    Write-PortableLog "App update worker launch failed: $($_.Exception.GetType().Name)"
                    Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Code "UPDATE_WORKER_FAILED" -Message "The background update worker could not be started."
                }
                continue
            }

            $clientLifecyclePaths = @(
                "/api/v1/client/session",
                "/api/v1/client/heartbeat",
                "/api/v1/client/close"
            )
            if ($clientLifecyclePaths -contains $requestPath) {
                $expectedOrigin = "http://127.0.0.1:$boundPort"
                $originMatches = $originHeaders.Count -eq 0 -or (
                    $originHeaders.Count -eq 1 -and $originHeaders[0] -ceq $expectedOrigin
                )
                $fetchSiteMatches = $secFetchSiteHeaders.Count -eq 0 -or (
                    $secFetchSiteHeaders.Count -eq 1 -and $secFetchSiteHeaders[0] -ceq "same-origin"
                )
                if (-not $originMatches -or -not $fetchSiteMatches) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" `
                        -Code "FORBIDDEN" -Message "The client lifecycle request could not be authenticated."
                    continue
                }

                if ($requestPath -eq "/api/v1/client/session") {
                    if ($method -ne "GET") {
                        Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                            -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                        continue
                    }
                    $leaseToken = New-ClientLease
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value ([pscustomobject]@{
                        protocolVersion = 1
                        leaseToken = $leaseToken
                        heartbeatIntervalMs = 2000
                        timeoutMs = [int]($clientLeaseTimeoutSeconds * 1000)
                    }) -HeadOnly:$headOnly
                    continue
                }

                if ($method -ne "POST") {
                    Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                        -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                    continue
                }
                if ($originHeaders.Count -ne 1 -or $originHeaders[0] -cne $expectedOrigin) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" `
                        -Code "FORBIDDEN" -Message "The client lifecycle request could not be authenticated."
                    continue
                }

                try {
                    $clientRequest = Read-JsonRequestObject -Stream $stream `
                        -ContentLengthHeaders $contentLengthHeaders `
                        -ContentTypeHeaders $contentTypeHeaders `
                        -TransferEncodingHeaders $transferEncodingHeaders
                    Assert-JsonObjectShape -Value $clientRequest `
                        -AllowedProperties @("leaseToken") -RequiredProperties @("leaseToken")
                    if (
                        $clientRequest.leaseToken -isnot [string] -or
                        $clientRequest.leaseToken -notmatch "^[A-Za-z0-9_-]{40,64}$"
                    ) {
                        throw [ArgumentException]::new("The client lease token is invalid.")
                    }
                } catch [ArgumentException] {
                    Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                        -Code "INVALID_REQUEST" -Message $_.Exception.Message
                    continue
                } catch {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" `
                        -Code "INVALID_JSON" -Message "A bounded JSON object is required."
                    continue
                }

                $isCloseRequest = $requestPath -eq "/api/v1/client/close"
                if (-not (Touch-ClientLease -Token ([string]$clientRequest.leaseToken) -Closing:$isCloseRequest)) {
                    Send-JsonError -Stream $stream -StatusCode 404 -Reason "Not Found" `
                        -Code "LEASE_NOT_FOUND" -Message "The client lease is no longer active."
                    continue
                }
                Send-Response -Stream $stream -StatusCode 204 -Reason "No Content" `
                    -ContentType "application/json; charset=utf-8" -Body (New-Object byte[] 0)
                continue
            }

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
                $script:shutdownRequested = $true
                continue
            }

            $isNativeOverlayMutation = (
                $requestPath -eq "/api/v1/native-overlay/claims" -or
                $requestPath -eq "/api/v1/native-overlay/minimap" -or
                $requestPath -eq "/api/v2/native-overlay/claims" -or
                $requestPath -eq "/api/v2/native-overlay/windows"
            )
            if ($isNativeOverlayMutation) {
                $isNativeOverlayV2 = $requestPath.StartsWith("/api/v2/native-overlay/", [StringComparison]::Ordinal)
                $nativeProtocolVersion = if ($isNativeOverlayV2) { 2 } else { 1 }
                $isNativeClaimPath = $requestPath -in @(
                    "/api/v1/native-overlay/claims",
                    "/api/v2/native-overlay/claims"
                )
                $isNativeWindowPath = $requestPath -in @(
                    "/api/v1/native-overlay/minimap",
                    "/api/v2/native-overlay/windows"
                )
                $allowedNativeMethod = (
                    ($isNativeClaimPath -and $method -eq "POST") -or
                    ($isNativeWindowPath -and $method -in @("POST", "PATCH", "DELETE"))
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

                if ($isNativeClaimPath) {
                    try {
                        if ($isNativeOverlayV2) {
                            Assert-JsonObjectShape -Value $requestObject `
                                -AllowedProperties @("overlayKind", "windowNonce") -RequiredProperties @("overlayKind")
                            if (
                                $requestObject.overlayKind -isnot [string] -or
                                @("minimap", "quest-list") -cnotcontains $requestObject.overlayKind
                            ) {
                                throw [ArgumentException]::new("The overlay kind is invalid.")
                            }
                            if ($requestObject.overlayKind -ceq "quest-list") {
                                Assert-JsonObjectShape -Value $requestObject `
                                    -AllowedProperties @("overlayKind", "windowNonce") `
                                    -RequiredProperties @("overlayKind", "windowNonce")
                                if (
                                    $requestObject.windowNonce -isnot [string] -or
                                    -not (Test-NativeQuestWindowNonce -WindowNonce $requestObject.windowNonce)
                                ) {
                                    throw [ArgumentException]::new("The quest overlay window nonce is invalid.")
                                }
                                $claimResponse = New-NativeOverlayClaim `
                                    -OverlayKind "quest-list" -ProtocolVersion 2 `
                                    -WindowNonce $requestObject.windowNonce
                            } else {
                                Assert-JsonObjectShape -Value $requestObject `
                                    -AllowedProperties @("overlayKind") -RequiredProperties @("overlayKind")
                                $claimResponse = New-NativeOverlayClaim `
                                    -OverlayKind "minimap" -ProtocolVersion 2
                            }
                        } else {
                            Assert-JsonObjectShape -Value $requestObject -AllowedProperties @()
                            $claimResponse = New-NativeOverlayClaim
                        }
                        switch ($claimResponse.errorCode) {
                            "OVERLAY_ALREADY_ATTACHED" {
                                Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" `
                                    -Code "OVERLAY_ALREADY_ATTACHED" -Message "A native overlay is already attached or claimed."
                                continue
                            }
                            "WINDOW_NOT_FOUND" {
                                Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" `
                                    -Code "WINDOW_NOT_FOUND" -Message "No eligible quest overlay window was found."
                                continue
                            }
                            "AMBIGUOUS_WINDOW" {
                                Send-JsonError -Stream $stream -StatusCode 409 -Reason "Conflict" `
                                    -Code "AMBIGUOUS_WINDOW" -Message "More than one eligible quest overlay window was found."
                                continue
                            }
                        }
                        Send-JsonResponse -Stream $stream -StatusCode 201 -Reason "Created" -Value $claimResponse
                    } catch [ArgumentException] {
                        Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                            -Code "INVALID_REQUEST" -Message $_.Exception.Message
                    } catch {
                        Write-PortableLog "Native overlay claim failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
                        Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                            -Code "NATIVE_FAILURE" -Message "The native overlay bridge could not be initialized."
                    }
                    continue
                }

                if ($method -eq "POST") {
                    try {
                        $postAllowedProperties = if ($isNativeOverlayV2) {
                            @("overlayKind", "claimId", "windowTitle")
                        } else {
                            @("claimId", "windowTitle")
                        }
                        Assert-JsonObjectShape -Value $requestObject `
                            -AllowedProperties $postAllowedProperties `
                            -RequiredProperties $postAllowedProperties
                        $overlayKind = if ($isNativeOverlayV2) {
                            [string]$requestObject.overlayKind
                        } else {
                            "minimap"
                        }
                        if (@("minimap", "quest-list") -cnotcontains $overlayKind) {
                            throw [ArgumentException]::new("The overlay kind is invalid.")
                        }
                        $expectedWindowTitle = Get-NativeOverlayWindowTitle -OverlayKind $overlayKind
                        if (
                            $requestObject.claimId -isnot [string] -or
                            $requestObject.claimId -notmatch "^[A-Za-z0-9_-]{40,64}$" -or
                            $requestObject.windowTitle -isnot [string] -or
                            $requestObject.windowTitle -cne $expectedWindowTitle
                        ) {
                            throw [ArgumentException]::new("The claim identifier or window title is invalid.")
                        }
                    } catch [ArgumentException] {
                        Send-JsonError -Stream $stream -StatusCode 422 -Reason "Unprocessable Content" `
                            -Code "INVALID_REQUEST" -Message $_.Exception.Message
                        continue
                    }

                    try {
                        $completeResponse = Complete-NativeOverlayClaim `
                            -ClaimId $requestObject.claimId -OverlayKind $overlayKind `
                            -ProtocolVersion $nativeProtocolVersion `
                            -WindowTitle $requestObject.windowTitle
                    } catch {
                        Write-PortableLog "Native overlay attachment failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
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
                    $hasOpacity = @($requestObject.PSObject.Properties.Name) -contains "opacity"
                    try {
                        $patchAllowedProperties = if ($isNativeOverlayV2) {
                            @("overlayKind", "overlayId", "mode", "width", "height", "opacity")
                        } else {
                            @("overlayId", "mode", "width", "height", "opacity")
                        }
                        $patchRequiredProperties = if ($isNativeOverlayV2) {
                            @("overlayKind", "overlayId", "mode")
                        } else {
                            @("overlayId", "mode")
                        }
                        Assert-JsonObjectShape -Value $requestObject `
                            -AllowedProperties $patchAllowedProperties `
                            -RequiredProperties $patchRequiredProperties
                        $overlayKind = if ($isNativeOverlayV2) {
                            [string]$requestObject.overlayKind
                        } else {
                            "minimap"
                        }
                        if (
                            @("minimap", "quest-list") -cnotcontains $overlayKind -or
                            $requestObject.overlayId -isnot [string] -or
                            $requestObject.overlayId -notmatch "^[A-Za-z0-9_-]{40,64}$" -or
                            $requestObject.mode -isnot [string] -or
                            @("UNLOCKED", "LOCKED", "CLICK_THROUGH") -cnotcontains $requestObject.mode -or
                            $hasWidth -ne $hasHeight -or
                            ($hasOpacity -and (
                                $requestObject.opacity -isnot [double] -and
                                $requestObject.opacity -isnot [decimal] -and
                                $requestObject.opacity -isnot [int]
                            ))
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
                        if ($hasOpacity) {
                            $opacity = [double]$requestObject.opacity
                            if (
                                [double]::IsNaN($opacity) -or
                                [double]::IsInfinity($opacity) -or
                                $opacity -lt 0.1 -or
                                $opacity -gt 1
                            ) {
                                throw [ArgumentException]::new("Overlay opacity must be between 0.1 and 1.")
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
                        $opacity = if ($hasOpacity) { [Nullable[double]]([double]$requestObject.opacity) } else { $null }
                        $updateResponse = Set-NativeOverlayMode -OverlayKind $overlayKind `
                            -OverlayId $requestObject.overlayId -Mode $requestObject.mode `
                            -Width $width -Height $height -Opacity $opacity `
                            -ProtocolVersion $nativeProtocolVersion
                    } catch {
                        Write-PortableLog "Native overlay update failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
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
                    $deleteProperties = if ($isNativeOverlayV2) {
                        @("overlayKind", "overlayId")
                    } else {
                        @("overlayId")
                    }
                    Assert-JsonObjectShape -Value $requestObject `
                        -AllowedProperties $deleteProperties -RequiredProperties $deleteProperties
                    $overlayKind = if ($isNativeOverlayV2) {
                        [string]$requestObject.overlayKind
                    } else {
                        "minimap"
                    }
                    if (
                        @("minimap", "quest-list") -cnotcontains $overlayKind -or
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
                    $removed = Remove-NativeOverlay -OverlayKind $overlayKind `
                        -OverlayId $requestObject.overlayId
                } catch {
                    Write-PortableLog "Native overlay detach failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
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

            if ($requestPath -in @(
                "/api/v1/native-overlay/events",
                "/api/v2/native-overlay/events"
            )) {
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
                    $eventsProtocolVersion = if ($requestPath -eq "/api/v2/native-overlay/events") { 2 } else { 1 }
                    $eventPayload = Get-NativeOverlayEventsPayload `
                        -RequestTarget $requestTarget -ProtocolVersion $eventsProtocolVersion
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value $eventPayload
                } catch [ArgumentException] {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" `
                        -Code "INVALID_QUERY" -Message $_.Exception.Message
                } catch {
                    Write-PortableLog "Native overlay event read failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
                    Send-JsonError -Stream $stream -StatusCode 500 -Reason "Internal Server Error" `
                        -Code "NATIVE_FAILURE" -Message "The native overlay hotkey bridge could not be read."
                }
                continue
            }

            if ($requestPath -eq "/api/v1/item-prices/quote") {
                if ($method -cne "GET") {
                    Send-JsonError -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                        -Code "METHOD_NOT_ALLOWED" -Message "The HTTP method is not supported."
                    continue
                }
                $expectedOrigin = "http://127.0.0.1:$boundPort"
                if (
                    $originHeaders.Count -gt 1 -or
                    ($originHeaders.Count -eq 1 -and $originHeaders[0] -cne $expectedOrigin) -or
                    $secFetchSiteHeaders.Count -ne 1 -or
                    $secFetchSiteHeaders[0] -cne "same-origin" -or
                    $contentLengthHeaders.Count -ne 0 -or
                    $contentTypeHeaders.Count -ne 0 -or
                    $transferEncodingHeaders.Count -ne 0
                ) {
                    Send-JsonError -Stream $stream -StatusCode 403 -Reason "Forbidden" `
                        -Code "FORBIDDEN" -Message "The item price request was not same-origin."
                    continue
                }
                try {
                    $priceQuery = Get-QueryParameters -RequestTarget $requestTarget
                    if (
                        $priceQuery.Count -ne 2 -or
                        -not $priceQuery.ContainsKey("itemId") -or
                        -not $priceQuery.ContainsKey("gameMode") -or
                        $priceQuery["itemId"] -notmatch '^[0-9a-f]{24}$' -or
                        @("pvp", "pve") -cnotcontains $priceQuery["gameMode"]
                    ) {
                        throw [ArgumentException]::new("itemId and gameMode must be valid and appear exactly once.")
                    }
                } catch [ArgumentException] {
                    Send-JsonError -Stream $stream -StatusCode 400 -Reason "Bad Request" `
                        -Code "INVALID_QUERY" -Message $_.Exception.Message
                    continue
                }
                try {
                    $priceQuote = Get-ItemPriceQuote `
                        -ItemId ([string]$priceQuery["itemId"]) `
                        -GameMode ([string]$priceQuery["gameMode"])
                    Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -Value $priceQuote
                } catch {
                    Send-JsonError -Stream $stream -StatusCode 502 -Reason "Bad Gateway" `
                        -Code "PRICE_UPSTREAM_UNAVAILABLE" -Message "The live item price is temporarily unavailable."
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
            if ($requestPath -eq "/api/v2/native-overlay/session") {
                Send-JsonResponse -Stream $stream -StatusCode 200 -Reason "OK" -HeadOnly:$headOnly -Value ([pscustomobject]@{
                    protocolVersion = $nativeOverlayV2ProtocolVersion
                    capability = $nativeOverlayV2Capability
                    token = $nativeOverlayToken
                    windowTitles = [pscustomobject]@{
                        minimap = $nativeOverlayWindowTitle
                        questList = $nativeOverlayQuestListWindowTitle
                    }
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
                    instanceId = $trackerInstanceId
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
            Write-PortableLog "Unhandled local request failure: $($_.Exception.GetType().Name): $($_.Exception.Message)"
            try {
                if ($null -ne $stream -and $stream.CanWrite) {
                    Send-TextResponse -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Message "Internal Server Error"
                }
            } catch {
                # The client may already have disconnected.
            }
        } finally {
            if ($null -ne $client) { $client.Dispose() }
            $handledRequests++
            Update-ScreenshotWatcher
            Update-NativeOverlayBridge
        }
    }
    $serverCompletedNormally = $true
} catch {
    Write-PortableLog "Server terminated unexpectedly: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    throw
} finally {
    $cleanupFailed = $false
    if ($null -ne $script:moddingPreviewJob) {
        try { $script:moddingPreviewJob.client.Dispose(); $script:moddingPreviewJob.worker.Stop(); $script:moddingPreviewJob.worker.Dispose() } catch { }
        $script:moddingPreviewJob = $null
    }
    try {
        Remove-AllNativeOverlays
    } catch {
        $cleanupFailed = $true
        Write-PortableLog "One or more native overlay restorations failed during shutdown."
    }
    try { Stop-ScreenshotWatcher } catch { $cleanupFailed = $true; Write-PortableLog "Screenshot watcher cleanup failed: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
    try { $listener.Stop() } catch { $cleanupFailed = $true; Write-PortableLog "Listener cleanup failed: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
    if ($ownsInstanceState) {
        try {
            Remove-OwnedInstance -ProcessId $PID -ControlToken $controlToken
        } catch {
            $cleanupFailed = $true
            Write-PortableLog "Instance state cleanup failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
        }
    }
    if ($hasServeMutex) { try { $serveMutex.ReleaseMutex() } catch { $cleanupFailed = $true; Write-PortableLog "Serve mutex release failed: $($_.Exception.GetType().Name): $($_.Exception.Message)" } }
    if ($null -ne $serveMutex) { try { $serveMutex.Dispose() } catch { $cleanupFailed = $true; Write-PortableLog "Serve mutex disposal failed: $($_.Exception.GetType().Name): $($_.Exception.Message)" } }
    if ($serverCompletedNormally -and -not $cleanupFailed) { Write-PortableLog "Server stopped normally." }
}
