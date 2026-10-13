const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, participantForCall } = require("../src/services/three-cx");
const callState = require("../src/services/telephony-state");

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

test("aguarda a 3CX publicar o participante antes de encerrar a chamada", () => {
  const callId = "call-startup-grace";
  const startedAt = new Date("2026-10-13T12:00:00.000Z");
  callState.remember(callId, { seenParticipant: false, status: "Dialing" });

  assert.equal(callState.shouldWaitForParticipant(callId, startedAt, startedAt.getTime() + 500), true);
  assert.equal(callState.shouldWaitForParticipant(callId, startedAt, startedAt.getTime() + 14_999), true);
  assert.equal(callState.shouldWaitForParticipant(callId, startedAt, startedAt.getTime() + 15_000), false);
  callState.forget(callId);
});

test("tolera desaparecimento transitório de participante já observado", () => {
  const callId = "call-transient-gap";
  const startedAt = new Date("2026-10-13T12:00:00.000Z");
  callState.remember(callId, { seenParticipant: true, status: "Connected" });

  assert.equal(callState.shouldWaitForParticipant(callId, startedAt, startedAt.getTime() + 20_000), true);
  assert.equal(callState.shouldWaitForParticipant(callId, startedAt, startedAt.getTime() + 21_999), true);
  assert.equal(callState.shouldWaitForParticipant(callId, startedAt, startedAt.getTime() + 22_000), false);
  callState.forget(callId);
});
