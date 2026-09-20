// Review Run Viewer - read-only UI. All parsing happens in server.js;
// this file only renders the normalized JSON and raw markdown.

const state = { runs: [], run: null, tab: "timeline", sel: null, planView: "diff" };
let renderToken = 0;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = (s) => String(s ?? "UNKNOWN").replace(/[^A-Za-z_]/g, "");

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function raw(runId, path) {
  const r = await fetch(`/api/runs/${runId}/raw?path=${encodeURIComponent(path)}`);
  return r.ok ? r.text() : null;
}

function md(text) {
  if (text == null) return '<p class="muted">(not available)</p>';
  if (window.marked && window.DOMPurify) return `<div class="md">${DOMPurify.sanitize(marked.parse(text))}</div>`;
  return `<pre class="raw">${esc(text)}</pre>`;
}

const badge = (status) => `<span class="badge s-${cls(status)}">${esc(status)}</span>`;
const decisionBadge = (d) => `<span class="badge d-${cls(d)}">${esc(d)}</span>`;

// ---------- line diff (LCS) ----------

function diffLines(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }

  const a2 = A.slice(s, ea), b2 = B.slice(s, eb);
  const n = a2.length, m = b2.length, w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = a2[i] === b2[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);

  const ops = A.slice(0, s).map((x) => ({ t: " ", s: x }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) { ops.push({ t: " ", s: a2[i] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ t: "-", s: a2[i++] });
    else ops.push({ t: "+", s: b2[j++] });
  }
  while (i < n) ops.push({ t: "-", s: a2[i++] });
  while (j < m) ops.push({ t: "+", s: b2[j++] });
  for (const x of A.slice(ea)) ops.push({ t: " ", s: x });
  return ops;
}

function renderDiff(before, after) {
  const ops = diffLines(before, after);
  const changed = ops.filter((o) => o.t !== " ").length;
  if (!changed) return '<p class="muted">PLAN.md did not change in this round.</p>';

  const CONTEXT = 3;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t !== " ") for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });

  const added = ops.filter((o) => o.t === "+").length, removed = ops.filter((o) => o.t === "-").length;
  let html = `<p class="muted"><span style="color:var(--add-fg)">+${added}</span> / <span style="color:var(--del-fg)">−${removed}</span> lines</p><div class="diff">`;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      let k = i;
      while (k < ops.length && !keep[k]) k++;
      html += `<span class="ln skip">… ${k - i} unchanged lines …</span>`;
      i = k - 1;
      continue;
    }
    const o = ops[i], c = o.t === "+" ? "add" : o.t === "-" ? "del" : "";
    html += `<span class="ln ${c}">${o.t === " " ? "  " : o.t + " "}${esc(o.s)}</span>`;
  }
  return html + "</div>";
}

// ---------- run list ----------

function fmtTime(s) { return s ? s.replace("T", " ") : ""; }

function renderRuns() {
  const el = $("#runs");
  if (!state.runs.length) {
    el.innerHTML = '<p class="muted pad">No runs in history/.<br>Run review-loop.ps1 first.</p>';
    return;
  }
  el.innerHTML = state.runs.map((r) => `
    <button class="run-item ${state.run && state.run.runId === r.runId ? "active" : ""}" data-id="${esc(r.runId)}">
      <div class="row"><strong>${esc(fmtTime(r.startedAt) || r.runId)}</strong>${badge(r.status)}</div>
      <small>${esc(r.claudeModel || "?")} × ${esc(r.codexModel || "?")} · ${r.reviewRounds} review${r.reviewRounds === 1 ? "" : "s"}</small>
      ${r.failure ? `<br><small style="color:var(--bad)">${esc(r.failure.stage)}</small>` : ""}
    </button>`).join("");
  el.querySelectorAll(".run-item").forEach((b) => b.addEventListener("click", () => { location.hash = "#/" + b.dataset.id; }));
}

// ---------- run view ----------

function buildEvents(run) {
  const ev = [];
  if (run.hasInitialPlan) ev.push({ key: "initial", kind: "initial" });
  for (const r of run.rounds) {
    if (r.hasReview) ev.push({ key: "c" + r.round, kind: "codex", r });
    if (r.hasResponse) ev.push({ key: "a" + r.round, kind: "claude", r });
  }
  ev.push({ key: "final", kind: "final" });
  return ev;
}

