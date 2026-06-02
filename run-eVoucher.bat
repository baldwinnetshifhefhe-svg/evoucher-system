@echo off
cd /d "%~dp0"
echo ==================================================
echo    e-Voucher System - Department of Agriculture
echo ==================================================
echo.
echo    Opening http://localhost:3000 in your browser...
echo    KEEP THIS WINDOW OPEN while using the system.
echo    Close this window to stop the system.
echo.
timeout /t 1 >nul
start http://localhost:3000
node --no-warnings server.js
pause
