const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const app = express();
const PORT = 3847;
const SESSIONS_FILE = path.join(os.homedir(), ".openclaw", "code-agent-sessions.json");

// --- JSONL Cache ---
const jsonlCache = new Map(); // key: filePath -> { mtime, data }

function parseJsonlCached(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const mtimeMs = stat.mtimeMs;
  const cached = jsonlCache.get(jsonlPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.data;
  }
  const raw = fs.readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter(l => l.trim());
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }
  jsonlCache.set(jsonlPath, { mtimeMs, data: parsed });
  return parsed;
}

function findJsonlPath(sessionId) {
  let harnessSessionId = sessionId;
  if (fs.existsSync(SESSIONS_FILE)) {
    const sessionsData = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    const session = sessionsData.find(s => s.sessionId === sessionId);
    if (session && session.harnessSessionId) {
      harnessSessionId = session.harnessSessionId;
    }
  }

  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return null;

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const candidate = path.join(claudeProjectsDir, dir.name, harnessSessionId + ".jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}


// Cache for extracted models from JSONL
const modelCache = new Map();

function extractModelFromJsonl(sessionId) {
  if (modelCache.has(sessionId)) return modelCache.get(sessionId);
  const jsonlPath = findJsonlPath(sessionId);
  if (!jsonlPath) return null;
  try {
    const data = fs.readFileSync(jsonlPath, "utf-8");
    const lines = data.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message && obj.message.model) {
          const model = obj.message.model;
          modelCache.set(sessionId, model);
          return model;
        }
      } catch {}
    }
  } catch {}
  modelCache.set(sessionId, null);
  return null;
}

function buildTimeline(entries, jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const fallbackTs = stat.mtime.toISOString();
  const timeline = [];

  for (const entry of entries) {
    const ts = entry.timestamp || fallbackTs;

    if (entry.type === "user") {
      const msgContent = entry.message?.content;
      if (typeof msgContent === "string") {
        timeline.push({ type: "prompt", content: msgContent, timestamp: ts });
      } else if (Array.isArray(msgContent)) {
        for (const item of msgContent) {
          if (item.type === "tool_result") {
            let content = "";
            if (typeof item.content === "string") {
              content = item.content;
            } else if (Array.isArray(item.content)) {
              content = item.content
                .map(c => (typeof c === "string" ? c : c.text || c.content || JSON.stringify(c)))
                .join("\n");
            }
            timeline.push({
              type: "tool_result",
              content,
              tool_use_id: item.tool_use_id || "",
              timestamp: ts
            });
          } else if (item.type === "text") {
            timeline.push({ type: "prompt", content: item.text || "", timestamp: ts });
          }
        }
      }
    } else if (entry.type === "assistant") {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === "thinking") {
          timeline.push({ type: "thinking", content: block.thinking || "", timestamp: ts });
        } else if (block.type === "text") {
          timeline.push({ type: "text", content: block.text || "", timestamp: ts });
        } else if (block.type === "tool_use") {
          timeline.push({
            type: "tool_call",
            tool: block.name || "unknown",
            input: block.input || {},
            id: block.id || "",
            timestamp: ts
          });
        }
      }
    } else if (entry.type === "tool_result") {
      let content = "";
      if (typeof entry.content === "string") {
        content = entry.content;
      } else if (Array.isArray(entry.content)) {
        content = entry.content
          .map(c => (typeof c === "string" ? c : c.text || c.content || JSON.stringify(c)))
          .join("\n");
      } else if (entry.result) {
        content = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result);
      }
      timeline.push({
        type: "tool_result",
        content,
        tool_use_id: entry.tool_use_id || "",
        timestamp: ts
      });
    }
  }
  return timeline;
}

// --- Helper: read sessions ---
function readSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
  const sessions = JSON.parse(raw);
  sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return sessions;
}

// --- API ---

app.get("/api/sessions", (req, res) => {
  try {
    let sessions = readSessions();

    // Filter by status
    const statusFilter = req.query.status;
    if (statusFilter) {
      sessions = sessions.filter(s => s.status === statusFilter);
    }

    // Search by query term (matches name, prompt, workdir, sessionId)
    const q = req.query.q;
    if (q) {
      const lower = q.toLowerCase();
      sessions = sessions.filter(s =>
        (s.name || "").toLowerCase().includes(lower) ||
        (s.prompt || "").toLowerCase().includes(lower) ||
        (s.workdir || "").toLowerCase().includes(lower) ||
        (s.sessionId || "").toLowerCase().includes(lower)
      );
    }

    // Enrich with model from JSONL if not set
    sessions = sessions.map(s => {
      if (!s.model || s.model === "default") {
        const extracted = extractModelFromJsonl(s.sessionId);
        if (extracted) s.claudeModel = extracted;
      }
      return s;
    });
    res.json(sessions);
  } catch (err) {
    console.error("Error reading sessions:", err.message);
    res.status(500).json({ error: "Failed to read sessions file" });
  }
});

app.get("/api/stats", (_req, res) => {
  try {
    const sessions = readSessions();
    const totalSessions = sessions.length;
    const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0);

    // Sessions by status
    const byStatus = {};
    for (const s of sessions) {
      const st = s.status || "unknown";
      byStatus[st] = (byStatus[st] || 0) + 1;
    }

    // Average duration (for completed/failed/killed sessions)
    const finished = sessions.filter(s => s.completedAt && s.createdAt);
    const avgDuration = finished.length > 0
      ? finished.reduce((sum, s) => sum + (s.completedAt - s.createdAt), 0) / finished.length
      : 0;

    // Cost by day (last 30 days)
    const costByDay = {};
    for (const s of sessions) {
      if (s.createdAt && s.costUsd) {
        const day = new Date(s.createdAt).toISOString().slice(0, 10);
        costByDay[day] = (costByDay[day] || 0) + s.costUsd;
      }
    }

    res.json({
      totalSessions,
      totalCost,
      avgDurationMs: Math.round(avgDuration),
      byStatus,
      costByDay
    });
  } catch (err) {
    console.error("Error computing stats:", err.message);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

app.get("/api/sessions/:id/output", (req, res) => {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      return res.status(404).json({ error: "Sessions file not found" });
    }
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    const session = sessions.find((s) => s.sessionId === req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (!session.outputPath) {
      return res.status(404).json({ error: "No output path for session" });
    }
    if (!fs.existsSync(session.outputPath)) {
      return res.status(404).json({ error: "Output file not found" });
    }
    const content = fs.readFileSync(session.outputPath, "utf-8");
    res.type("text/plain").send(content);
  } catch (err) {
    console.error("Error reading output:", err.message);
    res.status(500).json({ error: "Failed to read output" });
  }
});

// --- Session History API (with caching) ---

app.get("/api/sessions/:id/history", (req, res) => {
  try {
    const sessionId = req.params.id;
    const jsonlPath = findJsonlPath(sessionId);

    if (!jsonlPath) {
      return res.status(404).json({ error: "Session JSONL not found" });
    }

    const entries = parseJsonlCached(jsonlPath);
    const timeline = buildTimeline(entries, jsonlPath);
    res.json(timeline);
  } catch (err) {
    console.error("Error reading session history:", err.message);
    res.status(500).json({ error: "Failed to read session history" });
  }
});

// --- Latest activity API (lightweight, also cached) ---

app.get("/api/sessions/:id/latest", (req, res) => {
  try {
    const sessionId = req.params.id;
    const jsonlPath = findJsonlPath(sessionId);

    if (!jsonlPath) {
      return res.json([]);
    }

    const allEntries = parseJsonlCached(jsonlPath);
    const stat = fs.statSync(jsonlPath);
    const fallbackTs = stat.mtime.toISOString();

    // Parse only the last few entries to get the last 3 meaningful items
    const lastEntries = allEntries.slice(-10);
    const entries = [];

    for (const entry of lastEntries) {
      const ts = entry.timestamp || fallbackTs;

      if (entry.type === "assistant") {
        const blocks = entry.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
          if (block.type === "text") {
            entries.push({ type: "text", content: block.text || "", timestamp: ts });
          } else if (block.type === "tool_use") {
            entries.push({
              type: "tool_call",
              tool: block.name || "unknown",
              input: block.input || {},
              timestamp: ts
            });
          }
        }
      } else if (entry.type === "user") {
        const msgContent = entry.message?.content;
        if (typeof msgContent === "string") {
          entries.push({ type: "prompt", content: msgContent, timestamp: ts });
        }
      }
    }

    res.json(entries.slice(-3));
  } catch (err) {
    console.error("Error reading latest activity:", err.message);
    res.json([]);
  }
});

