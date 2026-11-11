@echo off
cd /d "%~dp0orbit"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non trovato. Installalo una volta sola con questo comando e poi riapri questo file:
  echo   winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
where claude >nul 2>nul
if errorlevel 1 (
  echo Claude Code non trovato nel PATH. Controlla di riuscire a lanciare "claude" da PowerShell.
  pause
  exit /b 1
)
if defined ANTHROPIC_API_KEY echo ATTENZIONE: ANTHROPIC_API_KEY e impostata in Windows. Orbit la ignora, ma conviene rimuoverla.
if defined ANTHROPIC_AUTH_TOKEN echo ATTENZIONE: ANTHROPIC_AUTH_TOKEN e impostata in Windows. Orbit la ignora, ma conviene rimuoverla.
echo Avvio Orbit con il login del tuo abbonamento Claude. Lascia questa finestra aperta, chiudila per spegnere Orbit.
node server.js
pause
