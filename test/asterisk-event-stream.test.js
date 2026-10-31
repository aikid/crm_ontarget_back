const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { AriEventStream } = require("../src/services/asterisk/ari-event-stream");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("processa eventos ARI em ordem e encerra o stream sem reconectar", async () => {
  const socket = new FakeSocket();
  const received = [];
  const client = {
    config: { enabled: true, reconnectMinMs: 1, reconnectMaxMs: 5 },
    configured: () => true,
    openEvents: () => socket,
  };
  const stream = new AriEventStream({
    client,
    logger: silentLogger(),
    onEvent: async (event) => { received.push(event.type); },
  });

  stream.start();
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ type: "StasisStart" })));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "ChannelStateChange" })));
  await stream.queue;
  await stream.stop();

  assert.deepEqual(received, ["StasisStart", "ChannelStateChange"]);
  assert.equal(stream.running, false);
  assert.equal(stream.timer, null);
});

test("não conecta enquanto Asterisk estiver desativado", () => {
  let opened = false;
  const stream = new AriEventStream({
    client: {
      config: { enabled: false, reconnectMinMs: 1, reconnectMaxMs: 5 },
      configured: () => true,
      openEvents: () => { opened = true; },
    },
    logger: silentLogger(),
  });
  stream.start();
  assert.equal(opened, false);
});
