' Trampoline Windows -> WSL2.
' WScript.Shell.Run(cmd, intWindowStyle=0, bWaitOnReturn=False) :
'   - 0 = fenetre cachee
'   - False = retour immediat (process detache du wscript.exe parent)
' Pattern canonique pour daemoniser un binaire console sans console visible.
'
' Pourquoi bun en chemin ABSOLU :
'   bash -lc (non-interactif) source .profile -> .bashrc, mais .bashrc
'   quitte tot en non-interactif via "case $- in *i*) ;; *) return ;; esac"
'   -> ~/.bun/bin n'est jamais ajoute au PATH -> "bun: not found".
'   On contourne avec le chemin absolu : zero dependance a l'env shell.
'
' Pourquoi PAS de daemonisation (setsid/nohup &) cote WSL :
'   Sur WSL2, un process detache via setsid ne survit PAS a la sortie de
'   "wsl.exe -e bash" qui l'a lance. La seule maniere de garder bun en vie
'   est de garder wsl.exe lui-meme en vie -> bun tourne en FOREGROUND ici
'   (exec), et le process wsl.exe Windows reste vivant tant que bun tourne
'   et ANCRE la VM (la VM ne s'eteint pas s'il y a un wsl.exe actif).
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -d Debian -e bash -lc ""cd ~/claude-tracker && exec /home/psy4meuh/.bun/bin/bun server.js >/tmp/claude-tracker.log 2>&1""", 0, False
