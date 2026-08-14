@echo off
setlocal
set "TARKOV_HELPER_ISOLATED_INTERACTIVE=1"
if not "%~1"=="" set "TARKOV_HELPER_ISOLATED_INTERACTIVE=0"

set "TARKOV_HELPER_ISOLATED_ACTION=Start"
if /I "%~1"=="start" set "TARKOV_HELPER_ISOLATED_ACTION=Start"
if /I "%~1"=="stop" set "TARKOV_HELPER_ISOLATED_ACTION=Stop"
if not "%~2"=="" goto :usage
if "%~1"=="" goto :arguments_ok
if /I "%~1"=="start" goto :arguments_ok
if /I "%~1"=="stop" goto :arguments_ok
goto :usage

:arguments_ok
if not defined LOCALAPPDATA (
  echo The Windows local application data folder is unavailable.
  goto :failure
)
set "TARKOV_HELPER_ISOLATED_STATE=%LOCALAPPDATA%\TarkovHelperWeb-Isolated-Recovery"
set "TARKOV_HELPER_ISOLATED_PORT=41753"
set "TARKOV_HELPER_ISOLATED_RECOVERY_PORT_VALUE=%TARKOV_HELPER_ISOLATED_PORT%"

if /I "%TARKOV_HELPER_ISOLATED_ACTION%"=="Stop" goto :run_launcher

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$env:TARKOV_HELPER_ISOLATED_RECOVERY_PORT_VALUE); try { $listener.Server.ExclusiveAddressUse = $true; $listener.Start(); $listener.Stop(); exit 0 } catch { exit 10 } finally { try { $listener.Stop() } catch { } }"
set "TARKOV_HELPER_ISOLATED_PROBE_EXIT=%ERRORLEVEL%"
if not "%TARKOV_HELPER_ISOLATED_PROBE_EXIT%"=="0" (
  echo Port %TARKOV_HELPER_ISOLATED_PORT% is already in use or could not be reserved safely. Stop a normal Tarkov Helper with its stop shortcut; stop an isolated one by running this command with the stop argument.
  goto :failure
)

:run_launcher
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" -Action %TARKOV_HELPER_ISOLATED_ACTION% -Port "%TARKOV_HELPER_ISOLATED_PORT%" -StateDirectory "%TARKOV_HELPER_ISOLATED_STATE%" -DisablePackageUpdates
set "TARKOV_HELPER_ISOLATED_EXIT=%ERRORLEVEL%"
echo.
if "%TARKOV_HELPER_ISOLATED_EXIT%"=="0" (
  if /I "%TARKOV_HELPER_ISOLATED_ACTION%"=="Start" (
    echo Isolated recovery started without changing the normal runtime state.
    echo To stop it, run this same command with the stop argument.
  ) else (
    echo Isolated recovery stopped.
  )
) else (
  echo Isolated recovery failed. Nothing in the normal runtime state was changed.
  echo Check server.log in "%TARKOV_HELPER_ISOLATED_STATE%".
  if "%TARKOV_HELPER_ISOLATED_INTERACTIVE%"=="1" pause
)
endlocal & exit /b %TARKOV_HELPER_ISOLATED_EXIT%

:usage
echo Usage: "%~nx0" [start^|stop]
goto :failure

:failure
if "%TARKOV_HELPER_ISOLATED_INTERACTIVE%"=="1" pause
endlocal & exit /b 2
