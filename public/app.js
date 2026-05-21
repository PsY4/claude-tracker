"use strict";

let PROJECTS = [];
let current = null; // projet ciblé par une modale

// Blocs prompt/réponse : pliés par défaut, état PAR CARTE persisté navigateur
// (set des cwd dépliés).
const promptOpen = new Set(
  JSON.parse(localStorage.getItem("ct.promptOpen") || "[]")
);
function savePromptOpen() {
  localStorage.setItem("ct.promptOpen", JSON.stringify([...promptOpen]));
}
function togglePrompts(cwd) {
  if (promptOpen.has(cwd)) promptOpen.delete(cwd);
  else promptOpen.add(cwd);
  savePromptOpen();
  render(true);
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );

function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return "à l'instant";
  if (d < 3600000) return `il y a ${Math.floor(d / 60000)} min`;
  if (d < 86400000) return `il y a ${Math.floor(d / 3600000)} h`;
  return `il y a ${Math.floor(d / 86400000)} j`;
}

function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 3200);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || r.statusText);
  return data;
}

// ---- Rendu bento -------------------------------------------------------
function cardHeight(p) {
  // tuiles plus grandes pour les projets actifs / riches en contenu
  let rows = 17;
  if (p.status === "running") rows += 5;
  else if (p.status === "recent") rows += 2;
  if (p.firstPrompt) rows += 6;
  if (p.note) rows += 3;
  if (p.lastPrompt && p.lastPrompt !== p.firstPrompt) rows += 9;
  if (p.tags && p.tags.length) rows += 2;
  return rows;
}

