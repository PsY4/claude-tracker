@echo off
REM Claude Tracker - lanceur final (froid ET chaud).
REM
REM Architecture :
REM   launch.bat  : verifie si serveur up, sinon appelle launch.vbs,
REM                 puis poll jusqu'a 90s avant d'ouvrir le navigateur.
REM   launch.vbs  : trampoline qui lance wsl.exe + bun en hidden+detache
REM                 (WScript.Shell.Run cmd, 0, False). C'est le pattern
REM                 canonique Windows pour "console process sans console".
REM
REM Bugs anterieurs (tous corriges) :
REM  1) [ancien] Boucle d'attente 12s trop courte vs cold-boot WSL2.
REM  2) [ancien] Daemonisation "nohup bun &" cote WSL ne survit pas a
REM     wsl.exe -e qui se termine, surtout sur VM fraiche sans autre
REM     process anchor -> bun tue, VM eteinte.
REM  3) [V2 cassee] Start-Process -WindowStyle Hidden wsl.exe ne passe pas
REM     les arguments correctement -> bash n'est jamais execute, aucun log.
REM  4) [V2 cassee] "bash -lic" exige un TTY que Start-Process Hidden ne
REM     fournit pas -> bash exit immediatement.
REM  5) [V3 cassee] "bash -lc" (non-interactif) ne charge pas .bashrc, donc
REM     "bun" pas dans le PATH -> "bun: not found".
REM
REM Solution actuelle :
REM  - VBScript trampoline (wscript.exe -> wsl.exe) : passe les args
REM    correctement, fenetre cachee, detache.
REM  - bun en chemin ABSOLU : zero dependance au PATH du login shell.
REM  - bun en FOREGROUND : le process wsl.exe Windows reste actif tant que
REM    bun tourne -> ANCRE la VM WSL2 -> survit a tout cold-boot.
REM
REM Logs : \\wsl$\Debian\tmp\claude-tracker.log
set "VBS=%~dp0launch.vbs"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& { $u='http://127.0.0.1:8787'; $vbs='%VBS%'; function Up { try { (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }; if (-not (Up)) { Start-Process -WindowStyle Hidden -FilePath 'wscript.exe' -ArgumentList ('\"' + $vbs + '\"') }; $i=0; while ($i -lt 180 -and -not (Up)) { Start-Sleep -Milliseconds 500; $i++ }; Start-Process $u }"
exit
