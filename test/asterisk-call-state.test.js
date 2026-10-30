const assert = require("node:assert/strict");
const test = require("node:test");
const { statusTimestamps, transitionCall } = require("../src/services/asterisk/call-state");

function fakeDatabase(call) {
  const events = [];
  const tx = {
    $queryRaw: async () => [call],
    call: {
      update: async ({ data }) => Object.assign(call, data),
      findUnique: async () => call,
    },
    callEvent: {
      findFirst: async () => ({ seq: 2 }),
      create: async ({ data }) => { events.push(data); return data; },
    },
  };
  return { database: { $transaction: (work) => work(tx) }, events };
}

test("define o timestamp correspondente a cada estado", () => {
  const now = new Date("2026-10-29T18:00:00.000Z");
  assert.deepEqual(statusTimestamps("DIALING", now), { dialingAt: now });
  assert.deepEqual(statusTimestamps("RINGING", now), { ringingAt: now });
  assert.deepEqual(statusTimestamps("CONNECTED", now), { answeredAt: now });
  assert.deepEqual(statusTimestamps("ENDED", now), { endedAt: now });
});

test("persiste transição e evento sequencial sob lock", async () => {
  const call = { id: "call-1", status: "DIALING", answeredAt: null };
  const { database, events } = fakeDatabase(call);
  const now = new Date("2026-10-29T18:00:00.000Z");
  await transitionCall(database, call.id, "RINGING", { occurredAt: now, reason: "carrier ringing" });
  assert.equal(call.status, "RINGING");
  assert.equal(call.ringingAt, now);
  assert.equal(events[0].seq, 3);
  assert.equal(events[0].status, "RINGING");
});

test("encerramento calcula duração após atendimento", async () => {
  const call = { id: "call-1", status: "CONNECTED", answeredAt: new Date("2026-10-29T18:00:00.000Z") };
  const { database } = fakeDatabase(call);
  await transitionCall(database, call.id, "ENDED", { occurredAt: new Date("2026-10-29T18:00:12.400Z") });
  assert.equal(call.durationSec, 12);
  assert.equal(call.status, "ENDED");
});