// --- PR Extraction from JSONL files ---
const prJsonlCache = new Map(); // key: jsonlPath -> { mtimeMs, prs: [{url, sessionId, sessionName}] }
const prGhCache = new Map(); // key: prUrl -> { fetchedAt, data }
const PR_GH_CACHE_TTL = 60000; // 60 seconds
const PR_URL_RE = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g;

function getAllJsonlPaths() {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return [];
  const results = [];
  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(claudeProjectsDir, dir.name);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
        results.push(path.join(dirPath, f));
      }
    }
  } catch {}
  return results;
}

function extractPRsFromJsonl(jsonlPath) {
  try {
    const stat = fs.statSync(jsonlPath);
    const cached = prJsonlCache.get(jsonlPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.prs;

    const raw = fs.readFileSync(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    const prs = [];
    const seenUrls = new Set();
    const harnessSessionId = path.basename(jsonlPath, ".jsonl");

    // Find session info
    let sessionName = "";
    let sessionId = "";
    if (fs.existsSync(SESSIONS_FILE)) {
      try {
        const sessionsData = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
        const session = sessionsData.find(s => s.harnessSessionId === harnessSessionId);
        if (session) {
          sessionName = session.name || "";
          sessionId = session.sessionId || "";
        }
      } catch {}
    }

    // Strategy 1: Look for gh pr create tool_use and corresponding tool_result
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch {}
    }

    const ghPrCreateToolIds = new Set();
    for (const entry of entries) {
      if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === "tool_use" && block.name === "Bash" &&
              typeof block.input?.command === "string" && block.input.command.includes("gh pr create")) {
            if (block.id) ghPrCreateToolIds.add(block.id);
          }
        }
      }
    }

    // Find tool_results matching those tool_use ids
    for (const entry of entries) {
      if (entry.type === "user" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === "tool_result" && ghPrCreateToolIds.has(block.tool_use_id)) {
            const text = typeof block.content === "string" ? block.content :
              Array.isArray(block.content) ? block.content.map(c => typeof c === "string" ? c : c.text || "").join("\n") : "";
            let match;
            const re = new RegExp(PR_URL_RE.source, "g");
            while ((match = re.exec(text)) !== null) {
              if (!seenUrls.has(match[0])) {
                seenUrls.add(match[0]);
                prs.push({ url: match[0], owner: match[1], repo: match[2], number: parseInt(match[3]), sessionId, sessionName, harnessSessionId });
              }
            }
          }
        }
      }
      // Also check top-level tool_result entries
      if (entry.type === "tool_result" && ghPrCreateToolIds.has(entry.tool_use_id)) {
        const text = typeof entry.content === "string" ? entry.content :
          Array.isArray(entry.content) ? entry.content.map(c => typeof c === "string" ? c : c.text || "").join("\n") : "";
        let match;
        const re = new RegExp(PR_URL_RE.source, "g");
        while ((match = re.exec(text)) !== null) {
          if (!seenUrls.has(match[0])) {
            seenUrls.add(match[0]);
            prs.push({ url: match[0], owner: match[1], repo: match[2], number: parseInt(match[3]), sessionId, sessionName, harnessSessionId });
          }
        }
      }
    }

    // Strategy 2: Fallback - scan assistant text blocks for PR URLs
    for (const entry of entries) {
      if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            let match;
            const re = new RegExp(PR_URL_RE.source, "g");
            while ((match = re.exec(block.text)) !== null) {
              if (!seenUrls.has(match[0])) {
                seenUrls.add(match[0]);
                prs.push({ url: match[0], owner: match[1], repo: match[2], number: parseInt(match[3]), sessionId, sessionName, harnessSessionId });
              }
            }
          }
        }
      }
    }

    prJsonlCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, prs });
    return prs;
  } catch {
    return [];
  }
}

function getAllPRsFromJsonls() {
  const allPaths = getAllJsonlPaths();
  const allPrs = [];
  const seenUrls = new Set();
  for (const p of allPaths) {
    const prs = extractPRsFromJsonl(p);
    for (const pr of prs) {
      if (!seenUrls.has(pr.url)) {
        seenUrls.add(pr.url);
        allPrs.push(pr);
      }
    }
  }
  return allPrs;
}

function fetchPRDetailsViaGh(prUrl) {
  const cached = prGhCache.get(prUrl);
  if (cached && (Date.now() - cached.fetchedAt) < PR_GH_CACHE_TTL) return cached.data;

  try {
    const json = execSync(
      `gh pr view "${prUrl}" --json title,state,isDraft,createdAt,updatedAt,author,statusCheckRollup,labels,mergeable,reviews,comments,number`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const data = JSON.parse(json);
    prGhCache.set(prUrl, { fetchedAt: Date.now(), data });
    return data;
  } catch (err) {
    console.error("gh pr view failed for", prUrl, err.message);
    return null;
  }
}

function formatPRResponse(pr, ghData) {
  if (!ghData) {
    return {
      url: pr.url, owner: pr.owner, repo: pr.repo, number: pr.number,
      title: "(unable to fetch)", state: "unknown", merged: false, draft: false,
      createdAt: null, updatedAt: null, author: "", reviewComments: 0, reviews: 0,
      checks: "unknown", sessionName: pr.sessionName, sessionId: pr.sessionId,
      labels: [], mergeable: false
    };
  }

  // Determine checks status from statusCheckRollup
  let checks = "unknown";
  if (Array.isArray(ghData.statusCheckRollup) && ghData.statusCheckRollup.length > 0) {
    const allPass = ghData.statusCheckRollup.every(c => c.conclusion === "SUCCESS" || c.status === "COMPLETED" && c.conclusion === "SUCCESS");
    const anyFail = ghData.statusCheckRollup.some(c => c.conclusion === "FAILURE" || c.conclusion === "ERROR");
    const anyPending = ghData.statusCheckRollup.some(c => !c.conclusion || c.conclusion === "" || c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING");
    if (anyFail) checks = "failing";
    else if (anyPending) checks = "pending";
    else if (allPass) checks = "passing";
  }

  const state = ghData.state === "MERGED" ? "merged" : ghData.state === "CLOSED" ? "closed" : "open";
  const merged = ghData.state === "MERGED";

  return {
    url: pr.url, owner: pr.owner, repo: pr.repo, number: ghData.number || pr.number,
    title: ghData.title || "", state, merged, draft: ghData.isDraft || false,
    createdAt: ghData.createdAt || null, updatedAt: ghData.updatedAt || null,
    author: ghData.author?.login || "", reviewComments: (ghData.comments || []).length,
    reviews: (ghData.reviews || []).length, checks,
    sessionName: pr.sessionName, sessionId: pr.sessionId,
    labels: (ghData.labels || []).map(l => typeof l === "string" ? l : l.name || ""),
    mergeable: ghData.mergeable === "MERGEABLE"
  };
}

// --- PR API ---

app.get("/api/prs", async (req, res) => {
  try {
    const prs = getAllPRsFromJsonls();
    const results = [];
    // Fetch gh details for each PR (sequentially to avoid hammering)
    for (const pr of prs) {
      const ghData = fetchPRDetailsViaGh(pr.url);
      results.push(formatPRResponse(pr, ghData));
    }
    // Sort by createdAt descending
    results.sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json(results);
  } catch (err) {
    console.error("Error fetching PRs:", err.message);
    res.status(500).json({ error: "Failed to fetch PRs" });
  }
});

app.get("/api/prs/:owner/:repo/:number", (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;

    // Try to find session info from our cache
    const allPrs = getAllPRsFromJsonls();
    const pr = allPrs.find(p => p.url === url) || { url, owner, repo, number: parseInt(number), sessionId: "", sessionName: "", harnessSessionId: "" };

    // Fetch detailed info including review comments
    let ghData = null;
    try {
      const json = execSync(
        `gh pr view "${url}" --json title,state,isDraft,createdAt,updatedAt,author,statusCheckRollup,labels,mergeable,reviews,comments,number,body`,
        { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
      );
      ghData = JSON.parse(json);
    } catch (err) {
      console.error("gh pr view failed for", url, err.message);
    }

    const result = formatPRResponse(pr, ghData);
    if (ghData?.body) result.body = ghData.body;
    if (ghData?.comments) result.recentComments = ghData.comments.slice(-10).map(c => ({
      author: c.author?.login || "", body: c.body || "", createdAt: c.createdAt || ""
    }));
    if (ghData?.reviews) result.reviewDetails = ghData.reviews.map(r => ({
      author: r.author?.login || "", state: r.state || "", body: r.body || "", submittedAt: r.submittedAt || ""
    }));

    res.json(result);
  } catch (err) {
    console.error("Error fetching PR details:", err.message);
    res.status(500).json({ error: "Failed to fetch PR details" });
  }
});

// --- Frontend ---

const HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27><text y=%27.9em%27 font-size=%2790%27>🐾</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root, :root[data-theme="dark"] {
  --bg: #1e1e2e;
  --card-bg: #181825;
  --card-hover: #313244;
  --navbar: #11111b;
  --surface: #313244;
  --code-bg: #181825;
  --accent: #cba6f7;
  --accent-light: rgba(203,166,247,0.08);
  --link: #89b4fa;
  --running: #89b4fa;
  --completed: #a6e3a1;
  --failed: #f38ba8;
  --killed: #fab387;
  --paused: #45475a;
  --text-primary: #cdd6f4;
  --text-secondary: #a6adc8;
  --text-muted: #7f849c;
  --text-heading: #cdd6f4;
  --border: #45475a;
  --border-hover: #585b70;
  --info-accent: #94e2d5;
  --search-accent: #b4befe;
  --glob-accent: #cba6f7;
  --diff-add-bg: rgba(166, 227, 161, 0.15);
  --diff-add-text: #a6e3a1;
  --diff-del-bg: rgba(243, 139, 168, 0.15);
  --diff-del-text: #f38ba8;
  --tool-result-bg: #1e1e2e;
  --mono: 'JetBrains Mono', 'Fira Code', monospace;
}

:root[data-theme="light"] {
  --bg: #eff1f5;
  --card-bg: #e6e9ef;
  --card-hover: #dce0e8;
  --navbar: #ccd0da;
  --surface: #ccd0da;
  --code-bg: #e6e9ef;
  --accent: #8839ef;
  --accent-light: rgba(136,57,239,0.08);
  --link: #1e66f5;
  --running: #1e66f5;
  --completed: #40a02b;
  --failed: #d20f39;
  --killed: #fe640b;
  --paused: #bcc0cc;
  --text-primary: #4c4f69;
  --text-secondary: #6c6f85;
  --text-muted: #8c8fa1;
  --text-heading: #4c4f69;
  --border: #bcc0cc;
  --border-hover: #acb0be;
  --info-accent: #179299;
  --search-accent: #7287fd;
  --glob-accent: #8839ef;
  --diff-add-bg: rgba(64, 160, 43, 0.15);
  --diff-add-text: #40a02b;
  --diff-del-bg: rgba(210, 15, 57, 0.15);
  --diff-del-text: #d20f39;
  --tool-result-bg: #eff1f5;
}

body, .header, .session-card, .card-output, .tl-card, .tl-card-body,
.filter-btn, .search-input, .tab-btn, .output-pre, .files-summary,
.file-chip, .card-preview-inner, .mini-diff, .timeline-sort-btn,
.output-actions button, .tl-show-more, .tl-tool-badge {
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

body {
  font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text-primary);
  min-height: 100vh;
  line-height: 1.5;
}

a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-hover); }

