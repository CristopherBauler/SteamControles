@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === Conectar Steam ===
echo Vai abrir o navegador. Entre na Steam (e no celular, se pedir).
echo Este programa nao recebe sua senha.
echo.
node Scripts\steamLogin.js
if errorlevel 1 (
  echo Login cancelado ou falhou.
  pause
  exit /b 1
)
echo.
echo Sincronizando sua wishlist...
node Scripts\updateWishlist.js
echo.
pause
