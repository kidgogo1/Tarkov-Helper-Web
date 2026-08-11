[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Register", "Unregister", "Inspect")]
    [string]$Action,

    [string]$PackageRoot = $PSScriptRoot,
    [string]$ProgramsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
    [string]$ShortcutPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$ownershipMarker = "TarkovHelperWeb.StartMenu.v1"
$shortcutName = "Tarkov Helper.lnk"
$launcherName = "Tarkov Helper $([char]0xC2E4)$([char]0xD589).vbs"
$iconName = "TarkovHelper.ico"

if (-not ("TarkovHelper.StartMenu.ShellLink" -as [type])) {
    $shellLinkSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace TarkovHelper.StartMenu
{
    [ComImport]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW
    {
        [PreserveSig]
        int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int capacity, IntPtr findData, uint flags);

        [PreserveSig]
        int GetIDList(out IntPtr itemIdList);

        [PreserveSig]
        int SetIDList(IntPtr itemIdList);

        [PreserveSig]
        int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);

        [PreserveSig]
        int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);

        [PreserveSig]
        int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);

        [PreserveSig]
        int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);

        [PreserveSig]
        int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);

        [PreserveSig]
        int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);

        [PreserveSig]
        int GetHotkey(out short hotkey);

        [PreserveSig]
        int SetHotkey(short hotkey);

        [PreserveSig]
        int GetShowCmd(out int showCommand);

        [PreserveSig]
        int SetShowCmd(int showCommand);

        [PreserveSig]
        int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int capacity, out int iconIndex);

        [PreserveSig]
        int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);

        [PreserveSig]
        int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);

        [PreserveSig]
        int Resolve(IntPtr window, uint flags);

        [PreserveSig]
        int SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPersistFile
    {
        [PreserveSig]
        int GetClassID(out Guid classId);

        [PreserveSig]
        int IsDirty();

        [PreserveSig]
        int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);

        [PreserveSig]
        int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);

        [PreserveSig]
        int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);

        [PreserveSig]
        int GetCurFile(out IntPtr fileName);
    }

    public sealed class ShortcutSnapshot
    {
        public string TargetPath { get; set; }
        public string Arguments { get; set; }
        public string WorkingDirectory { get; set; }
        public string IconPath { get; set; }
        public int IconIndex { get; set; }
        public string IconLocation { get; set; }
        public string Description { get; set; }
        public int ShowCommand { get; set; }
    }

    public static class ShellLink
    {
        private const string ShellLinkClassId = "00021401-0000-0000-C000-000000000046";
        private const uint ReadMode = 0;
        private const uint RawPath = 4;
        private const int BufferCapacity = 32768;

        private static object CreateInstance()
        {
            Type type = Type.GetTypeFromCLSID(new Guid(ShellLinkClassId), true);
            return Activator.CreateInstance(type);
        }

        private static void RequireSuccess(int result, string operation)
        {
            if (result != 0)
            {
                throw new COMException(operation + " failed.", result);
            }
        }

        private static void Release(object instance)
        {
            if (instance != null && Marshal.IsComObject(instance))
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        public static void Create(
            string shortcutPath,
            string targetPath,
            string arguments,
            string workingDirectory,
            string iconPath,
            int iconIndex,
            string description)
        {
            object instance = null;
            try
            {
                instance = CreateInstance();
                IShellLinkW shellLink = (IShellLinkW)instance;
                IPersistFile persistFile = (IPersistFile)instance;
                RequireSuccess(shellLink.SetPath(targetPath), "IShellLinkW.SetPath");
                RequireSuccess(shellLink.SetArguments(arguments), "IShellLinkW.SetArguments");
                RequireSuccess(shellLink.SetWorkingDirectory(workingDirectory), "IShellLinkW.SetWorkingDirectory");
                RequireSuccess(shellLink.SetIconLocation(iconPath, iconIndex), "IShellLinkW.SetIconLocation");
                RequireSuccess(shellLink.SetDescription(description), "IShellLinkW.SetDescription");
                RequireSuccess(shellLink.SetShowCmd(1), "IShellLinkW.SetShowCmd");
                RequireSuccess(persistFile.Save(shortcutPath, true), "IPersistFile.Save");
            }
            finally
            {
                Release(instance);
            }
        }

        public static ShortcutSnapshot Read(string shortcutPath)
        {
            object instance = null;
            try
            {
                instance = CreateInstance();
                IShellLinkW shellLink = (IShellLinkW)instance;
                IPersistFile persistFile = (IPersistFile)instance;
                RequireSuccess(persistFile.Load(shortcutPath, ReadMode), "IPersistFile.Load");

                StringBuilder targetPath = new StringBuilder(BufferCapacity);
                StringBuilder arguments = new StringBuilder(BufferCapacity);
                StringBuilder workingDirectory = new StringBuilder(BufferCapacity);
                StringBuilder iconPath = new StringBuilder(BufferCapacity);
                StringBuilder description = new StringBuilder(BufferCapacity);
                int iconIndex;
                int showCommand;

                RequireSuccess(shellLink.GetPath(targetPath, targetPath.Capacity, IntPtr.Zero, RawPath), "IShellLinkW.GetPath");
                RequireSuccess(shellLink.GetArguments(arguments, arguments.Capacity), "IShellLinkW.GetArguments");
                RequireSuccess(shellLink.GetWorkingDirectory(workingDirectory, workingDirectory.Capacity), "IShellLinkW.GetWorkingDirectory");
                RequireSuccess(shellLink.GetIconLocation(iconPath, iconPath.Capacity, out iconIndex), "IShellLinkW.GetIconLocation");
                RequireSuccess(shellLink.GetDescription(description, description.Capacity), "IShellLinkW.GetDescription");
                RequireSuccess(shellLink.GetShowCmd(out showCommand), "IShellLinkW.GetShowCmd");

                ShortcutSnapshot snapshot = new ShortcutSnapshot();
                snapshot.TargetPath = targetPath.ToString();
                snapshot.Arguments = arguments.ToString();
                snapshot.WorkingDirectory = workingDirectory.ToString();
                snapshot.IconPath = iconPath.ToString();
                snapshot.IconIndex = iconIndex;
                snapshot.IconLocation = snapshot.IconPath + "," + iconIndex.ToString(System.Globalization.CultureInfo.InvariantCulture);
                snapshot.Description = description.ToString();
                snapshot.ShowCommand = showCommand;
                return snapshot;
            }
            finally
            {
                Release(instance);
            }
        }
    }
}
'@
    Add-Type -TypeDefinition $shellLinkSource -Language CSharp
}