function decisionSummary(r) {
  const c = {};
  r.responses.forEach((x) => { c[x.decision] = (c[x.decision] || 0) + 1; });
  return Object.entries(c).map(([k, v]) => `${k} ×${v}`).join(", ");
}

function renderRun() {
  const run = state.run, main = $("#main");
  if (!run) { main.innerHTML = '<p class="muted pad">Select a run.</p>'; return; }

  const tabs = [
    ["timeline", "Timeline", true],
    ["requirement", "Requirement", true],
    ["final", "Final Plan", run.hasFinalPlan],
    ["log", "Raw Log", true],
  ];

  main.innerHTML = `
    <div class="head">
      <h1>${badge(run.status)} <span>Run ${esc(run.runId)}</span></h1>
      <div class="meta">
        <span>Claude <b>${esc(run.claudeModel || "?")}</b></span>
        <span>Codex <b>${esc(run.codexModel || "?")}</b></span>
        <span>Review rounds <b>${run.reviewRounds}</b>${run.maxRevisionRounds ? ` (max revisions ${run.maxRevisionRounds})` : ""}</span>
        ${run.startedAt ? `<span>Started <b>${esc(run.startedAt)}</b></span>` : ""}
        ${run.finishedAt ? `<span>Finished <b>${esc(run.finishedAt)}</b></span>` : ""}
      </div>
    </div>
    ${run.failure ? `<div class="banner">Run failed at “${esc(run.failure.stage)}” (round ${run.failure.round}, exit code ${run.failure.exitCode}). This is a CLI/artifact failure, not a non-convergence.</div>` : ""}
    <div class="tabs">${tabs.map(([k, l, on]) => `<button class="tab ${state.tab === k ? "active" : ""}" data-tab="${k}" ${on ? "" : "disabled"}>${l}</button>`).join("")}</div>
    <div class="body" id="body"></div>`;

  main.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; renderRun(); }));
  renderBody();
}

