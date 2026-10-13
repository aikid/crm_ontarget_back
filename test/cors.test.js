const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const env = require("../src/config/env");
const { normalizeOrigin, originList } = require("../src/config/origins");

test("normaliza origens configuradas e remove duplicatas", () => {
  assert.equal(normalizeOrigin("https://exemplo.vercel.app/"), "https://exemplo.vercel.app");
  assert.deepEqual(
    originList("https://exemplo.vercel.app/, https://exemplo.vercel.app"),
    ["https://exemplo.vercel.app"],
  );
});

test("preflight libera somente origens configuradas com credenciais", async () => {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const allowedOrigin = env.frontendUrls[0];
    const allowed = await fetch(`${baseUrl}/api/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

    const rejected = await fetch(`${baseUrl}/api/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://origem-nao-autorizada.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
