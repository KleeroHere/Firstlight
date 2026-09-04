@echo off
rem Firstlight — one double-click: install if needed, build if needed, serve.
rem The interface and the API end up on the same port, so there is one process
rem and one address. For development use two terminals instead (see README).
setlocal
pushd "%~dp0"

where node >nul 2>nul || (
  echo Node.js is not on PATH. Install Node 22 or newer: https://nodejs.org
  pause
  exit /b 1
)

if not exist "ui\node_modules" (
  echo Installing dependencies, once...
  call npm --prefix ui install --no-audit --no-fund || (
    echo npm install failed.
    pause
    exit /b 1
  )
)

rem Rebuild when the sources are newer than the build, and on the first run.
set NEEDS_BUILD=
if not exist "ui\dist\index.html" set NEEDS_BUILD=1
for /f %%f in ('dir /b /s /o-d "ui\src\*" 2^>nul') do (
  if exist "ui\dist\index.html" for %%d in ("ui\dist\index.html") do (
    if %%~tf gtr %%~td set NEEDS_BUILD=1
  )
  goto :checked
)
:checked
if defined NEEDS_BUILD (
  echo Building the interface...
  call npm --prefix ui run build || (
    echo Build failed.
    pause
    exit /b 1
  )
)

echo.
echo Firstlight is starting on http://localhost:7331
echo Close this window to stop it.
echo.
start "" http://localhost:7331
node ui\server\server.mjs --serve dist

popd
endlocal
