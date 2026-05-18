# Claude Tracker

Vue **bento live** de tous tes agents Claude Code locaux. Lit directement
`~/.claude/projects/` (aucun MCP, aucune config côté Claude). Regroupe par
répertoire de travail réel, affiche statut/activité en temps réel, et permet
de poser statut/note/tags ou de supprimer un projet (vers une corbeille
récupérable).

## Lancer

```bash
cd ~/claude-tracker
bun server.js
```

Puis ouvrir **http://localhost:8787** (depuis Windows aussi : WSL2 forwarde
`localhost` automatiquement). Raccourci Windows : double-clic sur `launch.bat`.

Port personnalisable : `PORT=9000 bun server.js`.

## Ce que fait l'app

- **Scan performant** : seules la tête (~32 Ko) et la queue (~64 Ko) de chaque
  transcript sont lues, plus la date de modification. Un fichier de 95 Mo n'est
  jamais chargé en entier.
- **Live** : flux SSE, rescan toutes les 4 s, mise à jour des tuiles sans
  recharger la page. Bonus liveness via `/proc` (process `claude` actifs).
- **Tuile** : nom, chemin réel, branche git, type (SDK base36 / interactif),
  prompt initial + dernier prompt, sessions/sous-agents/todos, dernière
  activité, statut custom, note, tags.
- **Actions** : éditer statut/note/tags (stockés dans `data/overrides.json`,
  **jamais** dans `~/.claude`).

## Suppression (à lire)

« Supprimer » déplace vers `./.trash/<horodatage>__<projet>/` :

- `claude-history/` : le ou les dossiers `~/.claude/projects/<…>` du projet ;
- `workdir/` : **le vrai dossier de travail** (ex. `~/.base36/projects/xxx`) —
  donc le code/site lui-même ;
- `manifest.json` : chemins d'origine pour la restauration.

C'est **récupérable** (bouton Restaurer) tant que tu n'as pas purgé. Le bouton
**« Vider la corbeille »** (ou « Purger » par élément) supprime définitivement
et irréversiblement. La confirmation par saisie du nom du projet est exigée
avant tout déplacement.

## Structure

```
server.js        serveur Bun (127.0.0.1) : API, SSE, actions
lib/scan.js      lecture tête/queue jsonl + regroupement par cwd
lib/store.js     overrides (statut/note/tags) + corbeille
public/          page bento (HTML/CSS/JS, zéro build)
data/overrides.json   métadonnées utilisateur (créé au besoin)
.trash/          suppressions récupérables
```
