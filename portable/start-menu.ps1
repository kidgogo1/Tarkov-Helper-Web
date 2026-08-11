[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Register", "Unregister")]
    [string]$Action,

    [string]$PackageRoot = $PSScriptRoot,
    [string]$ProgramsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$ownershipMarker = "TarkovHelperWeb.StartMenu.v1"
$shortcutName = "Tarkov Helper.lnk"
$launcherName = "Tarkov Helper $([char]0xC2E4)$([char]0xD589).vbs"
$iconName = "TarkovHelper.ico"

function Get-FullPath {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw [ArgumentException]::new("$Label is required.")
    }
    return [IO.Path]::GetFullPath($Path)
}

function Release-ComObject {
    param([object]$Value)
    if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
        try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) } catch { }
    }
}

function Read-Shortcut {
    param([string]$Path)
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
        return [pscustomobject]@{
            TargetPath = [string]$shortcut.TargetPath
            Arguments = [string]$shortcut.Arguments
            WorkingDirectory = [string]$shortcut.WorkingDirectory
            IconLocation = [string]$shortcut.IconLocation
            Description = [string]$shortcut.Description
        }
    } finally {
        Release-ComObject $shortcut
        Release-ComObject $shell
    }
}

function Assert-OwnedShortcut {
    param([string]$Path)
    $properties = Read-Shortcut $Path
    if ($properties.Description -cne $ownershipMarker) {
        throw [UnauthorizedAccessException]::new("The existing Tarkov Helper shortcut belongs to another application.")
    }
    return $properties
}

function Test-PathEqual {
    param([string]$Left, [string]$Right)
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-ShortcutProperties {
    param(
        [string]$Path,
        [string]$TargetPath,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$IconLocation
    )
    $properties = Read-Shortcut $Path
    if (-not (Test-PathEqual $properties.TargetPath $TargetPath) -or
        $properties.Arguments -cne $Arguments -or
        -not (Test-PathEqual $properties.WorkingDirectory $WorkingDirectory) -or
        -not (Test-PathEqual $properties.IconLocation $IconLocation) -or
        $properties.Description -cne $ownershipMarker) {
        throw [IO.InvalidDataException]::new("The generated Start menu shortcut did not pass verification.")
    }
}

$packageDirectory = Get-FullPath $PackageRoot "PackageRoot"
$programsDirectoryPath = Get-FullPath $ProgramsDirectory "ProgramsDirectory"
$shortcutWorkingDirectory = Get-FullPath $env:LOCALAPPDATA "LocalAppData"
$shortcutPath = Join-Path $programsDirectoryPath $shortcutName

if ($Action -ceq "Unregister") {
    if (-not [IO.File]::Exists($shortcutPath)) {
        Write-Output "Tarkov Helper is not registered in the Windows Start menu."
        exit 0
    }
    [void](Assert-OwnedShortcut $shortcutPath)
    [IO.File]::Delete($shortcutPath)
    Write-Output "Tarkov Helper was removed from the Windows Start menu."
    exit 0
}

$launcherPath = Join-Path $packageDirectory $launcherName
$iconPath = Join-Path $packageDirectory $iconName
if (-not [IO.File]::Exists($launcherPath)) {
    throw [IO.FileNotFoundException]::new("The Tarkov Helper launcher is missing.", $launcherPath)
}
if (-not [IO.File]::Exists($iconPath)) {
    throw [IO.FileNotFoundException]::new("The Tarkov Helper icon is missing.", $iconPath)
}

$windowsDirectory = Get-FullPath $env:SystemRoot "SystemRoot"
$wscriptPath = Join-Path $windowsDirectory "System32\wscript.exe"
if (-not [IO.File]::Exists($wscriptPath)) {
    throw [IO.FileNotFoundException]::new("Windows Script Host is unavailable.", $wscriptPath)
}

$arguments = '//Nologo "' + $launcherPath + '"'
$iconLocation = $iconPath + ",0"

if ([IO.File]::Exists($shortcutPath)) {
    [void](Assert-OwnedShortcut $shortcutPath)
}

[IO.Directory]::CreateDirectory($programsDirectoryPath) | Out-Null
$shellStagingRoot = Get-FullPath ([IO.Path]::GetTempPath()) "TempPath"
$temporaryPath = Join-Path $programsDirectoryPath ("TarkovHelperWeb.StartMenu." + [Guid]::NewGuid().ToString("N") + ".tmp.lnk")
$backupPath = Join-Path $programsDirectoryPath ("TarkovHelperWeb.StartMenu." + [Guid]::NewGuid().ToString("N") + ".bak")
$shellStagingDirectory = Join-Path $shellStagingRoot ("TarkovHelperWeb.StartMenu." + [Guid]::NewGuid().ToString("N"))
$shellStagingPath = Join-Path $shellStagingDirectory "shortcut.lnk"
$shell = $null
$shortcut = $null
$replacementCompleted = $false
$registrationCompleted = $false
try {
    [IO.Directory]::CreateDirectory($shellStagingDirectory) | Out-Null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shellStagingPath)
        $shortcut.TargetPath = $wscriptPath
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $shortcutWorkingDirectory
        $shortcut.IconLocation = $iconLocation
        $shortcut.Description = $ownershipMarker
        $shortcut.WindowStyle = 1
        $shortcut.Save()
    } finally {
        Release-ComObject $shortcut
        Release-ComObject $shell
    }
    Assert-ShortcutProperties $shellStagingPath $wscriptPath $arguments $shortcutWorkingDirectory $iconLocation
    [IO.File]::Copy($shellStagingPath, $temporaryPath, $false)
    Assert-ShortcutProperties $temporaryPath $wscriptPath $arguments $shortcutWorkingDirectory $iconLocation
    if ([IO.File]::Exists($shortcutPath)) {
        [void](Assert-OwnedShortcut $shortcutPath)
        [IO.File]::Replace($temporaryPath, $shortcutPath, $backupPath, $true)
        $replacementCompleted = $true
    } else {
        [IO.File]::Move($temporaryPath, $shortcutPath)
    }
    try {
        Assert-ShortcutProperties $shortcutPath $wscriptPath $arguments $shortcutWorkingDirectory $iconLocation
    } catch {
        if ($replacementCompleted -and [IO.File]::Exists($backupPath)) {
            try {
                [IO.File]::Replace($backupPath, $shortcutPath, $temporaryPath, $true)
                $replacementCompleted = $false
            } catch { }
        } elseif ([IO.File]::Exists($shortcutPath)) {
            try { [IO.File]::Delete($shortcutPath) } catch { }
        }
        throw
    }
    $registrationCompleted = $true
} finally {
    if ([IO.File]::Exists($temporaryPath)) {
        try { [IO.File]::Delete($temporaryPath) } catch { }
    }
    if ($registrationCompleted -and [IO.File]::Exists($backupPath)) {
        try { [IO.File]::Delete($backupPath) } catch { }
    }
    if ([IO.File]::Exists($shellStagingPath)) {
        try { [IO.File]::Delete($shellStagingPath) } catch { }
    }
    if ([IO.Directory]::Exists($shellStagingDirectory)) {
        try { [IO.Directory]::Delete($shellStagingDirectory, $false) } catch { }
    }
}

Write-Output "Tarkov Helper was added to the Windows Start menu."
