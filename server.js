// Claude Tracker — serveur Bun (127.0.0.1 uniquement).
// API JSON + flux SSE live + actions (meta, suppression vers corbeille).
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { scanProjects, scanProjectDetail } from "./lib/scan.js";
import { computeProjectUsage } from "./lib/usage.js";
import {
  readOverrides,
  mergeOverrides,
  setOverride,
  trashProject,
  listTrash,
  restoreTrash,
  purgeTrash,
} from "./lib/store.js";

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = join(import.meta.dir, "public");

let lastProjects = [];
async function getProjects() {
  const [projects, overrides] = await Promise.all([scanProjects(), readOverrides()]);
  lastProjects = mergeOverrides(projects, overrides);
  return lastProjects;
}

const findProject = (projects, cwd) => projects.find((p) => p.cwd === cwd);

// Ouvre un nouvel onglet Windows Terminal dans le dossier du projet (chemin
// Linux). Lancé sans shell (argv array) → pas d'injection ; le cwd est
// validé en amont contre la liste des projets connus.
// runShell : commande FIXE (allowlist côté route), jamais une valeur libre.
function openTerminal(cwd, runShell) {
  const wt = Bun.which("wt.exe") || "wt.exe";
  const distro = process.env.WSL_DISTRO_NAME || "";
  const args = ["-w", "0", "nt", "--title", cwd.split("/").pop() || "projet"];
  args.push("wsl.exe");
  if (distro) args.push("-d", distro);
  args.push("--cd", cwd);
  if (runShell) {
    // login+interactif pour avoir le PATH de l'utilisateur (claude),
    // puis on rend la main à un shell quand la commande se termine.
    // NB: wt.exe traite ';' comme séparateur de commandes → on l'échappe
    // en '\;' pour qu'il soit transmis tel quel à bash.
    args.push("--", "bash", "-lic", `${runShell}\\; exec bash`);
  }
  const proc = Bun.spawn([wt, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  proc.unref();
  return proc;
}

// Ouvre une URL dans le navigateur Windows par défaut (Chrome chez Alex).
function openBrowser(url) {
  const proc = Bun.spawn(["cmd.exe", "/c", "start", "", url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
  return proc;
}

// --- SSE : un rescan toutes les 4 s poussé à tous les clients connectés ---
const clients = new Set();

function broadcast(data) {
  const chunk = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

async function tick() {
  if (clients.size === 0) return;
  try {
    broadcast({ type: "projects", projects: await getProjects() });
  } catch (e) {
    console.error("tick error", e);
  }
}
setInterval(tick, 4000);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

async function serveStatic(path) {
  const file = Bun.file(join(PUBLIC, path));
  if (await file.exists()) return new Response(file);
  return new Response("Not found", { status: 404 });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/") return serveStatic("index.html");
    if (pathname === "/app.js") return serveStatic("app.js");
    if (pathname === "/style.css") return serveStatic("style.css");
    if (pathname === "/favicon.svg") return serveStatic("favicon.svg");

    if (pathname === "/api/projects") {
      return json({ projects: await getProjects() });
    }

    if (pathname === "/api/project") {
      const cwd = url.searchParams.get("cwd");
      let proj = lastProjects.find((p) => p.cwd === cwd);
      if (!proj) proj = findProject(await getProjects(), cwd);
      if (!proj) return json({ error: "projet introuvable" }, 404);
      return json({ cwd, detail: await scanProjectDetail(proj.dirNames) });
    }

    if (pathname === "/api/usage") {
      const cwd = url.searchParams.get("cwd");
      let proj = lastProjects.find((p) => p.cwd === cwd);
      if (!proj) proj = findProject(await getProjects(), cwd);
      if (!proj) return json({ error: "projet introuvable" }, 404);
      return json({ cwd, usage: await computeProjectUsage(proj.dirNames) });
    }

    if (pathname === "/api/open-terminal" && req.method === "POST") {
      const { cwd, action } = await req.json();
      // allowlist : aucune commande arbitraire n'est exécutée
      const CMDS = { terminal: null, continue: "claude --continue" };
      if (!(action in CMDS))
        return json({ error: "action invalide" }, 400);
      let projects = lastProjects.length ? lastProjects : await getProjects();
      if (!findProject(projects, cwd))
        return json({ error: "projet inconnu" }, 400);
      try {
        const st = await stat(cwd);
        if (!st.isDirectory()) throw new Error("le dossier n'existe plus");
        openTerminal(cwd, CMDS[action]);
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e.message || e) }, 400);
      }
    }

    if (pathname === "/api/open-url" && req.method === "POST") {
      const { cwd } = await req.json();
      const projects = lastProjects.length ? lastProjects : await getProjects();
      const proj = findProject(projects, cwd);
      if (!proj) return json({ error: "projet inconnu" }, 400);
      // On n'ouvre que l'URL du repo connue du projet (jamais une URL libre).
      if (!proj.repoUrl || !/^https:\/\//.test(proj.repoUrl))
        return json({ error: "pas de remote git" }, 400);
      openBrowser(proj.repoUrl);
      return json({ ok: true, url: proj.repoUrl });
    }

    if (pathname === "/api/stream") {
      let self;
      const stream = new ReadableStream({
        start(controller) {
          self = controller;
          clients.add(controller);
          controller.enqueue(": connected\n\n");
          getProjects().then((projects) =>
            controller.enqueue(
              `data: ${JSON.stringify({ type: "projects", projects })}\n\n`
            )
          );
        },
        cancel() {
          clients.delete(self);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (pathname === "/api/meta" && req.method === "POST") {
      const body = await req.json();
      if (!body.cwd) return json({ error: "cwd requis" }, 400);
      const saved = await setOverride(body.cwd, body);
      await tick();
      return json({ ok: true, override: saved });
    }

    if (pathname === "/api/delete" && req.method === "POST") {
      const body = await req.json();
      const projects = await getProjects();
      const project = findProject(projects, body.cwd);
      if (!project) return json({ error: "projet introuvable" }, 404);
      try {
        const manifest = await trashProject(project, body.confirmName);
        await tick();
        return json({ ok: true, manifest });
      } catch (e) {
        return json({ error: String(e.message || e) }, 400);
      }
    }

    if (pathname === "/api/trash" && req.method === "GET") {
      return json({ trash: await listTrash() });
    }

    if (pathname === "/api/trash/restore" && req.method === "POST") {
      const { id } = await req.json();
      try {
        const manifest = await restoreTrash(id);
        await tick();
        return json({ ok: true, manifest });
      } catch (e) {
        return json({ error: String(e.message || e) }, 400);
      }
    }

    if (pathname === "/api/trash/purge" && req.method === "POST") {
      const { id } = await req.json().catch(() => ({}));
      try {
        await purgeTrash(id || null);
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e.message || e) }, 400);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  Claude Tracker → http://localhost:${PORT}\n`);