function Get-FullPath {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw [ArgumentException]::new("$Label is required.")
    }
    return [IO.Path]::GetFullPath($Path)
}

function Read-Shortcut {
    param([string]$Path)
    return [TarkovHelper.StartMenu.ShellLink]::Read($Path)
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
        [string]$IconPath
    )
    $properties = Read-Shortcut $Path
    if (-not (Test-PathEqual $properties.TargetPath $TargetPath) -or
        $properties.Arguments -cne $Arguments -or
        -not (Test-PathEqual $properties.WorkingDirectory $WorkingDirectory) -or
        -not (Test-PathEqual $properties.IconPath $IconPath) -or
        $properties.IconIndex -ne 0 -or
        $properties.ShowCommand -ne 1 -or
        $properties.Description -cne $ownershipMarker) {
        throw [IO.InvalidDataException]::new("The generated Start menu shortcut did not pass verification.")
    }
}

if ($Action -ceq "Inspect") {
    $inspectPath = Get-FullPath $ShortcutPath "ShortcutPath"
    if (-not [IO.File]::Exists($inspectPath)) {
        throw [IO.FileNotFoundException]::new("The shortcut does not exist.", $inspectPath)
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    $properties = Read-Shortcut $inspectPath
    [ordered]@{
        TargetPath = [string]$properties.TargetPath
        Arguments = [string]$properties.Arguments
        WorkingDirectory = [string]$properties.WorkingDirectory
        IconLocation = [string]$properties.IconLocation
        Description = [string]$properties.Description
        ShowCommand = [int]$properties.ShowCommand
    } | ConvertTo-Json -Compress
    exit 0
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

if ([IO.File]::Exists($shortcutPath)) {
    [void](Assert-OwnedShortcut $shortcutPath)
}

[IO.Directory]::CreateDirectory($programsDirectoryPath) | Out-Null
$temporaryPath = Join-Path $programsDirectoryPath ("TarkovHelperWeb.StartMenu." + [Guid]::NewGuid().ToString("N") + ".tmp.lnk")
$backupPath = Join-Path $programsDirectoryPath ("TarkovHelperWeb.StartMenu." + [Guid]::NewGuid().ToString("N") + ".bak")
$replacementCompleted = $false
$registrationCompleted = $false
try {
    [TarkovHelper.StartMenu.ShellLink]::Create(
        $temporaryPath,
        $wscriptPath,
        $arguments,
        $shortcutWorkingDirectory,
        $iconPath,
        0,
        $ownershipMarker
    )
    Assert-ShortcutProperties $temporaryPath $wscriptPath $arguments $shortcutWorkingDirectory $iconPath
    if ([IO.File]::Exists($shortcutPath)) {
        [void](Assert-OwnedShortcut $shortcutPath)
        [IO.File]::Replace($temporaryPath, $shortcutPath, $backupPath, $true)
        $replacementCompleted = $true
    } else {
        [IO.File]::Move($temporaryPath, $shortcutPath)
    }
    try {
        Assert-ShortcutProperties $shortcutPath $wscriptPath $arguments $shortcutWorkingDirectory $iconPath
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
}

Write-Output "Tarkov Helper was added to the Windows Start menu."