/* Header — dark Concourse-style navbar */
.header {
  background: var(--navbar);
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  position: sticky;
  top: 0;
  z-index: 100;
  height: 48px;
}
.header-left { display: flex; align-items: center; gap: 10px; }
.header .logo { font-size: 22px; line-height: 1; }
.header {
  border-bottom: 1px solid var(--border);
}
.header h1 {
  font-size: 15px; font-weight: 600; color: var(--text-heading);
  letter-spacing: 0;
}
.header h1 span { color: var(--accent); }
.header-stats {
  display: flex; gap: 20px; align-items: center;
  font-size: 13px; color: var(--text-primary); font-weight: 400;
}
.header-stats .stat-item {
  display: inline-flex; align-items: center; gap: 6px;
}
.header-stats .stat-value { color: var(--text-heading); font-weight: 600; }
.header-stats .stat-value.running-val { color: var(--running); }
.header-stats .stat-value.cost { color: var(--completed); }
.header-stats .stat-dot {
  width: 6px; height: 6px; border-radius: 50%; display: inline-block;
}
.header-stats .stat-dot.running-dot { background: var(--running); animation: pulse-dot 2s infinite; }

/* Theme toggle */
.theme-toggle {
  background: none; border: 1px solid var(--border); color: var(--text-primary);
  width: 32px; height: 32px; border-radius: 4px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; line-height: 1;
  transition: border-color 0.2s, background-color 0.2s;
}
.theme-toggle:hover { border-color: var(--accent); background: var(--accent-light); }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Container */
.container { max-width: 1400px; margin: 0 auto; padding: 20px 20px; }

/* Filter bar — Concourse tab style */
.filter-bar {
  display: flex; gap: 0; margin-bottom: 20px; flex-wrap: wrap; align-items: center;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}
.filter-btn {
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--text-secondary); padding: 10px 16px; cursor: pointer; font-size: 13px;
  font-family: 'Inter', system-ui, sans-serif; font-weight: 500;
  transition: color 0.15s, border-color 0.15s;
}
.filter-btn:hover {
  color: var(--text-heading);
}
.filter-btn.active {
  color: var(--accent); font-weight: 600;
  border-bottom-color: var(--accent);
}

.search-input {
  flex: 1; min-width: 200px; max-width: 280px;
  background: var(--card-bg); border: 1px solid var(--border); color: var(--text-primary);
  padding: 7px 12px 7px 34px; border-radius: 2px; font-size: 13px;
  font-family: 'Inter', system-ui, sans-serif; outline: none;
  transition: border-color 0.15s;
  margin-left: auto;
}
.search-input:focus { border-color: var(--accent); }
.search-input::placeholder { color: var(--text-muted); }
.search-wrap { position: relative; flex: 1; min-width: 200px; max-width: 280px; margin-left: auto; }
.search-icon {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  color: var(--text-muted); font-size: 13px; pointer-events: none;
}

/* Cards grid */
.cards-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
}
@media (min-width: 1100px) {
  .cards-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* Session card — Concourse pipeline card style */
.session-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 2px;
  border-left: 4px solid var(--paused);
  transition: background 0.1s;
  overflow: hidden;
}
.session-card:hover {
  background: var(--card-hover);
}
.session-card.expanded {
  grid-column: 1 / -1;
}
.session-card.expanded:hover { background: var(--card-bg); }
.session-card.running { border-left: 4px solid var(--running); }
.session-card.completed { border-left: 4px solid var(--completed); }
.session-card.failed { border-left: 4px solid var(--failed); }
.session-card.killed { border-left: 4px solid var(--killed); }

.card-header {
  padding: 20px 24px;
  cursor: pointer;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 16px;
  align-items: start;
}

.card-top-row {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.session-name {
  font-size: 15px; font-weight: 600; color: var(--text-heading);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px;
}
.badge {
  font-size: 10px; font-weight: 700; padding: 0; border-radius: 0;
  text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 0;
  background: none; border: none;
}
.badge.running { color: var(--running); }
.badge.running::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px;
  background: var(--running); animation: pulse-dot 2s infinite;
}
.badge.completed { color: var(--completed); }
.badge.failed { color: var(--failed); }
.badge.killed { color: var(--killed); }
.badge.unknown { color: var(--paused); }

.card-meta {
  display: flex; gap: 14px; flex-wrap: wrap;
  font-size: 12px; color: var(--text-secondary); margin-top: 4px;
}
.card-meta span { white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }

.card-prompt {
  grid-column: 1 / -1;
  font-size: 13px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 4px; line-height: 1.4;
}

.card-cost {
  font-size: 14px; font-weight: 700; white-space: nowrap; align-self: center;
  color: var(--text-primary);
  padding: 0;
  font-family: var(--mono);
}

/* Expanded output */
.card-output {
  display: none;
  border-top: 1px solid var(--border);
  padding: 18px 18px;
  background: var(--bg);
}
.card-output.open { display: block; }
.output-actions {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 12px;
}
.output-actions button {
  background: var(--card-bg); border: 1px solid var(--border); color: var(--text-primary);
  padding: 5px 12px; border-radius: 2px; cursor: pointer; font-size: 12px;
  font-family: 'Inter', system-ui, sans-serif; font-weight: 500;
  transition: border-color 0.15s;
}
.output-actions button:hover { border-color: var(--accent); }
.output-pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 14px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  max-height: 600px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary);
}
.output-loading { color: var(--text-muted); font-style: italic; padding: 20px 0; }
.output-error { color: var(--failed); padding: 20px 0; }

