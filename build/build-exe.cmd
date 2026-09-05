@echo off
rem Build Firstlight.exe by double-click. See build-exe.mjs for what it does.
setlocal
pushd "%~dp0.."

where node >nul 2>nul || (
  echo Node.js is not on PATH. Install Node 20 or newer: https://nodejs.org
  pause
  exit /b 1
)

node build\build-exe.mjs
if errorlevel 1 (
  echo.
  echo Build failed — see the output above.
  pause
  exit /b 1
)

echo.
echo Built build\dist\Firstlight\Firstlight.exe
pause
popd
endlocal
