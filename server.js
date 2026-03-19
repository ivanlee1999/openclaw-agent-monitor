const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { exec: execCb } = require("child_process");
const { promisify } = require("util");
const execPromise = promisify(execCb);
const Database = require("better-sqlite3");

const DB_PATH = path.join(os.homedir(), ".openclaw", "dashboard.db");
const db = new Database(DB_PATH);

// Initialize SQLite schema
db.exec(`
  CREATE TABLE IF NOT EXISTS prs (
    url TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    state TEXT,
    merged INTEGER DEFAULT 0,
    draft INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    author TEXT,
    review_comments INTEGER DEFAULT 0,
    reviews INTEGER DEFAULT 0,
    checks TEXT DEFAULT 'unknown',
    labels TEXT DEFAULT '[]',
    mergeable INTEGER DEFAULT 0,
    body TEXT,
    session_name TEXT,
    session_id TEXT,
    fetched_at INTEGER DEFAULT 0,
    discovered_at INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    pr_owner TEXT NOT NULL,
    pr_repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    pr_title TEXT,
    user TEXT NOT NULL,
    body TEXT,
    path TEXT,
    line INTEGER,
    diff_hunk TEXT,
    state TEXT,
    priority TEXT DEFAULT 'low',
    created_at TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    fetched_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_prs_state ON prs(state);
  CREATE INDEX IF NOT EXISTS idx_prs_fetched ON prs(fetched_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_pr ON notifications(pr_url);
  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
`);
db.pragma('journal_mode = WAL');


