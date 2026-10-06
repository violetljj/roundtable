@echo off
chcp 65001 >nul
title 圆桌讨论室（关闭此窗口即停止）
cd /d "%~dp0"
call node server.js --open
if errorlevel 1 pause
