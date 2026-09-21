// Review Run Viewer - read-only backend.
// Scans <root>/history/<runId>/ and serves normalized JSON + raw markdown.
// No dependencies:  node viewer/server.js  [--root <dir>] [--port <n>]

const http = require("http");
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(arg("root", process.env.REVIEW_ROOT || path.join(__dirname, "..")));
const PORT = Number(arg("port", process.env.PORT || 4173));
const WORK_ITEMS = path.join(ROOT, "work-items");
const PUBLIC = path.join(__dirname, "public");

const WORK_ITEM_ID = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID = /^\d{8}-\d{6}$/;
const RAW_PATH = /^((requirement|00-plan-initial|final-plan|conversation)|round-\d{2}\/(review|response|plan))\.md$/;

// ---------- file helpers ----------

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------- parsers ----------

// "Key: value" lines -> object
function parseKeyValues(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function sectionAfter(conv, heading) {
  const m = conv.match(new RegExp(`^# ${heading}\\s*$`, "m"));
  return m ? parseKeyValues(conv.slice(m.index + m[0].length)) : null;
}

function parseStatus(md) {
  const m = md && md.match(/^STATUS:\s*([A-Z_]+)\s*$/m);
  return m ? m[1] : "UNKNOWN";
}

// Tolerant: AGENTS.md does not fix a finding format, so accept
// "## F001 ...", "- F001: ...", "1. **F001** ..." style lines.
const FINDING_LINE = /^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\[?(F\d{1,4})\]?(?:\*\*|__)?\s*(?:[:·|\-–—.)]\s*)?(.*)$/;

function parseFindings(md) {
  const findings = [];
  let cur = null;
  for (const line of md.split("\n")) {
    const m = line.match(FINDING_LINE);
    if (m) {
      cur = { id: m[1], title: m[2].replace(/(\*\*|__)/g, "").trim(), body: [] };
      findings.push(cur);
    } else if (/^#{1,2}\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return findings.map((f) => {
    const body = f.body.join("\n").trim();
    const sev = (f.title + "\n" + body).match(/\b(CRITICAL|HIGH|MEDIUM|LOW|INFO)\b/i);
    return { id: f.id, title: f.title, severity: sev ? sev[1].toUpperCase() : null, body };
  });
}

