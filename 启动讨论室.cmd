@echo off
chcp 65001 >nul
rem Keep this file ASCII-only; server.js sets the Chinese window title
title Roundtable
cd /d "%~dp0"
call node server.js --app
if errorlevel 1 pause
