// Scan de ~/.claude/projects : lecture tête/queue des transcripts (jamais en
// entier), regroupement par cwd réel, détection de liveness. Voir le plan.
import { readdir, stat, readlink, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
export const PROJECTS_DIR = join(HOME, ".claude", "projects");
const TODOS_DIR = join(HOME, ".claude", "todos");

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 64 * 1024;
const RUNNING_MS = 90 * 1000;
const RECENT_MS = 30 * 60 * 1000;

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* ligne tronquée (slice) — ignorée */
    }
  }
  return out;
}

// Extrait le texte lisible d'un message user/assistant, en ignorant les
// tool_result, tool_use et autres contenus non conversationnels.
function messageText(obj) {
  const m = obj?.message;
  if (!m) return null;
  const c = m.content;
  if (typeof c === "string") return c.trim() || null;
  if (Array.isArray(c)) {
    const parts = c
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text.trim())
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return null;
}

function isRealUserPrompt(obj) {
  if (obj?.type !== "user") return false;
  if (obj?.isMeta) return false;
  const c = obj?.message?.content;
  if (Array.isArray(c) && c.some((p) => p && p.type === "tool_result")) return false;
  return messageText(obj) != null;
}

// Messages utilisateur injectés par le harness (commandes locales, rappels
// système, caveats) — pas la vraie demande de l'utilisateur.
const BOILERPLATE = [
  /^<local-command-caveat>/i,
  /^Caveat: The messages below were generated/i,
  /^<command-(name|message|args)>/i,
  /^<system-reminder>/i,
  /^<user-(memory|prompt-submit-hook)/i,
  /^\[Request interrupted/i,
  /^<bash-(input|stdout|stderr)>/i,
  /^<local-command-stdout>/i,
  /^<task-notification>/i,
  /^\[SYSTEM NOTIFICATION/i,
];

function isBoilerplate(text) {
  if (!text) return true;
  const t = text.trim();
  return BOILERPLATE.some((re) => re.test(t));
}

// Si le message contient une invocation de slash-command, on en extrait un
// libellé lisible plutôt que d'afficher le bloc <command-*> brut.
function readablePrompt(text) {
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/i);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/i);
    return `/${cmd[1].trim()}${args && args[1].trim() ? " " + args[1].trim() : ""}`;
  }
  return text;
}

// Premier message user qui est une vraie demande (ou nom de commande),
// en sautant le boilerplate. Repli sur le boilerplate si rien d'autre.
function pickFirstPrompt(objs) {
  let fallback = null;
  for (const o of objs) {
    if (!isRealUserPrompt(o)) continue;
    const txt = messageText(o);
    if (isBoilerplate(txt)) {
      const r = readablePrompt(txt);
      if (r !== txt && !fallback) fallback = r; // garde le /command lisible
      else if (!fallback) fallback = txt;
      continue;
    }
    return txt;
  }
  return fallback;
}

async function readHead(path) {
  const text = await Bun.file(path).slice(0, HEAD_BYTES).text();
  const objs = parseLines(text);
  const meta = {};
  for (const o of objs) {
    if (!meta.cwd && o.cwd) {
      meta.cwd = o.cwd;
      meta.gitBranch = o.gitBranch || null;
      meta.version = o.version || null;
      meta.entrypoint = o.entrypoint || null;
      meta.sessionId = o.sessionId || null;
      break;
    }
  }
  meta.firstPrompt = pickFirstPrompt(objs);
  return meta;
}

async function readTail(path, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const text = await Bun.file(path).slice(start).text();
  const objs = parseLines(text);
  let lastPrompt = null; // dernier message significatif (user OU agent)
  let lastRole = null; // "user" | "assistant"
  let lastTs = null;
  for (const o of objs) {
    if (o.timestamp) lastTs = o.timestamp;
    if (isRealUserPrompt(o)) {
      const t = messageText(o);
      if (!isBoilerplate(t)) {
        lastPrompt = t;
        lastRole = "user";
      }
    } else if (o?.type === "assistant" && !o?.isMeta) {
      const t = messageText(o); // null si message uniquement tool_use
      if (t && !isBoilerplate(t)) {
        lastPrompt = t;
        lastRole = "assistant";
      }
    }
  }
  return { lastPrompt, lastRole, lastTs };
}

// Map cwd -> true pour les process `claude` réellement vivants (Linux /proc).
async function liveCwds() {
  const live = new Set();
  try {
    const pids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p));
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
          if (!cmd.includes("claude")) return;
          const cwd = await readlink(`/proc/${pid}/cwd`);
          if (cwd) live.add(cwd);
        } catch {
          /* process disparu / permission — ignoré */
        }
      })
    );
  } catch {
    /* pas de /proc (non-Linux) — liveness basée sur mtime uniquement */
  }
  return live;
}

