Option Explicit

Dim shell, fileSystem, launcherPath, commandLine, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
launcherPath = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "launcher.ps1")
commandLine = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
    Chr(34) & launcherPath & Chr(34) & " -Action Start"
exitCode = shell.Run(commandLine, 0, True)

If exitCode <> 0 Then
    MsgBox "Tarkov Helper could not start. Run the diagnostic launcher for details.", 16, "Tarkov Helper"
End If
