const test = require("node:test");
const assert = require("node:assert/strict");
const { AriClient, AriRequestError } = require("../src/services/asterisk/ari-client");

function config(overrides = {}) {
  return {
    enabled: true,
    ariHttpUrl: "http://127.0.0.1:18088",
    ariWsUrl: "ws://127.0.0.1:18088",
    ariApp: "crm_browser_poc",
    ariUser: "usuario-teste",
    ariPassword: "senha-teste",
    ...overrides,
  };
}

test("monta requisição ARI autenticada sem expor credenciais na URL", async () => {
  let captured;
  const client = new AriClient(config(), {
    fetch: async (url, options) => {
      captured = { url: url.toString(), options };
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "channel-1" }]) };
    },
  });
  const body = await client.get("/channels", { app: "crm_browser_poc" });
  assert.deepEqual(body, [{ id: "channel-1" }]);
  assert.equal(captured.url, "http://127.0.0.1:18088/ari/channels?app=crm_browser_poc");
  assert.match(captured.options.headers.Authorization, /^Basic /);
  assert.equal(captured.url.includes("senha-teste"), false);
});

test("converte erro HTTP da ARI em erro tipado", async () => {
  const client = new AriClient(config(), {
    fetch: async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ message: "Channel not found" }) }),
  });
  await assert.rejects(
    client.delete("/channels/inexistente"),
    (error) => error instanceof AriRequestError && error.status === 404,
  );
});

test("gera URL de eventos e abre WebSocket com autenticação privada", () => {
  let captured;
  class FakeWebSocket {
    constructor(url, options) { captured = { url, options }; }
  }
  const client = new AriClient(config(), { WebSocket: FakeWebSocket });
  client.openEvents();
  assert.equal(captured.url, "ws://127.0.0.1:18088/ari/events?app=crm_browser_poc");
  assert.match(captured.options.headers.Authorization, /^Basic /);
});

test("obtém o arquivo armazenado sem consumir o corpo binário", async () => {
  let capturedUrl;
  const binaryResponse = {
    ok: true,
    status: 200,
    body: { stream: true },
    headers: new Map([["content-type", "audio/wav"]]),
  };
  const client = new AriClient(config(), {
    fetch: async (url) => { capturedUrl = url.toString(); return binaryResponse; },
  });
  const response = await client.storedRecordingFile("call 123");
  assert.equal(capturedUrl, "http://127.0.0.1:18088/ari/recordings/stored/call%20123/file");
  assert.equal(response, binaryResponse);
});

test("recusa uso quando integração está desativada ou sem credenciais", () => {
  assert.throws(() => new AriClient(config({ enabled: false })).openEvents(), /desativada/);
  assert.throws(() => new AriClient(config({ ariPassword: "" })).openEvents(), /não configuradas/);
});
