const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, participantForCall } = require("../src/services/three-cx");

test("normaliza o telefone para DDD e número exigidos pela 3CX", () => {
  assert.equal(normalizePhone("(11) 94734-1276"), "11947341276");
  assert.equal(normalizePhone("+55 11 94734-1276"), "11947341276");
  assert.equal(normalizePhone("6133334444"), "6133334444");
  assert.throws(() => normalizePhone("12345"), /DDD e número/);
});

test("correlaciona participante usando o callid retornado pela PBX", () => {
  const participants = [{ id: 12, callid: 9001, status: "Dialing" }, { id: 13, callid: 9002, status: "Connected" }];
  assert.deepEqual(participantForCall(participants, "9002"), participants[1]);
  assert.equal(participantForCall(participants, "9999"), null);
});
