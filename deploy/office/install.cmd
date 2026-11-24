@echo off
rem Double-click to install / update the nukyok Express agent (asks for admin first).
rem Opened from inside the zip, Windows copies this file alone to a temp folder.
if not exist "%~dp0install.ps1" (echo Extract the zip first: right-click it, Extract All, then run install.cmd from the new folder. & pause & exit /b 1)
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
