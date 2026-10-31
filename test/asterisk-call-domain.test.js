const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertTransition,
  canTransition,
  isTerminalStatus,
  maskDestination,
  normalizeBrazilianDestination,
} = require("../src/services/asterisk/call-domain");

test("normaliza destino brasileiro no formato exigido pela OverTele", () => {
  assert.equal(normalizeBrazilianDestination("(11) 94734-1276"), "5511947341276");
  assert.equal(normalizeBrazilianDestination("+55 11 94734-1276"), "5511947341276");
  assert.equal(normalizeBrazilianDestination("61 3333-4444"), "556133334444");
  assert.throws(() => normalizeBrazilianDestination("12345"), /DDD e número brasileiro/);
});

test("mascara o destino sem revelar o telefone completo", () => {
  assert.equal(maskDestination("5511947341276"), "55*******1276");
  assert.equal(maskDestination("556133334444"), "55******4444");
});

test("valida a máquina de estados técnica da chamada", () => {
  assert.equal(canTransition("READY", "DIALING"), true);
  assert.equal(canTransition("DIALING", "RINGING"), true);
  assert.equal(canTransition("RINGING", "CONNECTED"), true);
  assert.equal(canTransition("CONNECTED", "ENDED"), true);
  assert.equal(canTransition("DIALING", "RECONCILING"), true);
  assert.equal(canTransition("ENDED", "CONNECTED"), false);
  assert.equal(isTerminalStatus("NO_ANSWER"), true);
  assert.equal(isTerminalStatus("CONNECTED"), false);
  assert.throws(() => assertTransition("ENDED", "CONNECTED"), /Transição de chamada inválida/);
});
