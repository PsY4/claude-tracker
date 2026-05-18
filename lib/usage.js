// Agrégation d'usage par projet : tokens, coût (estimé), durée de génération,
// changements de code, ventilation par modèle. Lecture COMPLÈTE des
// transcripts → cache disque par fichier (clé taille+mtime), calcul à la
// demande seulement (jamais dans le scan périodique).
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PROJECTS_DIR } from "./scan.js";

const CACHE_FILE = join(import.meta.dir, "..", "data", "usage-cache.json");
// Bump si la logique d'agrégation change → invalide les entrées en cache.
const CACHE_VERSION = 2;

// Tarifs publics USD / 1M tokens (éditable). Cache write 5m = in×1.25,
// cache write 1h = in×2, cache read = in×0.1 (convention Anthropic).
const PRICING = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
};
function modelTier(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null; // <synthetic>, inconnu → pas de coût
}

function emptyAgg() {
  return { durMs: 0, codeAdd: 0, codeDel: 0, codeEdits: 0, byModel: {} };
}
function bucket(agg, model) {
  return (agg.byModel[model] ??= {
    msgs: 0,
    in: 0,
    out: 0,
    cw5: 0, // cache creation 5m
    cw1h: 0, // cache creation 1h
    cr: 0, // cache read
  });
}

const lineCount = (s) => (typeof s === "string" && s ? s.split("\n").length : 0);

// Comptage des changements de code d'un message assistant (tool_use).
function accountCodeChanges(agg, content) {
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (!c || c.type !== "tool_use") continue;
    const inp = c.input || {};
    if (c.name === "Write") {
      agg.codeEdits++;
      agg.codeAdd += lineCount(inp.content);
    } else if (c.name === "Edit") {
      agg.codeEdits++;
      agg.codeDel += lineCount(inp.old_string);
      agg.codeAdd += lineCount(inp.new_string);
    } else if (c.name === "MultiEdit" && Array.isArray(inp.edits)) {
      agg.codeEdits++;
      for (const e of inp.edits) {
        agg.codeDel += lineCount(e.old_string);
        agg.codeAdd += lineCount(e.new_string);
      }
    } else if (c.name === "NotebookEdit") {
      agg.codeEdits++;
      agg.codeAdd += lineCount(inp.new_source);
    }
  }
}

// Parcourt un .jsonl en streaming (mémoire bornée) et agrège l'usage.
async function streamAggregate(filePath) {
  const agg = emptyAgg();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (line) => {
    const t = line.trim();
    if (!t || t[0] !== "{") return;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      return;
    }
    // Durée réelle de génération : lignes system "turn_duration".
    if (o.type === "system" && o.subtype === "turn_duration") {
      if (typeof o.durationMs === "number") agg.durMs += o.durationMs;
      return;
    }
    if (o.type !== "assistant" || !o.message) return;
    accountCodeChanges(agg, o.message.content);
    const u = o.message.usage;
    if (!u) return;
    const b = bucket(agg, o.message.model || "unknown");
    b.msgs++;
    b.in += u.input_tokens || 0;
    b.out += u.output_tokens || 0;
    b.cr += u.cache_read_input_tokens || 0;
    const cc = u.cache_creation;
    if (cc) {
      b.cw5 += cc.ephemeral_5m_input_tokens || 0;
      b.cw1h += cc.ephemeral_1h_input_tokens || 0;
    } else {
      b.cw5 += u.cache_creation_input_tokens || 0;
    }
  };
  try {
    for await (const chunk of Bun.file(filePath).stream()) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) handle(buf);
  } catch {
    /* fichier illisible */
  }
  return agg;
}

async function loadCache() {
  try {
    const c = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (c.__v !== CACHE_VERSION) return { __v: CACHE_VERSION };
    return c;
  } catch {
    return { __v: CACHE_VERSION };
  }
}

// Liste tous les .jsonl d'un projet : sessions + sous-agents.
async function projectFiles(dirNames) {
  const files = [];
  for (const dirName of dirNames) {
    const dirPath = join(PROJECTS_DIR, dirName);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        files.push(join(dirPath, e.name));
      } else if (e.isDirectory() && e.name !== "memory") {
        try {
          const saDir = join(dirPath, e.name, "subagents");
          for (const f of await readdir(saDir))
            if (/^agent-.*\.jsonl$/.test(f)) files.push(join(saDir, f));
        } catch {
          /* pas de subagents */
        }
      }
    }
  }
  return files;
}

// Évite les recalculs concurrents du même projet.
const inflight = new Map();

export function computeProjectUsage(dirNames) {
  const key = dirNames.join("|");
  if (inflight.has(key)) return inflight.get(key);
  const p = _compute(dirNames).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function _compute(dirNames) {
  const cache = await loadCache();
  const files = await projectFiles(dirNames);
  const total = emptyAgg();
  let cacheDirty = false;

  for (const fp of files) {
    let st;
    try {
      st = await stat(fp);
    } catch {
      continue;
    }
    const c = cache[fp];
    let agg;
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) {
      agg = c.agg;
    } else {
      agg = await streamAggregate(fp);
      cache[fp] = { size: st.size, mtimeMs: st.mtimeMs, agg };
      cacheDirty = true;
    }
    total.durMs += agg.durMs;
    total.codeAdd += agg.codeAdd;
    total.codeDel += agg.codeDel;
    total.codeEdits += agg.codeEdits;
    for (const [model, b] of Object.entries(agg.byModel)) {
      const t = bucket(total, model);
      t.msgs += b.msgs;
      t.in += b.in;
      t.out += b.out;
      t.cw5 += b.cw5;
      t.cw1h += b.cw1h;
      t.cr += b.cr;
    }
  }

  if (cacheDirty) {
    try {
      await writeFile(CACHE_FILE, JSON.stringify(cache));
    } catch {
      /* cache best-effort */
    }
  }

  // Coût + totaux à partir des buckets bruts.
  let totalTokens = 0;
  let costUSD = 0;
  const byModel = [];
  for (const [model, b] of Object.entries(total.byModel)) {
    const tokens = b.in + b.out + b.cw5 + b.cw1h + b.cr;
    totalTokens += tokens;
    const tier = modelTier(model);
    let cost = 0;
    if (tier) {
      const pr = PRICING[tier];
      cost =
        (b.in / 1e6) * pr.in +
        (b.out / 1e6) * pr.out +
        (b.cw5 / 1e6) * pr.in * 1.25 +
        (b.cw1h / 1e6) * pr.in * 2 +
        (b.cr / 1e6) * pr.in * 0.1;
    }
    costUSD += cost;
    byModel.push({ model, msgs: b.msgs, tokens, cost, ...b });
  }
  byModel.sort((a, b) => b.tokens - a.tokens);

  return {
    totalTokens,
    costUSD,
    durationMs: total.durMs,
    codeChanges: {
      additions: total.codeAdd,
      deletions: total.codeDel,
      edits: total.codeEdits,
    },
    byModel,
    filesParsed: files.length,
  };
}
