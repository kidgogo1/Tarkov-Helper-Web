Option Explicit

Dim shell, fileSystem, processEnvironment, packageRoot, runtimeRoot, powerShellPath, powerShellCommand, commandLine, stopCommandLine, exitCode, stopExitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
packageRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
runtimeRoot = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
If Not fileSystem.FolderExists(runtimeRoot) Then
    MsgBox "The Windows local application data folder is unavailable.", 16, "Tarkov Helper"
    WScript.Quit 1
End If
shell.CurrentDirectory = runtimeRoot
Set processEnvironment = shell.Environment("Process")
processEnvironment("TARKOV_HELPER_PACKAGE_ROOT") = packageRoot
powerShellPath = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")
If Not fileSystem.FileExists(powerShellPath) Then
    MsgBox "Windows PowerShell is unavailable.", 16, "Tarkov Helper"
    WScript.Quit 1
End If
powerShellCommand = "& ([IO.Path]::Combine($env:TARKOV_HELPER_PACKAGE_ROOT, 'launcher.ps1')) -Action Start"
commandLine = Quote(powerShellPath) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " & Quote(powerShellCommand)
exitCode = shell.Run(commandLine, 0, True)

If exitCode <> 0 Then
    ' A previous Tarkov Helper build may still own the fixed loopback port.
    ' Stop only the authenticated instance recorded by our launcher, then retry.
    powerShellCommand = "& ([IO.Path]::Combine($env:TARKOV_HELPER_PACKAGE_ROOT, 'launcher.ps1')) -Action Stop"
    stopCommandLine = Quote(powerShellPath) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " & Quote(powerShellCommand)
    stopExitCode = shell.Run(stopCommandLine, 0, True)
    If stopExitCode = 0 Then
        exitCode = shell.Run(commandLine, 0, True)
    End If
End If

If exitCode <> 0 Then
    MsgBox "Tarkov Helper could not start. Run the diagnostic launcher for details.", 16, "Tarkov Helper"
End If

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