async function renderBody() {
  const run = state.run, body = $("#body"), token = ++renderToken;
  const fill = (html) => { if (token === renderToken) body.innerHTML = html; };

  if (state.tab === "requirement") return fill(md(await raw(run.runId, "requirement.md")));
  if (state.tab === "final") return fill(md(await raw(run.runId, "final-plan.md")));
  if (state.tab === "log") {
    const t = await raw(run.runId, "conversation.md");
    return fill(t == null ? '<p class="muted">(not available)</p>' : `<pre class="raw">${esc(t)}</pre>`);
  }

  // timeline
  const events = buildEvents(run);
  if (!state.sel || !events.some((e) => e.key === state.sel)) state.sel = events[0].key;

  body.innerHTML = `<div class="split"><ol class="timeline" id="tl"></ol><div id="detail"></div></div>`;
  $("#tl").innerHTML = events.map((e) => {
    let title, sub = "", extra = "";
    if (e.kind === "initial") { title = "Initial Plan"; sub = "Claude created PLAN.md"; }
    else if (e.kind === "codex") { title = `Round ${e.r.round} · Codex`; extra = badge(e.r.status); sub = e.r.findings.length ? `${e.r.findings.length} finding${e.r.findings.length === 1 ? "" : "s"}` : ""; }
    else if (e.kind === "claude") { title = `Round ${e.r.round} · Claude`; sub = decisionSummary(e.r) || "responded"; }
    else { title = "Result"; extra = badge(run.status); }
    return `<li class="ev ${e.kind} ${e.kind === "final" ? "s-" + cls(run.status) : ""} ${state.sel === e.key ? "active" : ""}">
      <button data-key="${e.key}"><div class="t">${esc(title)} ${extra}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</button></li>`;
  }).join("");
  $("#tl").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { state.sel = b.dataset.key; renderBody(); }));

  const ev = events.find((e) => e.key === state.sel);
  const detail = $("#detail");
  const setDetail = (html) => { if (token === renderToken) detail.innerHTML = html; };
  detail.innerHTML = '<p class="muted">Loading…</p>';

  if (ev.kind === "initial") return setDetail(md(await raw(run.runId, "00-plan-initial.md")));

  if (ev.kind === "codex") {
    const r = ev.r, text = await raw(run.runId, `${r.dir}/review.md`);
    const cards = r.findings.map((f) => `
      <div class="card"><h3><span class="badge">${esc(f.id)}</span>${f.severity ? `<span class="badge sev-${cls(f.severity)}">${esc(f.severity)}</span>` : ""}<span>${esc(f.title)}</span></h3>${f.body ? md(f.body) : ""}</div>`).join("");
    return setDetail(`<div class="section-title">Codex review · round ${r.round} ${badge(r.status)}</div>` +
      (cards ? cards + `<details><summary>Raw review.md</summary>${md(text)}</details>` : md(text)));
  }

  if (ev.kind === "claude") {
    const r = ev.r, text = await raw(run.runId, `${r.dir}/response.md`);
    const cards = r.responses.map((x) => `
      <div class="card"><h3><span class="badge">${esc(x.findingId)}</span>${decisionBadge(x.decision)}</h3>
      ${x.reason ? `<div class="lbl">Reason</div>${md(x.reason)}` : ""}${x.action ? `<div class="lbl">Action</div>${md(x.action)}` : ""}</div>`).join("");
    let html = `<div class="section-title">Claude response · round ${r.round}</div>` +
      (cards ? cards + `<details><summary>Raw response.md</summary>${md(text)}</details>` : md(text));

    if (r.hasPlan) {
      html += `<div class="section-title">Plan change</div>
        <div class="toolbar">
          <button class="btn ${state.planView === "diff" ? "on" : ""}" data-pv="diff">Diff</button>
          <button class="btn ${state.planView === "plan" ? "on" : ""}" data-pv="plan">Plan after this round</button>
        </div><div id="plan-view"><p class="muted">Loading…</p></div>`;
      setDetail(html);
      detail.querySelectorAll("[data-pv]").forEach((b) => b.addEventListener("click", () => { state.planView = b.dataset.pv; renderBody(); }));
      const [before, after] = await Promise.all([raw(run.runId, r.planBefore), raw(run.runId, r.planAfter)]);
      const pv = $("#plan-view");
      if (pv && token === renderToken) pv.innerHTML = state.planView === "diff"
        ? (before == null || after == null ? '<p class="muted">Plan version missing.</p>' : renderDiff(before, after))
        : md(after);
      return;
    }
    return setDetail(html);
  }

  // final
  const planHtml = run.hasFinalPlan ? md(await raw(run.runId, "final-plan.md")) : "";
  setDetail(`<div class="card"><h3>${badge(run.status)}</h3>
    <p class="muted">${run.reviewRounds} Codex review round(s)${run.finishedAt ? ` · finished ${esc(run.finishedAt)}` : ""}</p>
    ${run.failure ? `<p style="color:var(--bad)">Failed at “${esc(run.failure.stage)}” (round ${run.failure.round})</p>` : ""}</div>
    ${run.hasFinalPlan ? `<div class="section-title">Final plan</div>${planHtml}` : ""}`);
}

// ---------- boot ----------

async function openRun(id) {
  try {
    state.run = await api(`/api/runs/${id}`);
    state.sel = null;
    state.tab = "timeline";
  } catch (e) {
    state.run = null;
    $("#main").innerHTML = `<p class="pad" style="color:var(--bad)">${esc(e.message)}</p>`;
    return;
  }
  renderRuns();
  renderRun();
}

async function boot() {
  try {
    state.runs = await api("/api/runs");
  } catch (e) {
    $("#main").innerHTML = `<p class="pad" style="color:var(--bad)">${esc(e.message)}</p>`;
    return;
  }
  renderRuns();
  const fromHash = () => (location.hash.match(/^#\/(\d{8}-\d{6})$/) || [])[1];
  window.addEventListener("hashchange", () => { const id = fromHash(); if (id) openRun(id); });
  const first = fromHash() || (state.runs[0] && state.runs[0].runId);
  if (first) openRun(first); else renderRun();
}

boot();
