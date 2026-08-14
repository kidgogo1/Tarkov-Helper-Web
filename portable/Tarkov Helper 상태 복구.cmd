@echo off
setlocal
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" -Action Repair
set "TARKOV_HELPER_REPAIR_EXIT=%ERRORLEVEL%"
echo.
if %TARKOV_HELPER_REPAIR_EXIT% EQU 0 (
  echo Tarkov Helper state repair completed. Start Tarkov Helper again.
) else (
  echo Tarkov Helper state repair was refused or failed. Run the diagnostic command for details.
)
if "%~1"=="" pause
endlocal & exit /b %TARKOV_HELPER_REPAIR_EXIT%
