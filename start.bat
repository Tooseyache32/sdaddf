@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Установка зависимостей...
  call npm install
)
echo.
echo Сайт: http://localhost:3000
echo Демо-заказ: ТП-2026-0042
echo.
node server.js
pause
