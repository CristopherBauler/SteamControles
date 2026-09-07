@echo off
rem Atalho do app deve apontar para o Electron desta pasta (codigo atual).
rem dist\SteamControles.exe e um snapshot portatil, nao o atalho do dia a dia.
cd /d "%~dp0"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if exist "%ROOT%\node_modules\electron\dist\electron.exe" (
  start "" "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%"
  exit /b 0
)

if exist "%ROOT%\dist\SteamControles.exe" (
  start "" "%ROOT%\dist\SteamControles.exe"
  exit /b 0
)

if exist "%ROOT%\SteamControles.bat" (
  call "%ROOT%\SteamControles.bat"
  exit /b %ERRORLEVEL%
)

echo Electron nao encontrado. Rode npm install nesta pasta.
pause
exit /b 1
