@echo off
REM Lance Claude Tracker SANS laisser de fenêtre ouverte.
REM Le serveur est démonifié DANS WSL (nohup &) : il survit à la fermeture
REM du lanceur. Idempotent (ne relance pas s'il tourne déjà). On ATTEND que
REM le serveur réponde avant d'ouvrir le navigateur (pas d'ERR_CONNECTION).
REM Logs serveur : \\wsl$\Debian\tmp\claude-tracker.log
powershell -NoProfile -WindowStyle Hidden -Command ^
 "Start-Process -Wait -WindowStyle Hidden -FilePath wsl.exe -ArgumentList '-e','bash','-lic','curl -s -m1 -o /dev/null http://127.0.0.1:8787 || (cd ~/claude-tracker && nohup bun server.js >/tmp/claude-tracker.log 2>&1 &) ; for i in $(seq 1 40); do curl -s -m1 -o /dev/null http://127.0.0.1:8787 && exit 0; sleep 0.3; done'; Start-Process 'http://localhost:8787'"
exit
