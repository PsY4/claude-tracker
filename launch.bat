@echo off
REM Claude Tracker — lanceur robuste au demarrage a FROID (le matin).
REM
REM Pourquoi l'ancienne version cassait le matin :
REM  - Bug A : boucle d'attente de 12 s trop courte vs boot WSL2 a froid
REM            -> le navigateur s'ouvrait avant bun -> ERR_CONNECTION_REFUSED.
REM  - Bug B : bun lance en "nohup &" derriere "wsl.exe -e" qui se termine ;
REM            sur une VM fraiche sans autre process, WSL2 eteint la VM et
REM            tue bun (en journee tes agents Claude maintenaient la VM).
REM
REM Fix : on lance le serveur via UN process wsl.exe NON attendu et NON
REM backgrounde (exec bun). Ce process reste vivant tant que le serveur
REM tourne -> il ANCRE la VM lui-meme. Puis on poll cote Windows jusqu'a
REM 90 s AVANT d'ouvrir le navigateur. Idempotent. Aucune fenetre visible.
REM Logs serveur : \\wsl$\Debian\tmp\claude-tracker.log
powershell -NoProfile -WindowStyle Hidden -Command ^
 "$u='http://127.0.0.1:8787';" ^
 "function Up { try { (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }" ^
 "if (-not (Up)) { Start-Process -WindowStyle Hidden -FilePath wsl.exe -ArgumentList '-d','Debian','-e','bash','-lic','cd ~/claude-tracker && exec bun server.js >/tmp/claude-tracker.log 2>&1' }" ^
 "for ($i=0; $i -lt 180; $i++) { if (Up) { break }; Start-Sleep -Milliseconds 500 }" ^
 "Start-Process 'http://localhost:8787'"
exit