async function ghExec(command, timeoutMs = 15000) {
  try {
    const { stdout } = await execPromise(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (err) {
    throw err;
  }
}

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

app.get("/api/sessions", async (req, res) => {
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

app.get("/api/sessions/:id/output", async (req, res) => {
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

app.get("/api/sessions/:id/history", async (req, res) => {
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

app.get("/api/sessions/:id/latest", async (req, res) => {
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
// Full PR list cache (stale-while-revalidate)
let prListCache = { data: null, fetchedAt: 0, refreshing: false };
const PR_LIST_CACHE_TTL = 300000; // 5 minutes
const PR_LIST_STALE_TTL = 600000; // serve stale for 10 minutes while refreshing

const prJsonlCache = new Map(); // key: jsonlPath -> { mtimeMs, prs: [{url, sessionId, sessionName}] }
const prGhCache = new Map(); // key: prUrl -> { fetchedAt, data }
const PR_GH_CACHE_TTL = 300000; // 5 minutes
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

async function fetchPRDetailsViaGh(prUrl) {
  const cached = prGhCache.get(prUrl);
  if (cached && (Date.now() - cached.fetchedAt) < PR_GH_CACHE_TTL) return cached.data;

  try {
    const json = await ghExec(`gh pr view "${prUrl}" --json title,state,isDraft,createdAt,updatedAt,author,statusCheckRollup,labels,mergeable,reviews,comments,number`);
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

app.get("/api/prs", (req, res) => {
  try {
    // Read from SQLite (instant) — background refresh populates the data
    const rows = db.prepare("SELECT * FROM prs ORDER BY created_at DESC").all();
    const results = rows.map(row => ({
      url: row.url,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      title: row.title || "",
      state: row.state || "unknown",
      merged: row.merged === 1,
      draft: row.draft === 1,
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",
      author: row.author || "",
      reviewComments: row.review_comments || 0,
      reviews: row.reviews || 0,
      checks: row.checks || "unknown",
      labels: JSON.parse(row.labels || "[]"),
      mergeable: row.mergeable === 1,
      sessionName: row.session_name || "",
      sessionId: row.session_id || ""
    }));

    // If DB is empty, trigger background refresh
    if (rows.length === 0) {
      triggerBackgroundRefresh().catch(() => {});
    }

    res.json(results);
  } catch (err) {
    console.error("Error fetching PRs:", err.message);
    res.status(500).json({ error: "Failed to fetch PRs" });
  }
});

app.get("/api/prs/:owner/:repo/:number", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;

    // Try to find session info from our cache
    const allPrs = getAllPRsFromJsonls();
    const pr = allPrs.find(p => p.url === url) || { url, owner, repo, number: parseInt(number), sessionId: "", sessionName: "", harnessSessionId: "" };

    // Fetch detailed info including review comments
    let ghData = null;
    try {
      const json = await ghExec(`gh pr view "${url}" --json title,state,isDraft,createdAt,updatedAt,author,statusCheckRollup,labels,mergeable,reviews,comments,number,body`);
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

// --- Notifications API ---
const notificationsCache = { data: null, fetchedAt: 0, refreshing: false };
const NOTIFICATIONS_CACHE_TTL = 300000; // 5 minutes // 2 minutes

const BOT_PATTERNS = ['[bot]', 'copilot', 'github-actions', 'dependabot'];

function isBot(login) {
  if (!login) return false;
  const lower = login.toLowerCase();
  return BOT_PATTERNS.some(p => lower.includes(p));
}

async function fetchPRCommentsViaGh(owner, repo, number, prTitle) {
  const notifications = [];
  const prInfo = { owner, repo, number, title: prTitle || '' };

  // 1. Review comments (inline code comments)
  try {
    const raw = await ghExec(`gh api repos/${owner}/${repo}/pulls/${number}/comments --paginate`);
    const comments = JSON.parse(raw);
    for (const c of comments) {
      notifications.push({
        type: 'review_comment',
        id: c.id,
        pr: prInfo,
        user: c.user?.login || '',
        body: c.body || '',
        path: c.path || '',
        line: c.original_line || c.line || null,
        diffHunk: c.diff_hunk || '',
        state: null,
        createdAt: c.created_at || c.updated_at || '',
        priority: isBot(c.user?.login) ? 'low' : 'high'
      });
    }
  } catch (err) {
    console.error(`Failed to fetch review comments for ${owner}/${repo}#${number}:`, err.message);
  }

  // 2. Reviews (approve/request changes/comment)
  try {
    const raw = await ghExec(`gh api repos/${owner}/${repo}/pulls/${number}/reviews --paginate`);
    const reviews = JSON.parse(raw);
    for (const r of reviews) {
      // Skip empty PENDING reviews
      if (r.state === 'PENDING' && !r.body) continue;
      notifications.push({
        type: 'review',
        id: r.id,
        pr: prInfo,
        user: r.user?.login || '',
        body: r.body || '',
        path: null,
        line: null,
        diffHunk: null,
        state: r.state || '',
        createdAt: r.submitted_at || '',
        priority: isBot(r.user?.login) ? 'low' : 'high'
      });
    }
  } catch (err) {
    console.error(`Failed to fetch reviews for ${owner}/${repo}#${number}:`, err.message);
  }

  // 3. Issue comments (general PR comments)
  try {
    const raw = await ghExec(`gh api repos/${owner}/${repo}/issues/${number}/comments --paginate`);
    const comments = JSON.parse(raw);
    for (const c of comments) {
      notifications.push({
        type: 'issue_comment',
        id: c.id,
        pr: prInfo,
        user: c.user?.login || '',
        body: c.body || '',
        path: null,
        line: null,
        diffHunk: null,
        state: null,
        createdAt: c.created_at || '',
        priority: isBot(c.user?.login) ? 'low' : 'high'
      });
    }
  } catch (err) {
    console.error(`Failed to fetch issue comments for ${owner}/${repo}#${number}:`, err.message);
  }

  return notifications;
}

app.get("/api/notifications", (_req, res) => {
  try {
    // Read from SQLite (instant) — background refresh populates the data
    const rows = db.prepare("SELECT * FROM notifications ORDER BY created_at DESC").all();
    const results = rows.map(row => ({
      type: row.type,
      id: row.id,
      pr: { owner: row.pr_owner, repo: row.pr_repo, number: row.pr_number, title: row.pr_title || "" },
      user: row.user,
      body: row.body || "",
      path: row.path || undefined,
      line: row.line || undefined,
      diffHunk: row.diff_hunk || undefined,
      state: row.state || undefined,
      priority: row.priority || "low",
      createdAt: row.created_at,
      read: row.read === 1
    }));
    res.json(results);
  } catch (err) {
    console.error("Error fetching notifications:", err.message);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.get("/api/prs/:owner/:repo/:number/comments", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;

    // Try to get PR title
    const ghData = await fetchPRDetailsViaGh(url);
    const title = ghData?.title || '';

    const comments = await fetchPRCommentsViaGh(owner, repo, parseInt(number), title);

    // Sort newest first
    comments.sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json(comments);
  } catch (err) {
    console.error("Error fetching PR comments:", err.message);
    res.status(500).json({ error: "Failed to fetch PR comments" });
  }
});

// --- Notification read state (in-memory) ---
const readNotifications = new Set();

app.use(express.json());

app.post("/api/notifications/:id/read", (req, res) => {
  const id = req.params.id;
  try {
    db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/:id/unread", (req, res) => {
  const id = req.params.id;
  try {
    db.prepare("UPDATE notifications SET read = 0 WHERE id = ?").run(id);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/read-all", (_req, res) => {
  try {
    const result = db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
    res.json({ success: true, count: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/refresh", async (_req, res) => {
  try {
    console.log("[api] Manual notification refresh triggered");
    // Trigger refresh in background
    triggerNotificationRefresh().catch(err => console.error("[api] Notification refresh failed:", err.message));
    res.json({ success: true, message: "Notification refresh triggered" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Background refresh: simplified version - just log PRs for now
async function triggerBackgroundRefresh() {
  console.log("[bg] Refreshing PRs...");
  try {
    const prs = getAllPRsFromJsonls();
    for (const pr of prs) {
      // Check if PR already in DB
      const existing = db.prepare("SELECT url, fetched_at, discovered_at FROM prs WHERE url = ?").get(pr.url);
      const now = Date.now();
      // Skip if fetched recently (within 5 min)
      if (existing && (now - existing.fetched_at) < 300000) continue;

      // Fetch from GitHub
      try {
        const ghData = await fetchPRDetailsViaGh(pr.url);
        if (!ghData) continue;
        const state = ghData.state === "MERGED" ? "merged" : ghData.state === "CLOSED" ? "closed" : "open";
        const merged = ghData.state === "MERGED" ? 1 : 0;

        const insertArgs = [
          pr.url, pr.owner, pr.repo, pr.number,
          ghData.title || "", state, merged, ghData.isDraft ? 1 : 0,
          ghData.createdAt || "", ghData.updatedAt || "",
          ghData.author?.login || "",
          (Array.isArray(ghData.comments) ? ghData.comments.length : (ghData.comments || 0)),
          (Array.isArray(ghData.reviews) ? ghData.reviews.length : (ghData.reviews?.length || 0)),
          "unknown", JSON.stringify(ghData.labels?.map(l => l.name) || []),
          ghData.mergeable === "MERGEABLE" ? 1 : 0,
          ghData.body || "",
          pr.sessionName || "", pr.sessionId || "", now, (existing ? existing.discovered_at : now)
        ];
        console.log("[bg] Inserting PR", pr.url, "args count:", insertArgs.length);
        db.prepare(`INSERT OR REPLACE INTO prs (url, owner, repo, number, title, state, merged, draft, created_at, updated_at, author, review_comments, reviews, checks, labels, mergeable, body, session_name, session_id, fetched_at, discovered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...insertArgs);
      } catch (err) {
        console.error("[bg] Failed to fetch PR", pr.url, err.message);
      }
    }
    console.log("[bg] PR refresh complete");
    // Trigger notification refresh immediately after PR refresh to capture comments on new PRs
    triggerNotificationRefresh().catch(err => console.error("[bg] Failed to trigger notification refresh:", err.message));
  } catch (err) {
    console.error("[bg] Refresh error:", err.message);
  }
}



// Background notification refresh: fetch comments for open PRs and populate SQLite
async function triggerNotificationRefresh() {
  console.log("[bg-notif] Refreshing notifications...");
  try {
    // Include open PRs + recently merged/closed (last 24h) so we don't miss comments on fast-merged PRs
    const openPRs = db.prepare("SELECT owner, repo, number, title FROM prs WHERE state = 'open' OR (state IN ('merged','closed') AND fetched_at > ?)").all(Date.now() - 86400000);
    console.log("[bg-notif] Checking", openPRs.length, "open PRs for comments");
    
    const insertStmt = db.prepare(`INSERT OR IGNORE INTO notifications 
      (id, type, pr_url, pr_owner, pr_repo, pr_number, pr_title, user, body, path, line, diff_hunk, state, priority, created_at, read, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
    
    let inserted = 0;
    for (const pr of openPRs) {
      try {
        const comments = await fetchPRCommentsViaGh(pr.owner, pr.repo, pr.number, pr.title);
        const now = Date.now();
        for (const c of comments) {
          const prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
          const result = insertStmt.run(
            String(c.id), c.type, prUrl, pr.owner, pr.repo, pr.number, pr.title || "",
            c.user || "", c.body || "", c.path || null, c.line || null, 
            c.diffHunk || null, c.state || null, c.priority || "low",
            c.createdAt || "", now
          );
          if (result.changes > 0) inserted++;
        }
      } catch (err) {
        console.error("[bg-notif] Error for", pr.owner + "/" + pr.repo + "#" + pr.number, err.message);
      }
    }
    console.log("[bg-notif] Done. Inserted", inserted, "new notifications");
  } catch (err) {
    console.error("[bg-notif] Refresh error:", err.message);
  }
}

// Run PR refresh every 5 minutes + on startup
setTimeout(() => triggerBackgroundRefresh().catch(console.error), 5000);
setInterval(() => triggerBackgroundRefresh().catch(console.error), 300000);

// Run notification refresh 30s after startup (after PR refresh), then every 2 minutes
setTimeout(() => triggerNotificationRefresh().catch(console.error), 30000);
setInterval(() => triggerNotificationRefresh().catch(console.error), 120000);

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

/* Notifications view */
.notifications-view { display: none; }
.notifications-view.active { display: block; }

.notif-summary {
  display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  margin-bottom: 16px; font-size: 13px; color: var(--text-secondary);
}
.notif-summary .notif-stat {
  display: inline-flex; align-items: center; gap: 5px;
}
.notif-summary .notif-stat-value {
  font-weight: 700; color: var(--text-heading);
}
.notif-summary .notif-stat-value.high-val { color: var(--failed); }
.notif-summary .notif-stat-value.low-val { color: var(--text-muted); }

.notif-filter-bar {
  display: flex; gap: 0; margin-bottom: 20px; flex-wrap: wrap; align-items: center;
  border-bottom: 1px solid var(--border); padding-bottom: 0;
}


.notif-unread { background: var(--card-hover); }
.notif-read { opacity: 0.6; }
.notif-read-btn { cursor: pointer; border: none; background: none; color: var(--text-muted); font-size: 16px; padding: 4px 8px; border-radius: 4px; }
.notif-read-btn:hover { color: var(--accent); background: var(--bg-surface, var(--surface)); }
.notif-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 2px;
  border-left: 4px solid var(--text-muted); padding: 16px 20px;
  transition: background 0.1s; margin-bottom: 10px;
}
.notif-card:hover { background: var(--card-hover); }
.notif-card.priority-high { border-left-color: var(--failed); }
.notif-card.priority-low { border-left-color: var(--text-muted); }

.notif-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;
}
.notif-user {
  font-size: 14px; font-weight: 600; color: var(--text-heading);
}
.notif-bot-badge {
  font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
  padding: 1px 6px; border-radius: 2px; color: var(--text-muted);
  background: var(--surface); border: 1px solid var(--border);
}
.notif-time {
  font-size: 12px; color: var(--text-muted); margin-left: auto; font-family: var(--mono);
}
.notif-review-state {
  font-size: 12px; font-weight: 600; margin-left: 4px;
}

.notif-pr-context {
  font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;
}
.notif-pr-context a { color: var(--link); font-size: 12px; }

.notif-body {
  font-size: 13px; color: var(--text-primary); line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.notif-body-code {
  font-family: var(--mono); font-size: 12px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 2px; padding: 8px 12px;
  line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}

.notif-file-info {
  font-size: 11px; color: var(--info-accent); font-family: var(--mono);
  margin-bottom: 6px;
}

.notif-diff-hunk {
  font-family: var(--mono); font-size: 11px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 2px; padding: 8px 12px;
  max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
  margin-top: 8px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  color: var(--text-secondary);
}
.notif-diff-hunk.open { max-height: 300px; overflow-y: auto; }
.notif-diff-toggle {
  font-size: 11px; color: var(--accent); cursor: pointer; margin-top: 6px;
  display: inline-block; font-weight: 500;
}
.notif-diff-toggle:hover { text-decoration: underline; }

.notif-loading {
  text-align: center; padding: 40px; color: var(--text-muted); font-size: 14px;
}

/* PR card expansion */
.pr-card { cursor: pointer; transition: background 0.1s; }
.pr-card.expanded { border-left-width: 4px; }
.pr-expanded-content {
  display: none; border-top: 1px solid var(--border); margin-top: 12px;
  padding-top: 14px;
}
.pr-expanded-content.open { display: block; }
.pr-body-section {
  margin-bottom: 16px;
}
.pr-body-title {
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;
}
.pr-body-text {
  font-size: 13px; color: var(--text-primary); line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  background: var(--surface); border: 1px solid var(--border); border-radius: 2px;
  padding: 12px 16px; max-height: 300px; overflow-y: auto;
}
.pr-comments-section { margin-bottom: 16px; }
.pr-files-section {
  margin-bottom: 12px; font-size: 13px; color: var(--text-secondary);
}
.pr-github-link {
  display: inline-block; font-size: 13px; color: var(--link); margin-top: 8px;
}
.pr-comments-loading {
  font-size: 12px; color: var(--text-muted); font-style: italic; padding: 8px 0;
}
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
    <button class="main-tab" id="tab-notifications" onclick="switchMainTab('notifications')">&#x1f514; Notifications <span class="tab-count" id="notifications-tab-count">0</span></button>
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

  <div class="notifications-view" id="notifications-view">
    <div class="notif-summary" id="notif-summary"></div>
    <div class="notif-filter-bar" id="notif-filter-bar">
      <button class="filter-btn active" data-notif-filter="all">All</button>
      <button class="filter-btn" data-notif-filter="high">High Priority</button>
      <button class="filter-btn" data-notif-filter="low">Low Priority</button>
      <button class="filter-btn" data-notif-filter="review">Reviews</button>
      <button class="filter-btn" data-notif-filter="comment">Comments</button>
      <button class="filter-btn" data-notif-filter="unread">Unread</button>
    </div>
    <div id="notifications-list"></div>
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


async function markAllNotificationsRead() {
  await fetch("/api/notifications/read-all", { method: "POST" });
  fetchNotifications();
}

async function toggleNotifRead(id, currentRead) {
  const endpoint = currentRead ? "unread" : "read";
  await fetch("/api/notifications/" + id + "/" + endpoint, { method: "POST" });
  fetchNotifications();
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
setInterval(fetchPRs, 30000);
setInterval(fetchNotifications, 120000);

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
  window.location.hash = tab;
  document.getElementById("tab-sessions").classList.toggle("active", tab === "sessions");
  document.getElementById("tab-prs").classList.toggle("active", tab === "prs");
  document.getElementById("tab-notifications").classList.toggle("active", tab === "notifications");
  document.getElementById("sessions-view").classList.toggle("hidden", tab !== "sessions");
  document.getElementById("prs-view").classList.toggle("active", tab === "prs");
  document.getElementById("notifications-view").classList.toggle("active", tab === "notifications");
  if (tab === "prs" && prs.length === 0 && !prFetchInProgress) {
    fetchPRs();
  }
  if (tab === "notifications" && notifications.length === 0 && !notifFetchInProgress) {
    fetchNotifications();
  }
}

// Hash routing
function initFromHash() {
  const hash = window.location.hash.replace("#", "") || "sessions";
  if (hash === "prs") switchMainTab("prs");
  else if (hash === "notifications") switchMainTab("notifications");
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

let expandedPrId = null;
let prCommentsCache = {};

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
    const prKey = pr.owner + '/' + pr.repo + '/' + pr.number;
    const isExpanded = expandedPrId === prKey;
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

    let expandedHtml = '';
    if (isExpanded) {
      expandedHtml = '<div class="pr-expanded-content open">' + getPRExpandedContent(pr) + '</div>';
    }

    return '<div class="pr-card state-' + stateClass + (isExpanded ? ' expanded' : '') + '" onclick="togglePR(\\'' + escHtml(prKey) + '\\', \\'' + escHtml(pr.owner) + '\\', \\'' + escHtml(pr.repo) + '\\', ' + pr.number + ', event)">'
      + '<div class="pr-header-row">'
      + '<a class="pr-title" href="' + escHtml(pr.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + escHtml(pr.title) + '</a>'
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
      + expandedHtml
      + '</div>';
  }).join('');
}

async function togglePR(prKey, owner, repo, number, event) {
  // Don't toggle if clicking a link
  if (event && (event.target.tagName === 'A' || event.target.closest('a'))) return;
  if (event && event.target.closest('.notif-diff-toggle')) return;

  if (expandedPrId === prKey) {
    expandedPrId = null;
    renderPRs();
    return;
  }
  expandedPrId = prKey;
  renderPRs();

  // Fetch PR details and comments
  if (!prCommentsCache[prKey]) {
    try {
      const [detailRes, commentsRes] = await Promise.all([
        fetch('/api/prs/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/' + number),
        fetch('/api/prs/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/' + number + '/comments')
      ]);
      const detail = detailRes.ok ? await detailRes.json() : null;
      const comments = commentsRes.ok ? await commentsRes.json() : [];
      prCommentsCache[prKey] = { detail, comments };
    } catch (err) {
      console.error('Failed to fetch PR details:', err);
      prCommentsCache[prKey] = { detail: null, comments: [] };
    }
    if (expandedPrId === prKey) renderPRs();
  }
}

function getPRExpandedContent(pr) {
  const prKey = pr.owner + '/' + pr.repo + '/' + pr.number;
  const cached = prCommentsCache[prKey];

  if (!cached) {
    return '<div class="pr-comments-loading">&#x23f3; Loading PR details...</div>';
  }

  let html = '';

  // PR Description
  if (cached.detail && cached.detail.body) {
    html += '<div class="pr-body-section">'
      + '<div class="pr-body-title">\\u{1f4dd} Description</div>'
      + '<div class="pr-body-text">' + escHtml(cached.detail.body) + '</div>'
      + '</div>';
  }

  // Files changed count
  if (cached.detail && cached.detail.reviewComments !== undefined) {
    html += '<div class="pr-files-section">\\u{1f4c2} ' + (cached.detail.reviewComments + cached.detail.reviews) + ' total comments & reviews</div>';
  }

  // Comments & Reviews
  if (cached.comments && cached.comments.length > 0) {
    html += '<div class="pr-comments-section">'
      + '<div class="pr-body-title">\\u{1f4ac} Comments & Reviews (' + cached.comments.length + ')</div>';
    for (let i = 0; i < cached.comments.length; i++) {
      const n = cached.comments[i];
      html += renderNotifCard(n, 'pr-' + prKey.replace(/\\//g, '-') + '-' + i);
    }
    html += '</div>';
  } else {
    html += '<div class="pr-comments-loading">No comments or reviews yet</div>';
  }

  // GitHub link
  html += '<a class="pr-github-link" href="' + escHtml(pr.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">\\u{1f517} View on GitHub &rarr;</a>';

  return html;
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

// --- Notifications Tab ---
let notifications = [];
let notifFilter = "all";
let notifFetchInProgress = false;

// Notif filter click handler
document.getElementById("notif-filter-bar").addEventListener("click", (e) => {
  if (!e.target.matches("[data-notif-filter]")) return;
  document.querySelectorAll("[data-notif-filter]").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  notifFilter = e.target.dataset.notifFilter;
  renderNotifications();
});

async function fetchNotifications() {
  if (notifFetchInProgress) return;
  notifFetchInProgress = true;
  const list = document.getElementById("notifications-list");
  if (notifications.length === 0) list.innerHTML = '<div class="notif-loading">&#x23f3; Loading notifications...</div>';
  try {
    const res = await fetch("/api/notifications");
    if (!res.ok) throw new Error("fetch failed");
    notifications = await res.json();
    renderNotifSummary();
    renderNotifications();
    document.getElementById("notifications-tab-count").textContent = notifications.length;
  } catch (err) {
    console.error("Failed to fetch notifications:", err);
    list.innerHTML = '<div class="notif-loading">Failed to load notifications</div>';
  } finally {
    notifFetchInProgress = false;
  }
}

function renderNotifSummary() {
  const total = notifications.length;
  const high = notifications.filter(n => n.priority === "high").length;
  const unread = notifications.filter(n => !n.read).length;
  const low = notifications.filter(n => n.priority === "low").length;
  document.getElementById("notif-summary").innerHTML =
    '<span class="notif-stat"><span class="notif-stat-value">' + total + '</span> Total</span>'
    + '<span class="notif-stat"><span class="notif-stat-value high-val">' + high + '</span> High Priority</span>'
    + '<span class="notif-stat"><span class="notif-stat-value low-val">' + low + '</span> Low Priority</span>';
}

function renderNotifications() {
  const list = document.getElementById("notifications-list");
  let filtered = notifications;
  if (notifFilter === "high") filtered = notifications.filter(n => n.priority === "high");
  else if (notifFilter === "low") filtered = notifications.filter(n => n.priority === "low");
  else if (notifFilter === "review") filtered = notifications.filter(n => n.type === "review");
  else if (notifFilter === "comment") filtered = notifications.filter(n => n.type === "review_comment" || n.type === "issue_comment");

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">\\u{1f514}</div>'
      + '<h2>No notifications</h2><p>' + (notifications.length === 0 ? 'No comments or reviews on agent PRs yet' : 'No notifications match this filter') + '</p></div>';
    return;
  }

  list.innerHTML = filtered.map((n, i) => renderNotifCard(n, i)).join('');
}

function renderNotifCard(n, idx) {
  const bot = isBot(n.user);
  const priorityClass = n.priority === "high" ? "priority-high" : "priority-low";

  let stateIcon = '';
  if (n.type === "review") {
    if (n.state === "APPROVED") stateIcon = '<span class="notif-review-state" style="color:var(--completed)">\\u2705 Approved</span>';
    else if (n.state === "CHANGES_REQUESTED") stateIcon = '<span class="notif-review-state" style="color:var(--failed)">\\u274c Changes Requested</span>';
    else if (n.state === "COMMENTED") stateIcon = '<span class="notif-review-state" style="color:var(--text-secondary)">\\u{1f4ac} Commented</span>';
    else if (n.state === "DISMISSED") stateIcon = '<span class="notif-review-state" style="color:var(--text-muted)">Dismissed</span>';
    else stateIcon = '<span class="notif-review-state" style="color:var(--text-muted)">' + escHtml(n.state) + '</span>';
  }

  let typeLabel = '';
  if (n.type === "review_comment") typeLabel = "Review Comment";
  else if (n.type === "review") typeLabel = "Review";
  else if (n.type === "issue_comment") typeLabel = "Comment";

  let fileInfo = '';
  if (n.type === "review_comment" && n.path) {
    fileInfo = '<div class="notif-file-info">\\u{1f4c4} ' + escHtml(n.path) + (n.line ? ':' + n.line : '') + '</div>';
  }

  let diffHunk = '';
  if (n.type === "review_comment" && n.diffHunk) {
    diffHunk = '<div class="notif-diff-toggle" onclick="event.stopPropagation(); toggleNotifDiff(\\'' + idx + '\\')">\\u25b6 Show diff context</div>'
      + '<div class="notif-diff-hunk" id="notif-diff-' + idx + '">' + escHtml(n.diffHunk) + '</div>';
  }

  const bodyHasCode = n.body && (n.body.includes('\`') || n.body.includes('    ') || n.body.includes('\\t'));
  const bodyClass = bodyHasCode ? 'notif-body-code' : 'notif-body';
  const bodyContent = n.body ? '<div class="' + bodyClass + '">' + escHtml(n.body) + '</div>' : '';

  const prCtx = n.pr ? '<div class="notif-pr-context">' + escHtml(typeLabel) + ' on <a href="https://github.com/' + escHtml(n.pr.owner) + '/' + escHtml(n.pr.repo) + '/pull/' + n.pr.number + '" target="_blank" rel="noopener">' + escHtml(n.pr.owner + '/' + n.pr.repo) + '#' + n.pr.number + '</a> &mdash; ' + escHtml(truncate(n.pr.title, 60)) + '</div>' : '';

  return '<div class="notif-card ' + priorityClass + '">'
    + '<div class="notif-header">'
    + '<span class="notif-user">' + escHtml(n.user) + '</span>'
    + (bot ? '<span class="notif-bot-badge">BOT</span>' : '')
    + stateIcon
    + '<span class="notif-time" title="' + escHtml(n.createdAt) + '">' + relativeTimeFromISO(n.createdAt) + '</span>'
    + '</div>'
    + prCtx
    + fileInfo
    + bodyContent
    + diffHunk
    + '</div>';
}

function isBot(login) {
  if (!login) return false;
  const lower = login.toLowerCase();
  return ['[bot]', 'copilot', 'github-actions', 'dependabot'].some(p => lower.includes(p));
}

function toggleNotifDiff(idx) {
  const el = document.getElementById("notif-diff-" + idx);
  if (!el) return;
  const toggle = el.previousElementSibling;
  if (el.classList.contains("open")) {
    el.classList.remove("open");
    if (toggle) toggle.innerHTML = "\\u25b6 Show diff context";
  } else {
    el.classList.add("open");
    if (toggle) toggle.innerHTML = "\\u25bc Hide diff context";
  }
}

// Notifications auto-refresh every 2 minutes
setInterval(() => {
  if (mainTab === "notifications") fetchNotifications();
}, 120000);

// Init
document.addEventListener("DOMContentLoaded", function() {
  initFromHash();
  document.getElementById("sessions-tab-count").textContent = sessions.length || "0";
  // Fetch PR and notification counts after DOM is ready
  fetchPRs();
  fetchNotifications();
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
