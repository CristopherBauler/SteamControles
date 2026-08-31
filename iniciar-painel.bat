@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Painel local do botao Atualizar.
echo Deixe esta janela aberta.
echo No Obsidian: Minha Wishlist Steam - botao Atualizar
echo.
node Scripts\controlServer.js
pause
