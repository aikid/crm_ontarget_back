const test = require("node:test");
const assert = require("node:assert/strict");
const { appendCallEvent } = require("../src/services/asterisk/call-events");
const { eventIdentity, sanitizedPayload } = require("../src/services/asterisk/ari-event-store");

function fakePrisma() {
  const events = [];
  const tx = {
    async $queryRaw() { return [{ id: "call-1" }]; },
    callEvent: {
      async findFirst({ where, orderBy }) {
        if (where.dedupeKey) return events.find((item) => item.callId === where.callId && item.dedupeKey === where.dedupeKey) || null;
        const matching = events.filter((item) => item.callId === where.callId);
        return orderBy ? matching.sort((a, b) => b.seq - a.seq)[0] || null : matching[0] || null;
      },
      async create({ data }) {
        const item = { id: `event-${events.length + 1}`, ...data };
        events.push(item);
        return item;
      },
    },
  };
  return { events, async $transaction(callback) { return callback(tx); } };
}

test("persiste sequência monotônica e deduplica o mesmo evento", async () => {
  const prisma = fakePrisma();
  const base = { callId: "call-1", type: "ari.ChannelStateChange", source: "ARI" };
  const first = await appendCallEvent(prisma, { ...base, dedupeKey: "hash-1" });
  const repeated = await appendCallEvent(prisma, { ...base, dedupeKey: "hash-1" });
  const second = await appendCallEvent(prisma, { ...base, dedupeKey: "hash-2" });
  assert.equal(first.id, repeated.id);
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(prisma.events.length, 2);
});

test("identidade do evento é determinística e payload armazenado é minimizado", () => {
  const raw = {
    type: "ChannelStateChange",
    timestamp: "2026-10-29T12:00:00Z",
    channel: { id: "channel-1", name: "PJSIP/5511999999999@overtele", state: "Ringing" },
    cause: 17,
    cause_txt: "User busy",
    secret_field: "não persistir",
  };
  assert.equal(eventIdentity(raw), eventIdentity({ ...raw }));
  const payload = sanitizedPayload(raw);
  assert.equal(payload.channelId, "channel-1");
  assert.equal(payload.channelState, "Ringing");
  assert.equal("name" in payload, false);
  assert.equal(JSON.stringify(payload).includes("5511999999999"), false);
  assert.equal("secret_field" in payload, false);
});