let lastSig = "";
function render(force) {
  // Évite de reconstruire la grille (et de perdre scroll/détail) toutes les
  // 4 s quand rien n'a changé.
  const sig = JSON.stringify(
    PROJECTS.map((p) => [
      promptOpen.has(p.cwd), p.cwd, p.status, p.lastActivityMs, p.lastPrompt, p.userStatus, p.displayName, p.repoUrl,
      p.note, (p.tags || []).join(","), [...expanded], detailCache.size,
    ])
  );
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const q = $("search").value.trim().toLowerCase();
  const f = $("filter").value;
  const grid = $("grid");
  grid.innerHTML = "";

  const list = PROJECTS.filter((p) => {
    if (f && p.status !== f) return false;
    if (!q) return true;
    const hay = [
      p.name, p.displayName, p.cwd, p.firstPrompt, p.lastPrompt, p.note,
      p.userStatus, (p.tags || []).join(" "), p.gitBranch,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  $("empty").hidden = list.length > 0;

  for (const p of list) {
    const el = document.createElement("article");
    el.className = `card ${p.status}`;
    el.style.gridRow = `span ${cardHeight(p)}`;

    const todos = p.todos
      ? `${p.todos.open}/${p.todos.total} todos`
      : null;
    const isOpen = expanded.has(p.cwd);
    const hasPrompts = !!(p.firstPrompt || p.lastPrompt);
    const promptsShown = promptOpen.has(p.cwd);
    const metaBits = [
      `${p.sessions} session${p.sessions > 1 ? "s" : ""}`,
      p.subAgents ? `${p.subAgents} sous-agents` : null,
      todos,
      ago(p.lastActivityMs),
    ].filter(Boolean);

    el.innerHTML = `
      <div class="top${hasPrompts ? " ptoggle" : ""}"${hasPrompts ? ` title="${promptsShown ? "masquer" : "afficher"} le prompt / la réponse"` : ""}>
        ${hasPrompts ? `<span class="pchev">${promptsShown ? "▾" : "▸"}</span>` : ""}
        <h3>${esc(p.displayName || p.name)}</h3>
        <span class="dot ${p.status}" title="${p.status}"></span>
      </div>
      <div class="path">${esc(p.cwd)}</div>
      <div class="badges">
        <span class="badge ${p.kind === "sdk" ? "sdk" : ""}">${p.kind === "sdk" ? "SDK base36" : "interactif"}</span>
        ${p.gitBranch ? `<span class="badge git">⎇ ${esc(p.gitBranch)}</span>` : ""}
        ${p.userStatus ? `<span class="badge ustatus">${esc(p.userStatus)}</span>` : ""}
        ${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
      </div>
      ${promptsShown && p.firstPrompt ? `<div class="prompt"><b>prompt dernière session</b>${esc(p.firstPrompt).slice(0, 700)}</div>` : ""}
      ${promptsShown && p.lastPrompt && p.lastPrompt !== p.firstPrompt ? `<div class="prompt"><b>${p.lastRole === "assistant" ? "dernière réponse" : "dernier prompt"}</b>${esc(p.lastPrompt).slice(0, 700)}</div>` : ""}
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}
      <div class="meta-line toggle" title="voir le détail des sessions et sous-agents">
        <span class="chev">${isOpen ? "▾" : "▸"}</span>
        ${metaBits.map((m) => `<span>${esc(m)}</span>`).join("")}
      </div>
      ${isOpen ? `<div class="detail">${detailCache.get(p.cwd) || '<div class="det-loading">chargement du détail…</div>'}</div>` : ""}
      <div class="meta-line usage-line" data-cwd="${esc(p.cwd)}" title="usage : tokens · coût estimé · temps de génération — cliquer pour le détail">
        <span class="chev">${usageOpen.has(p.cwd) ? "▾" : "▸"}</span>
        ${usageSummary(p.cwd)}
      </div>
      ${usageOpen.has(p.cwd) ? `<div class="detail usage-detail">${usageDetailHTML(p.cwd)}</div>` : ""}
      <div class="row-actions">
        <button class="ghost" data-act="folder" title="ouvrir le dossier dans l'explorateur Windows">🗁</button>
        <button class="ghost" data-act="term" title="ouvrir un terminal Windows ici">▸_</button>
        <button class="ghost" data-act="cont" title="ouvrir un terminal ici et lancer claude --continue">⏵</button>
        ${p.repoUrl ? `<button class="ghost" data-act="gh" title="ouvrir le dépôt : ${esc(p.repoUrl)}">⎇↗</button>` : ""}
        <button class="ghost" data-act="edit" title="statut / note / tags">✎</button>
        <button class="ghost" data-act="del" title="supprimer le projet">🗑</button>
      </div>`;

    el.querySelector('[data-act="folder"]').onclick = () => openFolder(p.cwd);
    el.querySelector('[data-act="term"]').onclick = () => openTerminal(p.cwd);
    el.querySelector('[data-act="cont"]').onclick = () => openTerminal(p.cwd, "continue");
    el.querySelector('[data-act="gh"]')?.addEventListener("click", () => openRepo(p.cwd));
    el.querySelector('[data-act="edit"]').onclick = () => openEdit(p);
    el.querySelector('[data-act="del"]').onclick = () => openDelete(p);
    el.querySelector(".toggle").onclick = () => toggleDetail(p.cwd);
    el.querySelector(".usage-line").onclick = () => toggleUsage(p.cwd);
    if (hasPrompts)
      el.querySelector(".top.ptoggle").onclick = () => togglePrompts(p.cwd);
    grid.appendChild(el);
    if (isOpen && !detailCache.has(p.cwd)) loadDetail(p.cwd);
    queueUsage(p.cwd);
  }
  requestAnimationFrame(fitCards);
}

// Ajuste chaque tuile à la hauteur réelle de son contenu.
// row = 8px, gap = 14px (cf. .bento). align-items:start évite l'étirement,
// donc offsetHeight = vraie hauteur du contenu.
function fitCards() {
  const cards = document.querySelectorAll(".card");
  for (const el of cards) el.style.gridRow = ""; // reset avant mesure
  for (const el of cards) {
    const rows = Math.ceil((el.offsetHeight + 14) / 22);
    el.style.gridRow = `span ${rows}`;
  }
}

// ---- Ouvrir un terminal Windows dans le dossier du projet --------------
async function openTerminal(cwd, action = "terminal") {
  try {
    await api("/api/open-terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, action }),
    });
    toast(action === "continue" ? "claude --continue lancé" : "Terminal ouvert");
  } catch (e) {
    toast(e.message, true);
  }
}

async function openFolder(cwd) {
  try {
    await api("/api/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    toast("Dossier ouvert");
  } catch (e) {
    toast(e.message, true);
  }
}

async function openRepo(cwd) {
  try {
    const { url } = await api("/api/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    toast("Dépôt ouvert : " + url);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Détail déplié (sessions + sous-agents) ----------------------------
const expanded = new Set();
const detailCache = new Map();

function toggleDetail(cwd) {
  if (expanded.has(cwd)) {
    expanded.delete(cwd);
    detailCache.delete(cwd);
  } else {
    expanded.add(cwd);
  }
  render(true);
}

function fmtBytes(n) {
  if (!n) return "0 o";
  const u = ["o", "Ko", "Mo", "Go"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function detailHTML(detail) {
  if (!detail.sessions.length)
    return '<div class="det-loading">aucune session.</div>';
  return detail.sessions
    .map((s) => {
      const sa = s.subAgents.length
        ? `<div class="sa">${s.subAgents
            .map(
              (a) => `<div class="sa-row">
                <span class="sa-type">${esc(a.agentType)}</span>
                <span class="sa-task">${esc((a.task || "—").slice(0, 160))}</span>
                <span class="sa-meta">${a.records ?? "?"} entrées · ${ago(a.lastActivityMs)}</span>
              </div>`
            )
            .join("")}</div>`
        : "";
      return `<div class="sess">
        <div class="sess-head">
          <span class="sess-id">${esc(s.id.slice(0, 8))}</span>
          <span class="sess-meta">${s.records ?? "?"} entrées · ${fmtBytes(s.sizeBytes)} · ${ago(s.lastActivityMs)}</span>
        </div>
        ${s.orphan ? `<div class="sess-when">session compactée — sans transcript principal</div>` : ""}
        ${s.startTs ? `<div class="sess-when">début ${new Date(s.startTs).toLocaleString("fr-FR")}</div>` : ""}
        ${s.firstPrompt ? `<div class="sess-prompt"><b>1er prompt</b>${esc(s.firstPrompt.slice(0, 240))}</div>` : ""}
        ${s.lastPrompt && s.lastPrompt !== s.firstPrompt ? `<div class="sess-prompt"><b>${s.lastRole === "assistant" ? "dern. réponse" : "dern. prompt"}</b>${esc(s.lastPrompt.slice(0, 240))}</div>` : ""}
        ${s.subAgents.length ? `<div class="sa-title">${s.subAgents.length} sous-agent${s.subAgents.length > 1 ? "s" : ""}</div>${sa}` : ""}
      </div>`;
    })
    .join("");
}

async function loadDetail(cwd) {
  try {
    const { detail } = await api("/api/project?cwd=" + encodeURIComponent(cwd));
    detailCache.set(cwd, detailHTML(detail));
    if (expanded.has(cwd)) render(true);
  } catch (e) {
    detailCache.set(cwd, `<div class="det-loading">erreur : ${esc(e.message)}</div>`);
    render(true);
  }
}

// ---- Usage (tokens / coût / durée) -------------------------------------
// usageCache: cwd -> "loading" | {usage} | {error}
const usageCache = new Map();
const usageOpen = new Set();
const usageQueue = [];
let usageRunning = 0;
const USAGE_CONCURRENCY = 2;

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " k";
  return String(n);
}
function fmtCost(n) {
  return n >= 100 ? "$" + n.toFixed(0) : "$" + n.toFixed(2);
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function usageSummary(cwd) {
  const u = usageCache.get(cwd);
  if (!u || u === "loading")
    return '<span class="u-load">usage… calcul en cours</span>';
  if (u.error) return `<span class="u-err">usage indisponible</span>`;
  return `<span><b>Σ</b> ${fmtTokens(u.totalTokens)} tok</span>
    <span class="u-cost">${fmtCost(u.costUSD)}</span>
    <span>${fmtDur(u.durationMs)} génér.</span>`;
}

function usageDetailHTML(cwd) {
  const u = usageCache.get(cwd);
  if (!u || u === "loading")
    return '<div class="det-loading">calcul de l\'usage…</div>';
  if (u.error)
    return `<div class="det-loading">erreur : ${esc(u.error)}</div>`;
  const cc = u.codeChanges;
  const rows = u.byModel
    .map(
      (m) => `<tr>
        <td class="um-model">${esc(m.model)}</td>
        <td>${m.msgs}</td>
        <td>${fmtTokens(m.tokens)}</td>
        <td class="u-cost">${fmtCost(m.cost)}</td>
      </tr>`
    )
    .join("");
  return `
    <div class="u-section">
      <div class="u-stitle">Total code changes</div>
      <div class="u-codes">
        <span class="u-add">+${cc.additions.toLocaleString("fr-FR")}</span>
        <span class="u-del">−${cc.deletions.toLocaleString("fr-FR")}</span>
        <span class="sa-meta">${cc.edits} édition${cc.edits > 1 ? "s" : ""} de fichier</span>
      </div>
    </div>
    <div class="u-section">
      <div class="u-stitle">Usage by model</div>
      <table class="u-table">
        <thead><tr><th>modèle</th><th>msgs</th><th>tokens</th><th>coût</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">aucune donnée</td></tr>'}</tbody>
      </table>
      <div class="u-note">coût estimé · tarifs publics par modèle · ${u.filesParsed} fichier(s)</div>
    </div>`;
}

function paintUsage(cwd) {
  // met à jour les lignes/détails de ce projet sans reconstruire la grille
  for (const card of document.querySelectorAll(".card")) {
    const line = card.querySelector(".usage-line");
    if (!line || line.dataset.cwd !== cwd) continue;
    line.innerHTML =
      `<span class="chev">${usageOpen.has(cwd) ? "▾" : "▸"}</span>` +
      usageSummary(cwd);
    const det = card.querySelector(".usage-detail");
    if (det) det.innerHTML = usageDetailHTML(cwd);
    requestAnimationFrame(fitCards);
  }
}

function pumpUsageQueue() {
  while (usageRunning < USAGE_CONCURRENCY && usageQueue.length) {
    const cwd = usageQueue.shift();
    usageRunning++;
    api("/api/usage?cwd=" + encodeURIComponent(cwd))
      .then(({ usage }) => usageCache.set(cwd, usage))
      .catch((e) => usageCache.set(cwd, { error: e.message }))
      .finally(() => {
        usageRunning--;
        paintUsage(cwd);
        pumpUsageQueue();
      });
  }
}
function queueUsage(cwd) {
  if (usageCache.has(cwd) || usageQueue.includes(cwd)) return;
  usageCache.set(cwd, "loading");
  usageQueue.push(cwd);
  pumpUsageQueue();
}
function toggleUsage(cwd) {
  if (usageOpen.has(cwd)) usageOpen.delete(cwd);
  else usageOpen.add(cwd);
  render(true);
}

// ---- Modale édition ----------------------------------------------------
function openEdit(p) {
  current = p;
  $("editName").textContent = p.name;
  $("editCustomName").value = p.displayName || "";
  $("editStatus").value = p.userStatus || "";
  $("editNote").value = p.note || "";
  $("editTags").value = (p.tags || []).join(", ");
  $("editModal").hidden = false;
}
$("editCancel").onclick = () => ($("editModal").hidden = true);
$("editSave").onclick = async () => {
  try {
    await api("/api/meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: current.cwd,
        name: $("editCustomName").value,
        status: $("editStatus").value,
        note: $("editNote").value,
        tags: $("editTags").value.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    $("editModal").hidden = true;
    toast("Enregistré");
  } catch (e) {
    toast(e.message, true);
  }
};

// ---- Modale suppression ------------------------------------------------
function openDelete(p) {
  current = p;
  $("delName").textContent = p.name;
  $("delHist").textContent = p.dirNames.join(", ");
  $("delCwd").textContent = p.cwd;
  $("delConfirm").value = "";
  $("delGo").disabled = true;
  $("delModal").hidden = false;
  $("delConfirm").focus();
}
$("delConfirm").oninput = (e) => {
  $("delGo").disabled = e.target.value !== current?.name;
};
$("delCancel").onclick = () => ($("delModal").hidden = true);
$("delGo").onclick = async () => {
  try {
    await api("/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: current.cwd, confirmName: $("delConfirm").value }),
    });
    $("delModal").hidden = true;
    toast(`"${current.name}" déplacé vers la corbeille`);
    refreshTrashCount();
  } catch (e) {
    toast(e.message, true);
  }
};

// ---- Corbeille ---------------------------------------------------------
async function refreshTrashCount() {
  try {
    const { trash } = await api("/api/trash");
    $("trashCount").textContent = trash.length;
    return trash;
  } catch {
    return [];
  }
}
$("trashBtn").onclick = async () => {
  const trash = await refreshTrashCount();
  const box = $("trashList");
  box.innerHTML = trash.length
    ? ""
    : '<div class="empty">Corbeille vide.</div>';
  for (const t of trash) {
    const row = document.createElement("div");
    row.className = "trash-item";
    row.innerHTML = `
      <div>
        <strong>${esc(t.name || t.id)}</strong>
        <div class="ti-meta">${esc(t.cwd || "")} · supprimé ${t.deletedAt ? ago(Date.parse(t.deletedAt)) : "?"}</div>
      </div>
      <div><button class="ghost" data-r>Restaurer</button>
           <button class="danger-btn" data-p>Purger</button></div>`;
    row.querySelector("[data-r]").onclick = async () => {
      try {
        await api("/api/trash/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: t.id }),
        });
        toast("Restauré");
        $("trashBtn").click();
        refreshTrashCount();
      } catch (e) {
        toast(e.message, true);
      }
    };
    row.querySelector("[data-p]").onclick = async () => {
      if (!confirm(`Purger définitivement "${t.name}" ? Irréversible.`)) return;
      try {
        await api("/api/trash/purge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: t.id }),
        });
        toast("Purgé définitivement");
        $("trashBtn").click();
        refreshTrashCount();
      } catch (e) {
        toast(e.message, true);
      }
    };
    box.appendChild(row);
  }
  $("trashModal").hidden = false;
};
$("trashClose").onclick = () => ($("trashModal").hidden = true);
$("trashPurge").onclick = async () => {
  if (!confirm("Vider TOUTE la corbeille ? Suppression définitive et irréversible.")) return;
  try {
    await api("/api/trash/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    toast("Corbeille vidée");
    $("trashModal").hidden = true;
    refreshTrashCount();
  } catch (e) {
    toast(e.message, true);
  }
};

// ---- Flux live (SSE) ---------------------------------------------------
$("search").oninput = render;
$("filter").onchange = render;

function connect() {
  const es = new EventSource("/api/stream");
  es.onopen = () => $("conn").classList.add("on");
  es.onerror = () => $("conn").classList.remove("on");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "projects") {
        PROJECTS = msg.projects;
        render();
      }
    } catch {
      /* keep-alive comment */
    }
  };
}
connect();
refreshTrashCount();