async function todoCount(sessionId) {
  if (!sessionId) return null;
  try {
    const files = await readdir(TODOS_DIR);
    const match = files.find((f) => f.startsWith(sessionId));
    if (!match) return null;
    const items = JSON.parse(await readFile(join(TODOS_DIR, match), "utf8"));
    if (!Array.isArray(items)) return null;
    const open = items.filter((t) => t && t.status !== "completed").length;
    const last = items.length ? items[items.length - 1] : null;
    return { open, total: items.length, last: last?.content || last?.activeForm || null };
  } catch {
    return null;
  }
}

function liveness(lastActivityMs, isLive) {
  if (isLive) return "running";
  const age = Date.now() - lastActivityMs;
  if (age < RUNNING_MS) return "running";
  if (age < RECENT_MS) return "recent";
  return "idle";
}

// Renvoie la liste agrégée des projets, regroupés par cwd réel.
export async function scanProjects() {
  let entries = [];
  try {
    entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const live = await liveCwds();
  const byCwd = new Map();

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dirName = ent.name;
    const dirPath = join(PROJECTS_DIR, dirName);

    let dirEntries;
    try {
      dirEntries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const jsonls = dirEntries.filter((d) => d.isFile() && d.name.endsWith(".jsonl"));
    if (jsonls.length === 0) continue;
    const subdirs = await countSubAgents(dirPath, dirEntries);

    // Métadonnées : on s'appuie sur la session la plus récemment modifiée.
    const sessions = [];
    for (const j of jsonls) {
      const p = join(dirPath, j.name);
      try {
        const st = await stat(p);
        sessions.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* fichier disparu en cours de scan */
      }
    }
    if (sessions.length === 0) continue;
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = sessions[0];
    const lastActivityMs = sessions[0].mtimeMs;

    const head = await readHead(newest.path);
    const tail = await readTail(newest.path, newest.size);
    const cwd = head.cwd || decodeDirName(dirName);
    const todos = await todoCount(head.sessionId);
    const repoUrl = await gitWebUrl(cwd);

    const project = {
      cwd,
      name: cwd.split("/").filter(Boolean).pop() || cwd,
      dirNames: [dirName],
      gitBranch: head.gitBranch,
      repoUrl,
      version: head.version,
      kind: head.entrypoint === "sdk-cli" ? "sdk" : "interactive",
      firstPrompt: head.firstPrompt || null,
      lastPrompt: tail.lastPrompt || null,
      lastRole: tail.lastRole || null,
      lastTs: tail.lastTs || new Date(lastActivityMs).toISOString(),
      lastActivityMs,
      sessions: jsonls.length,
      subAgents: subdirs,
      todos,
      status: liveness(lastActivityMs, live.has(cwd)),
    };

    // Fusion si plusieurs dossiers ~/.claude/projects pointent le même cwd.
    const existing = byCwd.get(cwd);
    if (existing) {
      existing.dirNames.push(dirName);
      existing.sessions += project.sessions;
      existing.subAgents += project.subAgents;
      if (project.lastActivityMs > existing.lastActivityMs) {
        Object.assign(existing, {
          gitBranch: project.gitBranch,
          repoUrl: project.repoUrl,
          version: project.version,
          kind: project.kind,
          firstPrompt: existing.firstPrompt || project.firstPrompt,
          lastPrompt: project.lastPrompt,
          lastRole: project.lastRole,
          lastTs: project.lastTs,
          lastActivityMs: project.lastActivityMs,
          todos: project.todos,
          status: project.status,
          dirNames: existing.dirNames,
          sessions: existing.sessions,
          subAgents: existing.subAgents,
        });
      }
    } else {
      byCwd.set(cwd, project);
    }
  }

  return [...byCwd.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

// Décodage best-effort d'un nom de dossier slugifié (fallback si pas de cwd).
function decodeDirName(d) {
  return d.replace(/^-/, "/").replace(/-/g, "/");
}

// Convertit une URL de remote git en URL web ouvrable dans un navigateur.
//  git@github.com:owner/repo.git        -> https://github.com/owner/repo
//  ssh://git@github.com/owner/repo.git  -> https://github.com/owner/repo
//  https://github.com/owner/repo.git    -> https://github.com/owner/repo
function normHost(h) {
  h = h.replace(/:\d+$/, ""); // retire un éventuel :port
  return h.replace(/^ssh\.(github|gitlab|bitbucket)\./, "$1."); // ssh.github.com -> github.com
}
export function gitRemoteToWeb(raw) {
  if (!raw) return null;
  let u = raw.trim().replace(/\.git$/, "");
  let m = u.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i); // proto://host/path
  if (m) return `https://${normHost(m[1])}/${m[2]}`;
  m = u.match(/^[^@]+@([^:]+):(.+)$/); // scp-like git@host:path
  if (m) return `https://${normHost(m[1])}/${m[2]}`;
  return null;
}

// Remote git du projet, résolu via `git -C` (gère worktrees/submodules).
// Mis en cache par cwd : git n'est appelé qu'une fois par projet (les
// remotes ne changent quasiment jamais), pas à chaque scan de 4 s.
const remoteCache = new Map();
async function gitWebUrl(cwd) {
  if (remoteCache.has(cwd)) return remoteCache.get(cwd);
  let web = null;
  try {
    const proc = Bun.spawn(
      ["git", "-C", cwd, "remote", "get-url", "origin"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (proc.exitCode === 0) web = gitRemoteToWeb(out);
  } catch {
    /* git absent, pas un repo, ou cwd inexistant */
  }
  remoteCache.set(cwd, web);
  return web;
}

const isAgentJsonl = (n) => /^agent-.*\.jsonl$/.test(n);

// Compte les sous-agents : projet/<sessionUuid>/subagents/agent-*.jsonl
async function countSubAgents(dirPath, dirEntries) {
  let n = 0;
  for (const d of dirEntries) {
    if (!d.isDirectory()) continue;
    try {
      const sub = await readdir(join(dirPath, d.name, "subagents"));
      n += sub.filter(isAgentJsonl).length;
    } catch {
      /* pas de dossier subagents */
    }
  }
  return n;
}

// Comptage de lignes (≈ nb d'entrées du transcript) en streaming :
// mémoire bornée même pour un fichier de 95 Mo.
async function countRecords(path) {
  try {
    const stream = Bun.file(path).stream();
    let n = 0;
    for await (const chunk of stream) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) n++;
    }
    return n;
  } catch {
    return null;
  }
}

function firstTs(objs) {
  for (const o of objs) if (o.timestamp) return o.timestamp;
  return null;
}

// Lecture détaillée d'une session (head + tail uniquement).
async function readSession(filePath, mtimeMs, size) {
  const headText = await Bun.file(filePath).slice(0, HEAD_BYTES).text();
  const headObjs = parseLines(headText);
  const tail = await readTail(filePath, size);
  return {
    startTs: firstTs(headObjs),
    firstPrompt: pickFirstPrompt(headObjs),
    lastTs: tail.lastTs,
    lastPrompt: tail.lastPrompt,
    lastRole: tail.lastRole,
    lastActivityMs: mtimeMs,
    sizeBytes: size,
    records: await countRecords(filePath),
  };
}

async function readSubAgent(saDir, file) {
  const p = join(saDir, file);
  const base = file.replace(/\.jsonl$/, "");
  let agentType = null;
  try {
    agentType = JSON.parse(
      await readFile(join(saDir, base + ".meta.json"), "utf8")
    ).agentType;
  } catch {
    /* pas de meta */
  }
  let task = null;
  let mtimeMs = 0;
  let size = 0;
  try {
    const st = await stat(p);
    mtimeMs = st.mtimeMs;
    size = st.size;
    const objs = parseLines(await Bun.file(p).slice(0, HEAD_BYTES).text());
    task = pickFirstPrompt(objs);
  } catch {
    /* fichier illisible */
  }
  return {
    id: base.replace(/^agent-/, ""),
    agentType: agentType || "agent",
    task,
    lastActivityMs: mtimeMs,
    records: await countRecords(p),
  };
}

// Scan profond d'un projet (toutes ses sessions + sous-agents), à la demande.
export async function scanProjectDetail(dirNames) {
  const sessions = [];
  for (const dirName of dirNames) {
    const dirPath = join(PROJECTS_DIR, dirName);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const withTranscript = new Set();

    async function collectSubAgents(id) {
      const subAgents = [];
      try {
        const saDir = join(dirPath, id, "subagents");
        const saFiles = (await readdir(saDir)).filter(isAgentJsonl);
        for (const f of saFiles) subAgents.push(await readSubAgent(saDir, f));
        subAgents.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
      } catch {
        /* pas de sous-agents */
      }
      return subAgents;
    }

    // 1) sessions avec transcript principal
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const id = e.name.replace(/\.jsonl$/, "");
      const filePath = join(dirPath, e.name);
      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue;
      }
      withTranscript.add(id);
      const info = await readSession(filePath, st.mtimeMs, st.size);
      sessions.push({
        id,
        dirName,
        ...info,
        subAgents: await collectSubAgents(id),
      });
    }

    // 2) sessions « orphelines » (compactées) : dossier sans .jsonl principal
    //    mais avec des sous-agents — pour que le total reste cohérent.
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "memory") continue;
      if (withTranscript.has(e.name)) continue;
      const subAgents = await collectSubAgents(e.name);
      if (!subAgents.length) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(join(dirPath, e.name, "subagents"))).mtimeMs;
      } catch {
        /* ignore */
      }
      sessions.push({
        id: e.name,
        dirName,
        orphan: true,
        startTs: null,
        firstPrompt: null,
        lastTs: null,
        lastPrompt: null,
        lastRole: null,
        lastActivityMs: mtimeMs,
        sizeBytes: 0,
        records: null,
        subAgents,
      });
    }
  }
  sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return { sessions };
}
