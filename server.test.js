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

test("GET /api/ping returns pong status and current timestamp", async () => {
  const { baseUrl, close } = await listen(app);
  const before = Date.now();

  try {
    const { status, body } = await get(`${baseUrl}/api/ping`);
    const after = Date.now();

    assert.equal(status, 200);

    const json = JSON.parse(body);
    assert.equal(json.pong, true);
    assert.equal(typeof json.timestamp, "number");
    assert.ok(json.timestamp >= before, "timestamp should be >= time before request");
    assert.ok(json.timestamp <= after, "timestamp should be <= time after request");
  } finally {
    await close();
  }
});
