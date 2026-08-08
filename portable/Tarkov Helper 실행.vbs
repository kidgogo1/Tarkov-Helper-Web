Option Explicit

Dim shell, fileSystem, launcherPath, commandLine, stopCommandLine, exitCode, stopExitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
launcherPath = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "launcher.ps1")
commandLine = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
    Chr(34) & launcherPath & Chr(34) & " -Action Start"
exitCode = shell.Run(commandLine, 0, True)

If exitCode <> 0 Then
    ' A previous Tarkov Helper build may still own the fixed loopback port.
    ' Stop only the authenticated instance recorded by our launcher, then retry.
    stopCommandLine = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
        Chr(34) & launcherPath & Chr(34) & " -Action Stop"
    stopExitCode = shell.Run(stopCommandLine, 0, True)
    If stopExitCode = 0 Then
        exitCode = shell.Run(commandLine, 0, True)
    End If
End If

If exitCode <> 0 Then
    MsgBox "Tarkov Helper could not start. Run the diagnostic launcher for details.", 16, "Tarkov Helper"
End If
