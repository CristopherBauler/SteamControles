@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Nao fixe este .bat nem o electron.exe na barra. Use dist\SteamControles.exe
rem ou o atalho criado no app (Ajustes). O electron.exe SEM a pasta abre a tela Electron.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"

rem Pasta do projeto = pasta deste .bat, nao o "Iniciar em" do atalho.

if exist "%ELECTRON%" goto launch

set "NPM="
if exist "C:\Program Files\nodejs\npm.cmd" set "NPM=C:\Program Files\nodejs\npm.cmd"
if exist "C:\Program Files (x86)\nodejs\npm.cmd" set "NPM=C:\Program Files (x86)\nodejs\npm.cmd"
if not defined NPM (
  for /f "delims=" %%I in ('where npm.cmd 2^>nul') do (
    if not defined NPM set "NPM=%%I"
  )
)

if not defined NPM (
  echo Node.js/npm nao encontrado. Instale o Node.js 18+ em https://nodejs.org/ e tente de novo.
  echo Pasta do projeto: %ROOT%
  pause
  exit /b 1
)

echo Primeira vez: instalando dependencias...
call "%NPM%" install
if errorlevel 1 (
  echo npm install falhou na pasta do projeto:
  echo %ROOT%
  echo Instale o Node.js 18+ e tente de novo.
  pause
  exit /b 1
)

if not exist "%ELECTRON%" (
  echo Electron nao encontrado em:
  echo %ELECTRON%
  echo Rode npm install na pasta do projeto.
  pause
  exit /b 1
)

:launch
start "" "%ELECTRON%" "%ROOT%"