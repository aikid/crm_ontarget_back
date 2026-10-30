const assert = require("node:assert/strict");
const test = require("node:test");
const { AsteriskCallEngine, failureFromCause } = require("../src/services/asterisk/call-engine");

function config(overrides = {}) {
  return {
    webAppArg: "web201",
    webChannelPrefix: "PJSIP/201-",
    trunkName: "overtele",
    ariApp: "crm_browser_poc",
    intentTtlSeconds: 30,
    maxCallSeconds: 120,
    ...overrides,
  };
}

function harness(callOverrides = {}) {
  const calls = [];
  const transitions = [];
  const call = {
    id: "call-1",
    status: "READY",
    destinationE164: "5511999999999",
    ariWebChannelId: "web-1",
    ariRemoteChannelId: "remote-1",
    ariBridgeId: null,
    answeredAt: null,
    recording: null,
    ...callOverrides,
  };
  const database = {
    call: {
      findFirst: async () => call,
      findMany: async () => [call],
      findUnique: async () => call,
      update: async ({ data }) => Object.assign(call, data),
    },
    callRecording: {
      upsert: async ({ create }) => { call.recording = create; return create; },
      update: async ({ data }) => { Object.assign(call.recording, data); },
      updateMany: async () => {},
    },
  };
  const client = {
    post: async (path, query) => { calls.push({ method: "POST", path, query }); },
    get: async () => [],
    delete: async (path) => { calls.push({ method: "DELETE", path }); },
  };
  const engine = new AsteriskCallEngine({
    database,
    client,
    config: config(),
    logger: { warn() {}, error() {} },
    transition: async (_db, _id, status, options) => {
      transitions.push({ status, options });
      call.status = status;
      if (status === "CONNECTED") call.answeredAt = new Date();
      return call;
    },
    persistEvent: async () => {},
  });
  return { call, calls, database, engine, transitions };
}

test("mapeia causas Q.850 sem confundir falha técnica com ocupado", () => {
  assert.equal(failureFromCause(17, "User busy"), "BUSY");
  assert.equal(failureFromCause(19, "No answer"), "NO_ANSWER");
  assert.equal(failureFromCause(21, "Call rejected"), "REJECTED");
  assert.equal(failureFromCause(1, "Unallocated number"), "FAILED");
});

test("não associa canal WebRTC quando existem duas intenções pendentes", async () => {
  const { database, engine } = harness();
  database.call.findMany = async () => [{ id: "a" }, { id: "b" }];
  const result = await engine.pendingIntent({ args: ["web201"], channel: { name: "PJSIP/201-abc" } });
  assert.equal(result, null);
});

test("limita a intenção ao SDR proprietário do ramal SIP", async () => {
  const { call, database, engine } = harness();
  engine.config.sipAccountsJson = JSON.stringify({
    "diego@example.com": { extension: "202", password: "secret" },
  });
  let where;
  database.call.findMany = async (query) => { where = query.where; return [call]; };
  const result = await engine.pendingIntent({ args: ["web201"], channel: { name: "PJSIP/202-abc" } });
  assert.equal(result.id, call.id);
  assert.equal(where.sdr.is.email, "diego@example.com");
});

test("origina pela OverTele somente após validar canal e intenção", async () => {
  const { call, calls, engine, transitions } = harness({ ariWebChannelId: null, ariRemoteChannelId: null });
  await engine.handleWebChannel({
    type: "StasisStart",
    args: ["web201"],
    channel: { id: "web-1", name: "PJSIP/201-abc" },
  });
  assert.equal(call.ariWebChannelId, "web-1");
  assert.match(call.ariRemoteChannelId, /^[0-9a-f-]{36}$/);
  assert.equal(transitions[0].status, "DIALING");
  assert.equal(calls[0].path, "/channels/web-1/ring");
  assert.equal(calls[1].path, "/channels");
  assert.equal(calls[1].query.endpoint, "PJSIP/5511999999999@overtele");
  assert.equal(calls[1].query.appArgs, "outbound");
});

test("cria bridge, inicia gravação dos dois lados e marca CONNECTED", async () => {
  const { call, calls, engine, transitions } = harness({ status: "DIALING" });
  await engine.handleRemoteAnswered({
    type: "StasisStart",
    args: ["outbound"],
    channel: { id: "remote-1", state: "Up" },
  });
  assert.match(call.ariBridgeId, /^[0-9a-f-]{36}$/);
  assert.equal(call.recording.status, "RECORDING");
  assert.equal(call.recording.name, "call_call-1");
  assert.deepEqual(calls.map((item) => item.path), [
    "/channels/web-1/answer",
    "/bridges",
    `/bridges/${call.ariBridgeId}/addChannel`,
    `/bridges/${call.ariBridgeId}/record`,
  ]);
  assert.equal(transitions.at(-1).status, "CONNECTED");
});

test("Ringing remoto atualiza estado técnico", async () => {
  const { engine, transitions } = harness({ status: "DIALING" });
  await engine.handleChannelState({ type: "ChannelStateChange", channel: { id: "remote-1", state: "Ringing" } });
  assert.equal(transitions[0].status, "RINGING");
});

test("aguarda ChannelDestroyed para não perder a causa Q.850 remota", async () => {
  const { engine, transitions } = harness({ status: "DIALING" });
  await engine.handleChannelEnded({ type: "StasisEnd", channel: { id: "remote-1" } });
  assert.equal(transitions.length, 0);
});
