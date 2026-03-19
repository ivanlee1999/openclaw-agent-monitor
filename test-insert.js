const Database = require('better-sqlite3');
const db = new Database('/tmp/test.db');

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
`);

const now = Date.now();
const existing = null;

const args = [
  "https://test.com/pr/1", "owner", "repo", 1,
  "title", "open", 0, 0,
  "2024-01-01", "2024-01-02",
  "author", 0, 0,
  "unknown", "[]",
  0,
  "body",
  "session", "session_id", now, (existing ? existing.discovered_at : now)
];

console.log("Number of args:", args.length);
console.log("Args:", args);

try {
  db.prepare(`INSERT OR REPLACE INTO prs (url, owner, repo, number, title, state, merged, draft, created_at, updated_at, author, review_comments, reviews, checks, labels, mergeable, body, session_name, session_id, fetched_at, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...args);
  console.log("INSERT succeeded!");
} catch (err) {
  console.error("INSERT failed:", err.message);
}

db.close();
