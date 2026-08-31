@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Atualizando wishlist da Steam...
node Scripts\updateWishlist.js
echo.
pause
