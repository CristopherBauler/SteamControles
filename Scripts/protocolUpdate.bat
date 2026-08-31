@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
title Atualizando wishlist Steam
echo.
echo Atualizando wishlist, gg.deals e ofertas da Steam...
echo Nao feche esta janela ate terminar.
echo.
node Scripts\updateWishlist.js
echo.
echo Pronto. Volte ao Obsidian na nota Minha Wishlist Steam e pressione Ctrl+R
echo.
pause