function parseResponses(md) {
  if (!md) return [];
  const sections = md.split(/^##\s+/m).slice(1);
  return sections.map((sec) => {
    const [head, ...rest] = sec.split("\n");
    const fields = { decision: "", reason: "", action: "" };
    let field = null;
    for (const line of rest) {
      const m = line.match(/^\**(Decision|Reason|Action)\**\s*:\**\s*(.*)$/i);
      if (m) {
        field = m[1].toLowerCase();
        fields[field] += m[2] + "\n";
      } else if (field) {
        fields[field] += line + "\n";
      }
    }
    const d = fields.decision.match(/ACCEPT|REJECT|ALTERNATIVE/i);
    return {
      findingId: head.trim(),
      decision: d ? d[0].toUpperCase() : "UNKNOWN",
      reason: fields.reason.trim(),
      action: fields.action.trim(),
    };
  });
}

// ---------- run model ----------

function parseRun(workItemId, runId) {
  const dir = path.join(WORK_ITEMS, workItemId, "history", runId);
  const conv = readText(path.join(dir, "conversation.md")) || "";

  const header = parseKeyValues(conv.split(/^---\s*$/m)[0]);
  const final = sectionAfter(conv, "Final Result");
  const failed = sectionAfter(conv, "Run Failed");

  const rounds = listDirs(dir)
    .filter((n) => /^round-\d{2}$/.test(n))
    .sort()
    .map((name) => {
      const n = Number(name.slice(6));
      const review = readText(path.join(dir, name, "review.md"));
      const response = readText(path.join(dir, name, "response.md"));
      const plan = readText(path.join(dir, name, "plan.md"));
      const responses = parseResponses(response);
      return {
        round: n,
        dir: name,
        status: review ? parseStatus(review) : null,
        findings: review ? parseFindings(review) : [],
        hasReview: review !== null,
        hasResponse: response !== null,
        hasPlan: plan !== null,
        responses,
        // plan version this round's Claude revision started from
        planBefore: n === 1 ? "00-plan-initial.md" : `round-${String(n - 1).padStart(2, "0")}/plan.md`,
        planAfter: plan !== null ? `${name}/plan.md` : null,
      };
    });

  let status = "INCOMPLETE";
  if (final && final.STATUS) status = final.STATUS;
  else if (failed) status = "FAILED";

  return {
    workItemId,
    runId,
    status,
    startedAt: header["Started At"] || null,
    finishedAt: (final && final["Finished At"]) || (failed && failed["Finished At"]) || null,
    claudeModel: header["Claude Model"] || null,
    codexModel: header["Codex Model"] || null,
    maxRevisionRounds: header["Max Revision Rounds"] ? Number(header["Max Revision Rounds"]) : null,
    reviewRounds: final && final["Total Review Rounds"] ? Number(final["Total Review Rounds"]) : rounds.filter((r) => r.hasReview).length,
    failure: failed ? { stage: failed.Stage, round: Number(failed.Round), exitCode: Number(failed["Exit Code"]) } : null,
    hasFinalPlan: fs.existsSync(path.join(dir, "final-plan.md")),
    hasInitialPlan: fs.existsSync(path.join(dir, "00-plan-initial.md")),
    rounds,
  };
}

function listWorkItems() {
  return listDirs(WORK_ITEMS)
    .filter((id) => WORK_ITEM_ID.test(id))
    .sort()
    .map((id) => {
      let metadata = {};
      const raw = readText(path.join(WORK_ITEMS, id, "work-item.json"));
      try { metadata = raw ? JSON.parse(raw) : {}; } catch {}
      return {
        id,
        title: metadata.title || id,
        status: metadata.status || "UNKNOWN",
        latestRunId: metadata.latestRunId || null,
      };
    });
}

function listRuns(workItemId) {
  const history = path.join(WORK_ITEMS, workItemId, "history");
  return listDirs(history)
    .filter((n) => RUN_ID.test(n))
    .sort()
    .reverse()
    .map((id) => {
      const { runId, status, startedAt, claudeModel, codexModel, reviewRounds, failure } = parseRun(workItemId, id);
      return { workItemId, runId, status, startedAt, claudeModel, codexModel, reviewRounds, failure };
    });
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function handleApi(url, res) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"

  if (parts[0] === "work-items" && parts.length === 1) {
    return sendJson(res, 200, listWorkItems());
  }

  const workItemId = parts[1];
  if (parts[0] !== "work-items" || !workItemId || !WORK_ITEM_ID.test(workItemId)) {
    return sendJson(res, 404, { error: "not found" });
  }

  const workItemDir = path.join(WORK_ITEMS, workItemId);
  if (!fs.existsSync(workItemDir)) return sendJson(res, 404, { error: "work item not found" });

  if (parts[2] === "runs" && parts.length === 3) {
    return sendJson(res, 200, listRuns(workItemId));
  }

  const runId = parts[3];
  if (parts[2] === "runs" && runId && RUN_ID.test(runId)) {
    const runDir = path.join(workItemDir, "history", runId);
    if (!fs.existsSync(runDir)) return sendJson(res, 404, { error: "run not found" });

    if (parts.length === 4) return sendJson(res, 200, parseRun(workItemId, runId));

    if (parts[4] === "raw") {
      const rel = url.searchParams.get("path") || "";
      if (!RAW_PATH.test(rel)) return sendJson(res, 400, { error: "invalid path" });
      const text = readText(path.join(runDir, rel));
      if (text === null) return sendJson(res, 404, { error: "file not found" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(text);
    }
  }
  sendJson(res, 404, { error: "not found" });
}

function handleStatic(url, res) {
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": (MIME[path.extname(file)] || "application/octet-stream") + "; charset=utf-8",
  });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end();
    }
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return handleApi(url, res);
      return handleStatic(url, res);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Review Run Viewer  http://127.0.0.1:${PORT}`);
    console.log(`Reading            ${WORK_ITEMS}`);
  });
