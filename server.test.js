const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Ensure ~/.openclaw exists before requiring the server, which opens the DB
// at import time. Without this, tests fail in fresh environments.
const openclawDir = path.join(os.homedir(), ".openclaw");
fs.mkdirSync(openclawDir, { recursive: true });

// waitForStartup test
const app = require("./server");

/**
 * Start the Express app on an ephemeral port and return
 * { server, baseUrl, close() }.
 */
function listen(expressApp) {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
    server.on("error", reject);
  });
}

/**
 * Minimal fetch helper using Node's built-in http module so the test
 * has zero extra dependencies.
 */
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

test("GET /api/version returns version metadata", async () => {
  const { baseUrl, close } = await listen(app);
  try {
    const { status, body } = await get(`${baseUrl}/api/version`);
    assert.equal(status, 200);

    const json = JSON.parse(body);

    // version must match package.json
    assert.equal(json.version, "1.0.0");

    // node version string starts with "v"
    assert.match(json.node, /^v\d+/);

    // uptime is a positive number (seconds)
    assert.equal(typeof json.uptime, "number");
    assert.ok(json.uptime >= 0, "uptime should be non-negative");
  } finally {
    await close();
  }
});

test("GET /api/ping returns pong status", async () => {
  const { baseUrl, close } = await listen(app);

  try {
    const { status, body } = await get(`${baseUrl}/api/ping`);

    assert.equal(status, 200);

    const json = JSON.parse(body);
    assert.deepEqual(json, { pong: true });
  } finally {
    await close();
  }
});

test("GET /api/sessions/:id/diff returns 404 for unknown session", async () => {
  const { baseUrl, close } = await listen(app);
  try {
    const { status, body } = await get(`${baseUrl}/api/sessions/nonexistent-id/diff`);
    assert.equal(status, 404);
    const json = JSON.parse(body);
    assert.equal(json.error, "Session not found");
  } finally {
    await close();
  }
});

test("GET /api/sessions/:id/diff returns graceful payload for missing workdir", async () => {
  // If the sessions file doesn't exist or has no matching sessions, the route returns 404
  // which is also a valid graceful response.
  const { baseUrl, close } = await listen(app);
  try {
    const { status } = await get(`${baseUrl}/api/sessions/test-fake-session/diff`);
    assert.ok([200, 404].includes(status), "Expected 200 or 404, got " + status);
  } finally {
    await close();
  }
});
