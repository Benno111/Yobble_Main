@echo off
setlocal

set ROOT=%~dp0..
set APP_DIR=%ROOT%\s\resources\app

if not exist "%APP_DIR%\node_modules" (
  echo Installing dependencies...
  cd /d "%APP_DIR%"
  npm install
)

cd /d "%APP_DIR%"
echo Starting benno111engene client...
npx electron .

endlocal
