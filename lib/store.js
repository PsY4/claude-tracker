// Sidecar local : overrides utilisateur (statut/note/tags) + corbeille
// récupérable. Rien n'est écrit dans ~/.claude sauf le déplacement vers .trash
// lors d'une suppression explicitement confirmée.
import { mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { $ } from "bun";
import { PROJECTS_DIR } from "./scan.js";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const OVERRIDES_FILE = join(DATA_DIR, "overrides.json");
const TRASH_DIR = join(ROOT, ".trash");

async function ensureDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(TRASH_DIR, { recursive: true });
}

export async function readOverrides() {
  try {
    return JSON.parse(await readFile(OVERRIDES_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Met à jour le triplet { status, note, tags } pour un cwd donné.
export async function setOverride(cwd, patch) {
  await ensureDirs();
  const all = await readOverrides();
  const cur = all[cwd] || {};
  if (patch.name !== undefined) cur.name = String(patch.name).trim() || null;
  if (patch.status !== undefined) cur.status = patch.status || null;
  if (patch.note !== undefined) cur.note = patch.note || null;
  if (patch.tags !== undefined)
    cur.tags = Array.isArray(patch.tags)
      ? patch.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
  all[cwd] = cur;
  await writeFile(OVERRIDES_FILE, JSON.stringify(all, null, 2));
  return cur;
}

export function mergeOverrides(projects, overrides) {
  return projects.map((p) => {
    const o = overrides[p.cwd] || {};
    return {
      ...p,
      displayName: o.name || null,
      userStatus: o.status || null,
      note: o.note || null,
      tags: o.tags || [],
    };
  });
}

const slug = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// Déplace l'historique Claude (un ou plusieurs dossiers ~/.claude/projects)
// ET le dossier de travail réel vers .trash/<ts>__<slug>/, avec un manifest
// permettant la restauration. `mv` (Bun shell) gère le cross-device (/data).
export async function trashProject(project, confirmName) {
  if (!project) throw new Error("projet introuvable");
  if (confirmName !== project.name)
    throw new Error("le nom de confirmation ne correspond pas");
  await ensureDirs();

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${ts}__${slug(project.name)}`;
  const dest = join(TRASH_DIR, id);
  const histDest = join(dest, "claude-history");
  await mkdir(histDest, { recursive: true });

  const manifest = {
    id,
    cwd: project.cwd,
    name: project.name,
    deletedAt: new Date().toISOString(),
    claudeHistory: [],
    workdir: null,
  };

  for (const dirName of project.dirNames) {
    const src = join(PROJECTS_DIR, dirName);
    if (await pathExists(src)) {
      await $`mv ${src} ${join(histDest, dirName)}`.quiet();
      manifest.claudeHistory.push(dirName);
    }
  }

  if (project.cwd && (await pathExists(project.cwd))) {
    const wd = join(dest, "workdir");
    await $`mv ${project.cwd} ${wd}`.quiet();
    manifest.workdir = project.cwd;
  }

  await writeFile(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));

  // L'override n'est plus pertinent une fois supprimé.
  const all = await readOverrides();
  if (all[project.cwd]) {
    delete all[project.cwd];
    await writeFile(OVERRIDES_FILE, JSON.stringify(all, null, 2));
  }
  return manifest;
}

export async function listTrash() {
  await ensureDirs();
  let entries = [];
  try {
    entries = await readdir(TRASH_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const m = JSON.parse(
        await readFile(join(TRASH_DIR, e.name, "manifest.json"), "utf8")
      );
      const st = await stat(join(TRASH_DIR, e.name));
      out.push({ ...m, sizeKnown: true, trashedMtime: st.mtimeMs });
    } catch {
      out.push({ id: e.name, name: e.name, broken: true });
    }
  }
  return out.sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
}

export async function restoreTrash(id) {
  const dir = join(TRASH_DIR, id);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  for (const dirName of manifest.claudeHistory || []) {
    const src = join(dir, "claude-history", dirName);
    const target = join(PROJECTS_DIR, dirName);
    if ((await pathExists(src)) && !(await pathExists(target)))
      await $`mv ${src} ${target}`.quiet();
  }
  if (manifest.workdir) {
    const src = join(dir, "workdir");
    if ((await pathExists(src)) && !(await pathExists(manifest.workdir)))
      await $`mv ${src} ${manifest.workdir}`.quiet();
  }
  await rm(dir, { recursive: true, force: true });
  return manifest;
}

// Purge définitive : suppression irrécupérable du contenu de .trash/.
export async function purgeTrash(id) {
  if (id) {
    if (basename(id) !== id) throw new Error("id invalide");
    await rm(join(TRASH_DIR, id), { recursive: true, force: true });
    return;
  }
  for (const e of await readdir(TRASH_DIR)) {
    await rm(join(TRASH_DIR, e), { recursive: true, force: true });
  }
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