/* Tabs */
.tab-bar {
  display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border);
}
.tab-btn {
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--text-secondary); padding: 8px 16px; cursor: pointer; font-size: 13px;
  font-weight: 500; font-family: 'Inter', system-ui, sans-serif;
  transition: all 0.15s;
}
.tab-btn:hover { color: var(--text-heading); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

/* Files touched summary */
.files-summary {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 2px;
  padding: 12px 16px; margin-bottom: 16px;
}
.files-summary-title {
  font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;
  letter-spacing: 0.8px; margin-bottom: 8px;
}
.files-summary-list { display: flex; flex-wrap: wrap; gap: 4px; }
.file-chip {
  font-size: 11px; padding: 3px 8px; border-radius: 2px; font-family: var(--mono);
  background: var(--surface); color: var(--text-primary); border: 1px solid var(--border);
  transition: border-color 0.15s;
}
.file-chip:hover { border-color: var(--border-hover); }
.file-chip.read { border-left: 3px solid var(--running); }
.file-chip.edit { border-left: 3px solid var(--completed); }
.file-chip.write { border-left: 3px solid var(--completed); }
.file-chip.bash { border-left: 3px solid var(--killed); }

/* Timeline — pipeline style */
.timeline { position: relative; padding-left: 28px; }
.timeline::before {
  content: ''; position: absolute; left: 11px; top: 0; bottom: 0;
  width: 2px; background: var(--border);
}
.tl-entry { position: relative; margin-bottom: 8px; }
.tl-entry::before {
  content: ''; position: absolute; left: -22px; top: 11px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--border); border: 2px solid var(--bg);
  z-index: 1;
}
.tl-entry.prompt::before { background: var(--running); }
.tl-entry.text::before { background: var(--text-muted); }
.tl-entry.tool-Read::before { background: var(--running); }
.tl-entry.tool-Edit::before, .tl-entry.tool-Write::before { background: var(--completed); }
.tl-entry.tool-Bash::before { background: var(--killed); }
.tl-entry.tool-Glob::before, .tl-entry.tool-Grep::before { background: var(--glob-accent); }
.tl-entry.tool-Agent::before { background: var(--accent); }
.tl-entry.tool_result::before { background: var(--text-muted); }

.tl-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 2px;
  overflow: hidden; transition: border-color 0.15s;
}
.tl-card:hover { border-color: var(--border-hover); }
.tl-card.prompt { border-left: 3px solid var(--running); }
.tl-card.text { border-left: 3px solid var(--text-muted); }
.tl-card.tool-Read { border-left: 3px solid var(--running); }
.tl-card.tool-Edit, .tl-card.tool-Write { border-left: 3px solid var(--completed); }
.tl-card.tool-Bash { border-left: 3px solid var(--killed); }
.tl-card.tool-Glob, .tl-card.tool-Grep { border-left: 3px solid var(--glob-accent); }
.tl-card.tool-Agent { border-left: 3px solid var(--accent); }
.tl-card.tool_result { border-left: 3px solid var(--text-muted); background: var(--tool-result-bg); }

.tl-card-header {
  padding: 8px 12px; display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; color: var(--text-primary);
}
.tl-icon { font-size: 14px; flex-shrink: 0; }
.tl-tool-badge {
  font-size: 10px; padding: 2px 6px; border-radius: 2px;
  background: var(--surface); color: var(--text-secondary); font-weight: 600;
  font-family: var(--mono); border: 1px solid var(--border);
}
.tl-card-body {
  padding: 8px 12px; font-size: 12px; color: var(--text-primary);
  font-family: var(--mono); line-height: 1.6;
  max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
  background: var(--surface); border-top: 1px solid var(--border);
}
.tl-card-body.expanded { max-height: none; }
.tl-card-body.collapsed { max-height: 70px; overflow: hidden; position: relative; }
.tl-show-more {
  display: block; text-align: center; padding: 4px; font-size: 11px;
  color: var(--accent); cursor: pointer; background: var(--card-bg);
  border-top: 1px solid var(--border); font-weight: 500;
  font-family: 'Inter', system-ui, sans-serif;
  transition: background 0.15s;
}
.tl-show-more:hover { background: var(--surface); }

.tl-filepath {
  font-family: var(--mono); font-size: 11px; color: var(--info-accent);
  font-weight: 400;
}
.tl-command {
  font-family: var(--mono); font-size: 11px; color: var(--glob-accent);
  font-weight: 400;
}

/* Mini diff */
.mini-diff {
  font-family: var(--mono); font-size: 11px; line-height: 1.6;
  background: var(--surface); border-top: 1px solid var(--border); padding: 8px 12px;
  max-height: 200px; overflow-y: auto;
}
.diff-old {
  background: var(--diff-del-bg); color: var(--diff-del-text); padding: 1px 6px;
  display: block; white-space: pre-wrap; word-break: break-all;
  border-left: 3px solid var(--failed); margin-bottom: 1px;
}
.diff-new {
  background: var(--diff-add-bg); color: var(--diff-add-text); padding: 1px 6px;
  display: block; white-space: pre-wrap; word-break: break-all;
  border-left: 3px solid var(--completed); margin-bottom: 1px;
}
.diff-label {
  font-size: 10px; color: var(--text-secondary); font-weight: 700;
  margin-bottom: 4px; margin-top: 6px; display: block;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.diff-label:first-child { margin-top: 0; }

/* Live preview */
.card-preview {
  padding: 0 24px 16px 24px;
}
.card-preview-inner {
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-radius: 0;
  padding: 6px 10px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  max-height: 56px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Timeline timestamp */
.tl-timestamp {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  font-family: var(--mono);
}

/* Timeline sort toggle */
.timeline-sort-toggle {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.timeline-sort-btn {
  background: var(--card-bg);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 4px 10px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 11px;
  font-family: 'Inter', system-ui, sans-serif;
  font-weight: 500;
  transition: border-color 0.15s;
}
.timeline-sort-btn:hover { border-color: var(--accent); color: var(--text-primary); }

/* Empty state */
.empty-state {
  text-align: center; padding: 80px 20px; color: var(--text-muted);
}
.empty-state .icon { font-size: 48px; margin-bottom: 16px; opacity: 0.4; }
.empty-state h2 { font-size: 18px; color: var(--text-heading); margin-bottom: 6px; font-weight: 600; }
.empty-state p { color: var(--text-secondary); font-size: 14px; }

/* Responsive */
@media (max-width: 768px) {
  .header { padding: 0 12px; height: 44px; }
  .header h1 { font-size: 14px; }
  .header-stats { gap: 12px; font-size: 12px; }
  .container { padding: 16px 12px; }
  .card-header { padding: 16px 18px; grid-template-columns: 1fr; }
  .session-name { max-width: 220px; font-size: 14px; }
  .card-cost { justify-self: start; }
  .card-meta { gap: 10px; }
  .filter-btn { padding: 8px 12px; font-size: 12px; }
  .search-wrap { min-width: 140px; max-width: 100%; margin-left: 0; flex-basis: 100%; }
  .cards-grid { gap: 16px; }
  .card-preview { padding: 0 14px 10px 14px; }
}

/* Main view tabs */
.main-tabs {
  display: flex; gap: 0; margin-bottom: 0;
  border-bottom: 2px solid var(--border);
}
.main-tab {
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--text-secondary); padding: 10px 20px; cursor: pointer; font-size: 14px;
  font-weight: 600; font-family: 'Inter', system-ui, sans-serif;
  transition: all 0.15s; margin-bottom: -2px;
}
.main-tab:hover { color: var(--text-heading); }
.main-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.main-tab .tab-count {
  font-size: 11px; font-weight: 500; color: var(--text-muted);
  margin-left: 6px; background: var(--surface); padding: 1px 6px; border-radius: 8px;
}

/* PR view */
.pr-view { display: none; }
.pr-view.active { display: block; }
.sessions-view { display: block; }
.sessions-view.hidden { display: none; }

/* PR summary bar */
.pr-summary {
  display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  margin-bottom: 16px; font-size: 13px; color: var(--text-secondary);
}
.pr-summary .pr-stat {
  display: inline-flex; align-items: center; gap: 5px;
}
.pr-summary .pr-stat-value {
  font-weight: 700; color: var(--text-heading);
}
.pr-summary .pr-stat-value.open-val { color: var(--completed); }
.pr-summary .pr-stat-value.merged-val { color: var(--accent); }
.pr-summary .pr-stat-value.draft-val { color: var(--text-muted); }

/* PR filter bar */
.pr-filter-bar {
  display: flex; gap: 0; margin-bottom: 20px; flex-wrap: wrap; align-items: center;
  border-bottom: 1px solid var(--border); padding-bottom: 0;
}

/* PR card */
.pr-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 2px;
  border-left: 4px solid var(--completed); padding: 18px 22px;
  transition: background 0.1s; margin-bottom: 12px;
}
.pr-card:hover { background: var(--card-hover); }
.pr-card.state-open { border-left-color: var(--completed); }
.pr-card.state-draft { border-left-color: var(--text-muted); }
.pr-card.state-merged { border-left-color: var(--accent); }
.pr-card.state-closed { border-left-color: var(--failed); }

.pr-header-row {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px;
}
.pr-title {
  font-size: 15px; font-weight: 600; color: var(--text-heading);
  text-decoration: none; cursor: pointer;
}
.pr-title:hover { text-decoration: underline; color: var(--link); }
.pr-number {
  font-size: 13px; color: var(--text-muted); font-family: var(--mono); font-weight: 500;
}
.pr-state-badge {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
  padding: 2px 8px; border-radius: 2px;
}
.pr-state-badge.open { color: var(--completed); background: rgba(166,227,161,0.12); }
.pr-state-badge.draft { color: var(--text-muted); background: rgba(127,132,156,0.12); }
.pr-state-badge.merged { color: var(--accent); background: rgba(203,166,247,0.12); }
.pr-state-badge.closed { color: var(--failed); background: rgba(243,139,168,0.12); }

.pr-meta-row {
  display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;
}
.pr-meta-row span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }

.pr-stats-row {
  display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; align-items: center;
}
.pr-stats-row span { display: inline-flex; align-items: center; gap: 4px; }

.pr-labels {
  display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px;
}
.pr-label-pill {
  font-size: 10px; padding: 2px 8px; border-radius: 10px;
  background: var(--surface); color: var(--text-primary); border: 1px solid var(--border);
  font-weight: 500;
}

.pr-session-link {
  font-size: 11px; color: var(--text-muted); margin-top: 6px; display: block;
}
.pr-session-link a {
  color: var(--link); cursor: pointer; font-size: 11px;
}

.pr-loading {
  text-align: center; padding: 40px; color: var(--text-muted); font-size: 14px;
}

.checks-pass { color: var(--completed); }
.checks-fail { color: var(--failed); }
.checks-pending { color: var(--killed); }
.mergeable-yes { color: var(--completed); }
.mergeable-no { color: var(--failed); }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <span class="logo">&#x1f43e;</span>
    <h1><span>OpenClaw</span> Agent Dashboard</h1>
  </div>
  <div class="header-stats">
    <span class="stat-item">
      <span class="stat-value" id="total-count">0</span> sessions
    </span>
    <span class="stat-item">
      <span class="stat-dot running-dot"></span>
      <span class="stat-value running-val" id="running-count">0</span> running
    </span>
    <span class="stat-item">
      <span class="stat-value cost" id="total-cost">$0.00</span> total
    </span>
    <button class="theme-toggle" id="theme-toggle" title="Toggle light/dark mode" aria-label="Toggle theme">&#x1f319;</button>
  </div>
</div>

<div class="container">
  <div class="main-tabs">
    <button class="main-tab active" id="tab-sessions" onclick="switchMainTab('sessions')">&#x1f4cb; Sessions <span class="tab-count" id="sessions-tab-count">0</span></button>
    <button class="main-tab" id="tab-prs" onclick="switchMainTab('prs')">&#x1f517; Pull Requests <span class="tab-count" id="prs-tab-count">0</span></button>
  </div>

  <div class="sessions-view" id="sessions-view">
    <div class="filter-bar">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="running">Running</button>
      <button class="filter-btn" data-filter="completed">Completed</button>
      <button class="filter-btn" data-filter="failed">Failed</button>
      <button class="filter-btn" data-filter="killed">Killed</button>
      <div class="search-wrap">
        <span class="search-icon">&#x1f50d;</span>
        <input type="text" class="search-input" id="search-input" placeholder="Search sessions..." />
      </div>
    </div>
    <div id="sessions-list" class="cards-grid"></div>
  </div>

  <div class="pr-view" id="prs-view">
    <div class="pr-summary" id="pr-summary"></div>
    <div class="pr-filter-bar" id="pr-filter-bar">
      <button class="filter-btn active" data-pr-filter="all">All</button>
      <button class="filter-btn" data-pr-filter="open">Open</button>
      <button class="filter-btn" data-pr-filter="merged">Merged</button>
      <button class="filter-btn" data-pr-filter="closed">Closed</button>
      <button class="filter-btn" data-pr-filter="draft">Draft</button>
    </div>
    <div id="prs-list"></div>
  </div>
</div>

<script>
// --- Theme toggle ---
(function() {
  const saved = localStorage.getItem("theme");
  let theme;
  if (saved === "light" || saved === "dark") {
    theme = saved;
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    theme = "light";
  } else {
    theme = "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  btn.innerHTML = theme === "dark" ? "\\u2600\\ufe0f" : "\\u{1f319}";
  btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

document.addEventListener("DOMContentLoaded", function() {
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  updateThemeIcon();
});

let sessions = [];
let activeFilter = "all";
let expandedId = null;
let outputCache = {};
let historyCache = {};
let activeTab = {};
let previewCache = {};
let timelineOrder = {};
let searchQuery = "";

// Debounce search
let searchTimeout = null;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = e.target.value.trim();
    renderSessions();
  }, 200);
});

// --- Time helpers ---
function relativeTime(epochMs) {
  if (!epochMs) return "";
  const diff = Date.now() - epochMs;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const days = Math.floor(hr / 24);
  return days + "d ago";
}

function duration(startMs, endMs) {
  if (!startMs) return "";
  const end = endMs || Date.now();
  const sec = Math.floor((end - startMs) / 1000);
  if (sec < 60) return sec + "s";
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return min + "m " + remSec + "s";
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return hr + "h " + remMin + "m";
}

function relativeTimeFromISO(isoStr) {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const days = Math.floor(hr / 24);
  return days + "d ago";
}

function formatAbsoluteTime(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    return d.toLocaleString();
  } catch { return isoStr; }
}

function formatPreviewEntry(e) {
  if (e.type === "tool_call") {
    const tool = e.tool || "unknown";
    const fp = e.input?.file_path;
    const cmd = e.input?.command;
    const pattern = e.input?.pattern;
    if (fp) {
      const shortFp = fp.length > 50 ? "..." + fp.slice(-47) : fp;
      return "\\u{1f527} " + tool + ": " + shortFp;
    }
    if (cmd) return "\\u{1f527} " + tool + ": " + (cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd);
    if (pattern) return "\\u{1f527} " + tool + ": " + pattern;
    return "\\u{1f527} " + tool;
  }
  if (e.type === "text") {
    const line = (e.content || "").split("\\n")[0];
    return "\\u{1f4ac} " + (line.length > 70 ? line.slice(0, 70) + "..." : line);
  }
  if (e.type === "prompt") {
    const line = (e.content || "").split("\\n")[0];
    return "\\u{1f4e5} " + (line.length > 70 ? line.slice(0, 70) + "..." : line);
  }
  return "";
}

