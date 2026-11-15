@echo off
rem Roda os testes com Docker no Windows: run.bat [comando]. Sem comando, roda o "dev".
rem A logica fica no scripts\run.ps1 (PowerShell), que tambem mede memoria e CPU da API.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
exit /b %errorlevel%
