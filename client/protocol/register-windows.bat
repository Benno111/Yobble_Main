@echo off
setlocal

set PROTO_NAME=%1
if "%PROTO_NAME%"=="" set PROTO_NAME=benno111engene

set ROOT=%~dp0..
set LAUNCHER=%ROOT%\\launchgame.sh
set HANDLER=%ROOT%\\protocol\\protocol-handler.cmd

if not exist "%HANDLER%" (
  echo @echo off> "%HANDLER%"
  echo setlocal>> "%HANDLER%"
  echo set URL=%%1>> "%HANDLER%"
  echo for /f "tokens=1,2 delims=/" %%%%a in ("%%URL:%PROTO_NAME%://=%%") do ^(>> "%HANDLER%"
  echo   set SLUG=%%%%a>> "%HANDLER%"
  echo   set VER=%%%%b>> "%HANDLER%"
  echo ^)>> "%HANDLER%"
  echo bash "%LAUNCHER%" "%%SLUG%%" "%%VER%%">> "%HANDLER%"
)

reg add "HKCU\\Software\\Classes\\%PROTO_NAME%" /ve /d "URL:%PROTO_NAME% Protocol" /f >nul
reg add "HKCU\\Software\\Classes\\%PROTO_NAME%" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\\Software\\Classes\\%PROTO_NAME%\\shell\\open\\command" /ve /d "\"%HANDLER%\" \"%%1\"" /f >nul

echo Registered %PROTO_NAME%:// for current user.
endlocal