function formatCost(usd) {
  if (usd == null) return "$0.00";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

// --- ANSI to HTML ---
const ANSI_COLORS = {
  30: "#45475a", 31: "#f38ba8", 32: "#a6e3a1", 33: "#f9e2af",
  34: "#89b4fa", 35: "#cba6f7", 36: "#94e2d5", 37: "#cdd6f4",
  90: "#585b70", 91: "#f38ba8", 92: "#a6e3a1", 93: "#f9e2af",
  94: "#89b4fa", 95: "#cba6f7", 96: "#94e2d5", 97: "#cdd6f4",
};

function processAnsi(text) {
  let result = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let openSpans = 0;

  result = result.replace(/\\x1B\\[([0-9;]*)m/g, function(_m, codes) {
    return replaceCode(codes);
  });

  result = result.replace(/\\\\x1[bB]\\[([0-9;]*)m/g, function(_m, codes) {
    return replaceCode(codes);
  });
  result = result.replace(/\\\\033\\[([0-9;]*)m/g, function(_m, codes) {
    return replaceCode(codes);
  });

  function replaceCode(codes) {
    if (!codes || codes === "0") {
      const c = "</span>".repeat(openSpans);
      openSpans = 0;
      return c;
    }
    const nums = codes.split(";");
    let style = "";
    for (const n of nums) {
      const v = parseInt(n, 10);
      if (ANSI_COLORS[v]) style += "color:" + ANSI_COLORS[v] + ";";
      else if (v === 1) style += "font-weight:bold;";
      else if (v === 3) style += "font-style:italic;";
      else if (v === 4) style += "text-decoration:underline;";
    }
    if (style) { openSpans++; return '<span style="' + style + '">'; }
    return "";
  }

  if (openSpans > 0) result += "</span>".repeat(openSpans);
  return result;
}

// --- Tool icons ---
function toolIcon(tool) {
  const icons = {
    Read: "\\u{1f4d6}",
    Edit: "\\u{270f}\\ufe0f",
    Write: "\\u{1f4dd}",
    Bash: "\\u{1f4bb}",
    Glob: "\\u{1f50d}",
    Grep: "\\u{1f50e}",
    Agent: "\\u{1f916}",
    WebFetch: "\\u{1f310}",
    WebSearch: "\\u{1f310}",
    TodoWrite: "\\u{1f4cb}",
    NotebookEdit: "\\u{1f4d3}",
  };
  return icons[tool] || "\\u{1f527}";
}

// --- Rendering ---
function renderSessions() {
  const list = document.getElementById("sessions-list");
  let filtered = activeFilter === "all" ? sessions : sessions.filter(s => s.status === activeFilter);

  // Client-side search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(s =>
      (s.name || "").toLowerCase().includes(q) ||
      (s.prompt || "").toLowerCase().includes(q) ||
      (s.workdir || "").toLowerCase().includes(q) ||
      (s.sessionId || "").toLowerCase().includes(q)
    );
  }

  // Add/remove grid class based on expansion
  if (expandedId) {
    list.classList.add("has-expanded");
  } else {
    list.classList.remove("has-expanded");
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">&#x1f43e;</div>'
      + '<h2>No sessions found</h2><p>' + (sessions.length === 0 ? 'Waiting for sessions...' : 'No sessions match this filter') + '</p></div>';
    return;
  }

  list.innerHTML = filtered.map(s => {
    const st = s.status || "unknown";
    const isExpanded = expandedId === s.sessionId;
    return '<div class="session-card ' + st + (isExpanded ? ' expanded' : '') + '" data-id="' + s.sessionId + '">'
      + '<div class="card-header" onclick="toggleSession(\\'' + s.sessionId + '\\')">'
      + '<div>'
      + '<div class="card-top-row">'
      + '<span class="badge ' + st + '">' + st + '</span>'
      + '<span class="session-name">' + escHtml(s.name || s.sessionId) + '</span>'
      + '</div>'
      + '<div class="card-meta">'
      + '<span>&#x1f4c1; ' + escHtml(truncate(s.workdir || "", 50)) + '</span>'
      + '<span>&#x23f1;&#xfe0f; ' + duration(s.createdAt, s.completedAt) + '</span>'
      + '<span>&#x1f552; ' + relativeTime(s.createdAt) + '</span>'
      + (s.model ? '<span>&#x1f916; ' + escHtml(s.model) + '</span>' : '')
      + (s.harness ? '<span>&#x2699;&#xfe0f; ' + escHtml(s.harness) + '</span>' : '')
      + (s.claudeModel ? '<span>&#x1f9e0; ' + escHtml(s.claudeModel) + '</span>' : '')
      + '</div>'
      + '</div>'
      + '<div class="card-cost">' + formatCost(s.costUsd) + '</div>'
      + '</div>'
      + '<div class="card-prompt" style="padding:0 24px 8px 24px">' + escHtml(truncate(s.prompt || "", 120)) + '</div>'
      + renderPreview(s)
      + '<div class="card-output' + (isExpanded ? ' open' : '') + '" id="output-' + s.sessionId + '">'
      + (isExpanded ? getOutputHtml(s.sessionId) : '')
      + '</div>'
      + '</div>';
  }).join("");
}

function escHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPreview(s) {
  const entries = previewCache[s.sessionId];
  if (!entries || entries.length === 0) return '';
  const lines = entries.map(e => formatPreviewEntry(e)).filter(Boolean).slice(-3);
  if (lines.length === 0) return '';
  return '<div class="card-preview"><div class="card-preview-inner">'
    + lines.map(l => escHtml(l)).join("\\n")
    + '</div></div>';
}

function getOutputHtml(id) {
  const tab = activeTab[id] || "timeline";
  let tabBar = '<div class="tab-bar">'
    + '<button class="tab-btn' + (tab === "timeline" ? " active" : "") + '" onclick="switchTab(\\'' + id + '\\', \\'timeline\\')">&#x1f4cb; Timeline</button>'
    + '<button class="tab-btn' + (tab === "raw" ? " active" : "") + '" onclick="switchTab(\\'' + id + '\\', \\'raw\\')">&#x1f4c4; Raw Output</button>'
    + '</div>';

  if (tab === "timeline") {
    return tabBar + getTimelineHtml(id);
  } else {
    return tabBar + getRawOutputHtml(id);
  }
}

function getRawOutputHtml(id) {
  if (outputCache[id] === undefined) return '<p class="output-loading">Loading output...</p>';
  if (outputCache[id] === null) return '<p class="output-error">No output available</p>';
  return '<div class="output-actions"><span style="font-size:12px;color:var(--text-muted)">Session output</span>'
    + '<button onclick="copyOutput(\\'' + id + '\\')">&#x1f4cb; Copy</button></div>'
    + '<pre class="output-pre">' + processAnsi(outputCache[id]) + '</pre>';
}

function getTimelineHtml(id) {
  if (historyCache[id] === undefined) return '<p class="output-loading">Loading timeline...</p>';
  if (historyCache[id] === null || historyCache[id].length === 0) return '<p class="output-error">No timeline data available</p>';

  const entries = historyCache[id];
  let html = "";

  // Files touched summary
  const filesTouched = new Map();
  for (const e of entries) {
    if (e.type === "tool_call") {
      const fp = e.input?.file_path;
      if (fp) {
        if (!filesTouched.has(fp)) filesTouched.set(fp, new Set());
        filesTouched.get(fp).add(e.tool);
      }
    }
  }
  if (filesTouched.size > 0) {
    html += '<div class="files-summary"><div class="files-summary-title">&#x1f4c2; Files Touched (' + filesTouched.size + ')</div><div class="files-summary-list">';
    for (const [fp, ops] of filesTouched) {
      const opClass = ops.has("Edit") || ops.has("Write") ? "edit" : ops.has("Read") ? "read" : "bash";
      const shortPath = fp.length > 60 ? "..." + fp.slice(-57) : fp;
      const opLabels = [...ops].join(", ");
      html += '<span class="file-chip ' + opClass + '" title="' + escHtml(fp) + ' (' + opLabels + ')">' + escHtml(shortPath) + '</span>';
    }
    html += '</div></div>';
  }

  // Sort toggle
  const order = timelineOrder[id] || "newest";
  html += '<div class="timeline-sort-toggle">'
    + '<button class="timeline-sort-btn" onclick="toggleTimelineOrder(\\'' + id + '\\')">'
    + (order === "newest" ? "\\u25bc Newest first" : "\\u25b2 Oldest first")
    + '</button></div>';

  // Timeline entries
  const orderedEntries = order === "newest" ? [...entries].reverse() : entries;
  html += '<div class="timeline">';
  for (let i = 0; i < orderedEntries.length; i++) {
    const e = orderedEntries[i];
    const origIdx = order === "newest" ? (entries.length - 1 - i) : i;
    html += renderTimelineEntry(e, origIdx);
  }
  html += '</div>';
  return html;
}

function renderTimelineEntry(e, idx) {
  const tsHtml = e.timestamp
    ? '<span class="tl-timestamp" title="' + escHtml(formatAbsoluteTime(e.timestamp)) + '">' + relativeTimeFromISO(e.timestamp) + '</span>'
    : '';

  if (e.type === "prompt") {
    return '<div class="tl-entry prompt"><div class="tl-card prompt">'
      + '<div class="tl-card-header"><span class="tl-icon">\\u{1f4e5}</span> User Prompt' + tsHtml + '</div>'
      + '<div class="tl-card-body">' + escHtml(e.content) + '</div>'
      + '</div></div>';
  }

  if (e.type === "thinking") {
    const text = e.content || "";
    const isLong = text.length > 200;
    return '<div class="tl-entry text"><div class="tl-card text">'
      + '<div class="tl-card-header"><span class="tl-icon">\\u{1f9e0}</span> Thinking' + tsHtml + '</div>'
      + '<div class="tl-card-body ' + (isLong ? 'collapsed' : '') + '" id="tl-body-' + idx + '" style="color:var(--text-muted);font-style:italic">' + escHtml(text) + '</div>'
      + (isLong ? '<span class="tl-show-more" onclick="toggleTlBody(' + idx + ')">Show more</span>' : '')
      + '</div></div>';
  }

  if (e.type === "text") {
    const text = e.content || "";
    const isLong = text.length > 300;
    return '<div class="tl-entry text"><div class="tl-card text">'
      + '<div class="tl-card-header"><span class="tl-icon">\\u{1f4ac}</span> Assistant' + tsHtml + '</div>'
      + '<div class="tl-card-body ' + (isLong ? 'collapsed' : '') + '" id="tl-body-' + idx + '">' + escHtml(text) + '</div>'
      + (isLong ? '<span class="tl-show-more" onclick="toggleTlBody(' + idx + ')">Show more</span>' : '')
      + '</div></div>';
  }

  if (e.type === "tool_call") {
    const tool = e.tool || "unknown";
    const icon = toolIcon(tool);
    let detail = "";
    let extraHtml = "";
    if (tool === "Read") {
      detail = '<span class="tl-filepath">' + escHtml(e.input?.file_path || "") + '</span>';
    } else if (tool === "Edit") {
      detail = '<span class="tl-filepath">' + escHtml(e.input?.file_path || "") + '</span>';
      if (e.input?.old_string || e.input?.new_string) {
        extraHtml = '<div class="mini-diff">';
        if (e.input.old_string) {
          extraHtml += '<span class="diff-label">\\u2796 Removed</span>';
          const oldLines = e.input.old_string.split("\\n").slice(0, 10);
          extraHtml += oldLines.map(l => '<span class="diff-old">- ' + escHtml(l) + '</span>').join("");
          if (e.input.old_string.split("\\n").length > 10) extraHtml += '<span class="diff-old">... (' + (e.input.old_string.split("\\n").length - 10) + ' more lines)</span>';
        }
        if (e.input.new_string) {
          extraHtml += '<span class="diff-label">\\u2795 Added</span>';
          const newLines = e.input.new_string.split("\\n").slice(0, 10);
          extraHtml += newLines.map(l => '<span class="diff-new">+ ' + escHtml(l) + '</span>').join("");
          if (e.input.new_string.split("\\n").length > 10) extraHtml += '<span class="diff-new">... (' + (e.input.new_string.split("\\n").length - 10) + ' more lines)</span>';
        }
        extraHtml += '</div>';
      }
    } else if (tool === "Write") {
      detail = '<span class="tl-filepath">' + escHtml(e.input?.file_path || "") + '</span>';
    } else if (tool === "Bash") {
      const cmd = e.input?.command || "";
      const desc = e.input?.description || "";
      detail = (desc ? '<span style="color:var(--text-muted);font-size:11px">' + escHtml(desc) + '</span> ' : '')
        + '<span class="tl-command">' + escHtml(cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd) + '</span>';
    } else if (tool === "Glob" || tool === "Grep") {
      detail = '<span class="tl-command">' + escHtml(e.input?.pattern || "") + '</span>';
    } else {
      detail = '<span style="color:var(--text-muted);font-size:11px">' + escHtml(JSON.stringify(e.input || {}).slice(0, 100)) + '</span>';
    }

    return '<div class="tl-entry tool-' + tool + '"><div class="tl-card tool-' + tool + '">'
      + '<div class="tl-card-header"><span class="tl-icon">' + icon + '</span> <span class="tl-tool-badge">' + escHtml(tool) + '</span> ' + detail + tsHtml + '</div>'
      + extraHtml
      + '</div></div>';
  }

  if (e.type === "tool_result") {
    const text = e.content || "";
    const lines = text.split("\\n");
    const isLong = lines.length > 5;
    return '<div class="tl-entry tool_result"><div class="tl-card tool_result">'
      + '<div class="tl-card-header"><span class="tl-icon">\\u{1f4e4}</span> Tool Result' + tsHtml + '</div>'
      + '<div class="tl-card-body ' + (isLong ? 'collapsed' : '') + '" id="tl-body-' + idx + '">' + escHtml(text) + '</div>'
      + (isLong ? '<span class="tl-show-more" onclick="toggleTlBody(' + idx + ')">Show more</span>' : '')
      + '</div></div>';
  }

  return "";
}

function toggleTlBody(idx) {
  const el = document.getElementById("tl-body-" + idx);
  if (!el) return;
  if (el.classList.contains("collapsed")) {
    el.classList.remove("collapsed");
    el.classList.add("expanded");
    el.nextElementSibling.textContent = "Show less";
  } else {
    el.classList.remove("expanded");
    el.classList.add("collapsed");
    el.nextElementSibling.textContent = "Show more";
  }
}

function switchTab(id, tab) {
  activeTab[id] = tab;
  if (tab === "raw" && outputCache[id] === undefined) {
    fetch("/api/sessions/" + encodeURIComponent(id) + "/output")
      .then(r => r.ok ? r.text() : null)
      .then(text => { outputCache[id] = text; if (expandedId === id) renderSessions(); })
      .catch(() => { outputCache[id] = null; if (expandedId === id) renderSessions(); });
  }
  if (tab === "timeline" && historyCache[id] === undefined) {
    fetch("/api/sessions/" + encodeURIComponent(id) + "/history")
      .then(r => r.ok ? r.json() : null)
      .then(data => { historyCache[id] = data; if (expandedId === id) renderSessions(); })
      .catch(() => { historyCache[id] = null; if (expandedId === id) renderSessions(); });
  }
  renderSessions();
}

async function toggleSession(id) {
  if (expandedId === id) {
    expandedId = null;
    renderSessions();
    return;
  }
  expandedId = id;
  if (!activeTab[id]) activeTab[id] = "timeline";
  renderSessions();

  const fetches = [];
  if (historyCache[id] === undefined) {
    fetches.push(
      fetch("/api/sessions/" + encodeURIComponent(id) + "/history")
        .then(r => r.ok ? r.json() : null)
        .then(data => { historyCache[id] = data; })
        .catch(() => { historyCache[id] = null; })
    );
  }
  if (outputCache[id] === undefined) {
    fetches.push(
      fetch("/api/sessions/" + encodeURIComponent(id) + "/output")
        .then(r => r.ok ? r.text() : null)
        .then(text => { outputCache[id] = text; })
        .catch(() => { outputCache[id] = null; })
    );
  }
  if (fetches.length > 0) {
    await Promise.all(fetches);
    if (expandedId === id) renderSessions();
  }
}

function copyOutput(id) {
  if (outputCache[id]) {
    navigator.clipboard.writeText(outputCache[id]).catch(() => {});
  }
}

function toggleTimelineOrder(id) {
  const current = timelineOrder[id] || "newest";
  timelineOrder[id] = current === "newest" ? "oldest" : "newest";
  renderSessions();
}

function updateStats() {
  document.getElementById("total-count").textContent = sessions.length;
  document.getElementById("running-count").textContent = sessions.filter(s => s.status === "running").length;
  const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  document.getElementById("total-cost").textContent = formatCost(totalCost);
  document.getElementById("sessions-tab-count").textContent = sessions.length;
}

// --- Filter ---
document.querySelector(".filter-bar").addEventListener("click", (e) => {
  if (!e.target.matches(".filter-btn")) return;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  activeFilter = e.target.dataset.filter;
  renderSessions();
});

// --- Polling ---
async function fetchSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error("fetch failed");
    sessions = await res.json();
    updateStats();
    renderSessions();
    fetchPreviews();
  } catch (err) {
    console.error("Failed to fetch sessions:", err);
  }
}

