# 🐾 OpenClaw Agent Monitor

A lightweight web dashboard for monitoring [OpenClaw Code Agent](https://github.com/goldmar/openclaw-code-agent) sessions in real time.

![Catppuccin Dark](https://img.shields.io/badge/theme-Catppuccin-cba6f7?style=flat-square) ![Node.js](https://img.shields.io/badge/node-18+-green?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

## Features

- **Session Cards** — Status, cost, duration, model (extracted from Claude Code JSONL), and live preview of current activity
- **Timeline View** — Expand any session to see a step-by-step timeline: file reads, edits (with diffs), bash commands, and assistant reasoning
- **Files Touched** — Summary of all files read/edited/written per session
- **Light/Dark Theme** — Catppuccin Latte (light) and Mocha (dark) with toggle, saved to localStorage
- **Search & Filter** — Filter by status (running/completed/failed/killed) and search by name, prompt, or workdir
- **Auto-Refresh** — Session list and live previews refresh every 5 seconds
- **Stats API** — Aggregate stats: total sessions, cost, average duration, cost by day
- **JSONL Caching** — Mtime-based cache so timeline parsing doesn't re-read unchanged files
- **Responsive** — 2-column grid on desktop, single column on mobile

## Screenshot

> Dark mode (Catppuccin Mocha) with expanded timeline view showing file edits and bash commands.

## Quick Start

```bash
git clone https://github.com/ivanlee1999/openclaw-agent-monitor.git
cd openclaw-agent-monitor
npm install
npm start
```

Open [http://localhost:3847](http://localhost:3847).

## Data Sources

- **Session index**: `~/.openclaw/code-agent-sessions.json` (written by the [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent) plugin)
- **Session history**: `~/.claude/projects/*/<sessionId>.jsonl` (written by Claude Code)

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Lightweight health check returning `{ ok: true, uptime }` |
| `GET /` | Dashboard UI |
| `GET /api/sessions` | All sessions (supports `?status=running&q=search`) |
| `GET /api/sessions/:id/output` | Raw text output for a session |
| `GET /api/sessions/:id/history` | Full timeline (parsed from JSONL) |
| `GET /api/sessions/:id/latest` | Last 3 timeline entries (for live preview) |
| `GET /api/stats` | Aggregate stats (total, cost, avg duration, by status, by day) |

## Run as a Service

```bash
# systemd user service (survives reboots)
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/openclaw-dashboard.service << 'SVC'
[Unit]
Description=OpenClaw Agent Monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/openclaw-agent-monitor
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SVC

systemctl --user daemon-reload
systemctl --user enable --now openclaw-dashboard
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3847` | Server port |
| `SESSIONS_FILE` | `~/.openclaw/code-agent-sessions.json` | Path to session index |

## Tech Stack

- **Express** — HTTP server
- **Catppuccin** — Color palette (Latte + Mocha)
- **Zero build tools** — Single `server.js` with embedded HTML/CSS/JS

## License

MIT
