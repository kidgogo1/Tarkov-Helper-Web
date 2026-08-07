@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" -Action Serve %*
set "TARKOV_HELPER_EXIT=%ERRORLEVEL%"
if %TARKOV_HELPER_EXIT% GEQ 2 (
  echo.
  echo Tarkov Helper could not start. Check the message and server.log in %%LOCALAPPDATA%%\TarkovHelperWeb.
  if "%~1"=="" pause
)
endlocal & exit /b %TARKOV_HELPER_EXIT%