function fetchPreviews() {
  const filtered = activeFilter === "all" ? sessions : sessions.filter(s => s.status === activeFilter);
  for (const s of filtered) {
    if (s.status === "running" || previewCache[s.sessionId] === undefined) {
      fetch("/api/sessions/" + encodeURIComponent(s.sessionId) + "/latest")
        .then(r => r.ok ? r.json() : [])
        .then(data => {
          const changed = JSON.stringify(previewCache[s.sessionId]) !== JSON.stringify(data);
          previewCache[s.sessionId] = data;
          if (changed) renderSessions();
        })
        .catch(() => {});
    }
  }
}

fetchSessions();
setInterval(fetchSessions, 5000);

// Re-fetch output for running sessions periodically
setInterval(() => {
  if (expandedId) {
    const s = sessions.find(s => s.sessionId === expandedId);
    if (s && s.status === "running") {
      const tab = activeTab[expandedId] || "timeline";
      if (tab === "raw") {
        fetch("/api/sessions/" + encodeURIComponent(expandedId) + "/output")
          .then(r => r.ok ? r.text() : null)
          .then(text => {
            if (text !== null) { outputCache[expandedId] = text; renderSessions(); }
          })
          .catch(() => {});
      } else {
        fetch("/api/sessions/" + encodeURIComponent(expandedId) + "/history")
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data !== null) { historyCache[expandedId] = data; renderSessions(); }
          })
          .catch(() => {});
      }
    }
  }
}, 5000);

// --- PR Tab ---
let prs = [];
let prFilter = "all";
let mainTab = "sessions";
let prFetchInProgress = false;

function switchMainTab(tab) {
  mainTab = tab;
  window.location.hash = tab === "sessions" ? "sessions" : "prs";
  document.getElementById("tab-sessions").classList.toggle("active", tab === "sessions");
  document.getElementById("tab-prs").classList.toggle("active", tab === "prs");
  document.getElementById("sessions-view").classList.toggle("hidden", tab !== "sessions");
  document.getElementById("prs-view").classList.toggle("active", tab === "prs");
  if (tab === "prs" && prs.length === 0 && !prFetchInProgress) {
    fetchPRs();
  }
}

// Hash routing
function initFromHash() {
  const hash = window.location.hash.replace("#", "") || "sessions";
  if (hash === "prs") switchMainTab("prs");
  else switchMainTab("sessions");
}

window.addEventListener("hashchange", initFromHash);

// PR filter click handler
document.getElementById("pr-filter-bar").addEventListener("click", (e) => {
  if (!e.target.matches("[data-pr-filter]")) return;
  document.querySelectorAll("[data-pr-filter]").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  prFilter = e.target.dataset.prFilter;
  renderPRs();
});

async function fetchPRs() {
  if (prFetchInProgress) return;
  prFetchInProgress = true;
  const list = document.getElementById("prs-list");
  if (prs.length === 0) list.innerHTML = '<div class="pr-loading">&#x23f3; Loading pull requests...</div>';
  try {
    const res = await fetch("/api/prs");
    if (!res.ok) throw new Error("fetch failed");
    prs = await res.json();
    renderPRSummary();
    renderPRs();
    document.getElementById("prs-tab-count").textContent = prs.length;
  } catch (err) {
    console.error("Failed to fetch PRs:", err);
    list.innerHTML = '<div class="pr-loading">Failed to load pull requests</div>';
  } finally {
    prFetchInProgress = false;
  }
}

function renderPRSummary() {
  const total = prs.length;
  const open = prs.filter(p => p.state === "open" && !p.draft).length;
  const merged = prs.filter(p => p.merged).length;
  const draft = prs.filter(p => p.draft).length;
  const closed = prs.filter(p => p.state === "closed" && !p.merged).length;
  document.getElementById("pr-summary").innerHTML =
    '<span class="pr-stat"><span class="pr-stat-value">' + total + '</span> Total</span>'
    + '<span class="pr-stat"><span class="pr-stat-value open-val">' + open + '</span> Open</span>'
    + '<span class="pr-stat"><span class="pr-stat-value merged-val">' + merged + '</span> Merged</span>'
    + '<span class="pr-stat"><span class="pr-stat-value draft-val">' + draft + '</span> Draft</span>'
    + (closed > 0 ? '<span class="pr-stat"><span class="pr-stat-value">' + closed + '</span> Closed</span>' : '');
}

function renderPRs() {
  const list = document.getElementById("prs-list");
  let filtered = prs;
  if (prFilter === "open") filtered = prs.filter(p => p.state === "open" && !p.draft);
  else if (prFilter === "merged") filtered = prs.filter(p => p.merged);
  else if (prFilter === "closed") filtered = prs.filter(p => p.state === "closed" && !p.merged);
  else if (prFilter === "draft") filtered = prs.filter(p => p.draft);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">&#x1f517;</div>'
      + '<h2>No pull requests found</h2><p>' + (prs.length === 0 ? 'No PRs created by agent sessions yet' : 'No PRs match this filter') + '</p></div>';
    return;
  }

  list.innerHTML = filtered.map(pr => {
    const stateClass = pr.draft ? "draft" : pr.merged ? "merged" : pr.state;
    const stateBadge = pr.draft ? "draft" : pr.merged ? "merged" : pr.state;
    const checksIcon = pr.checks === "passing" ? '<span class="checks-pass">\\u2705</span>'
      : pr.checks === "failing" ? '<span class="checks-fail">\\u274c</span>'
      : pr.checks === "pending" ? '<span class="checks-pending">\\u23f3</span>' : '';
    const mergeableIcon = pr.mergeable ? '<span class="mergeable-yes">\\u2705 Mergeable</span>' : (pr.state === "open" ? '<span class="mergeable-no">\\u26a0\\ufe0f Conflicts</span>' : '');

    let labelsHtml = '';
    if (pr.labels && pr.labels.length > 0) {
      labelsHtml = '<div class="pr-labels">' + pr.labels.map(l => '<span class="pr-label-pill">' + escHtml(l) + '</span>').join('') + '</div>';
    }

    let sessionHtml = '';
    if (pr.sessionName || pr.sessionId) {
      sessionHtml = '<div class="pr-session-link">&#x1f916; Created by session: <a onclick="goToSession(\\'' + escHtml(pr.sessionId) + '\\')">' + escHtml(pr.sessionName || pr.sessionId || "unknown") + '</a></div>';
    }

    return '<div class="pr-card state-' + stateClass + '">'
      + '<div class="pr-header-row">'
      + '<a class="pr-title" href="' + escHtml(pr.url) + '" target="_blank" rel="noopener">' + escHtml(pr.title) + '</a>'
      + '<span class="pr-number">#' + pr.number + '</span>'
      + '<span class="pr-state-badge ' + stateBadge + '">' + stateBadge + '</span>'
      + '</div>'
      + '<div class="pr-meta-row">'
      + '<span>&#x1f4c1; ' + escHtml(pr.owner + '/' + pr.repo) + '</span>'
      + '<span>&#x1f464; ' + escHtml(pr.author) + '</span>'
      + (pr.createdAt ? '<span>&#x1f552; created ' + relativeTimeFromISO(pr.createdAt) + '</span>' : '')
      + (pr.updatedAt ? '<span>&#x1f504; updated ' + relativeTimeFromISO(pr.updatedAt) + '</span>' : '')
      + '</div>'
      + '<div class="pr-stats-row">'
      + '<span>&#x1f4ac; ' + pr.reviewComments + ' comments</span>'
      + '<span>&#x1f50d; ' + pr.reviews + ' reviews</span>'
      + (checksIcon ? '<span>' + checksIcon + ' Checks ' + pr.checks + '</span>' : '')
      + (mergeableIcon ? '<span>' + mergeableIcon + '</span>' : '')
      + '</div>'
      + labelsHtml
      + sessionHtml
      + '</div>';
  }).join('');
}

function goToSession(sessionId) {
  if (!sessionId) return;
  switchMainTab("sessions");
  // Set search to the session id
  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.value = sessionId;
    searchQuery = sessionId;
    renderSessions();
  }
}

// PR auto-refresh every 30s
setInterval(() => {
  if (mainTab === "prs") fetchPRs();
}, 30000);

// Init
document.addEventListener("DOMContentLoaded", function() {
  initFromHash();
  document.getElementById("sessions-tab-count").textContent = sessions.length || "0";
});
</script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

app.listen(PORT, () => {
  console.log("OpenClaw Dashboard running at http://localhost:" + PORT);
});
