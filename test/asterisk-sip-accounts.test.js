const assert = require("node:assert/strict");
const test = require("node:test");
const { accountForExtension, accountForUser, parseAccounts, publicSipSession } = require("../src/services/asterisk/sip-accounts");

function config(overrides = {}) {
  return {
    sipAccountsJson: JSON.stringify({
      "ana@example.com": { extension: "201", password: "secret-ana" },
      "diego@example.com": { extension: "202", password: "secret-diego" },
    }),
    sipWebSocketUrl: "wss://voz.example.com/ws",
    sipDomain: "voz.example.com",
    internalExtension: "902",
    allowSharedSipAccount: false,
    ...overrides,
  };
}

test("entrega somente o ramal vinculado ao e-mail autenticado", () => {
  const session = publicSipSession({ email: "ANA@EXAMPLE.COM" }, config());
  assert.deepEqual(session, {
    webSocketUrl: "wss://voz.example.com/ws",
    sipDomain: "voz.example.com",
    extension: "201",
    password: "secret-ana",
    targetExtension: "902",
    shared: false,
  });
});

test("correlaciona extensão ao proprietário e rejeita SDR sem provisionamento", () => {
  assert.equal(accountForExtension("202", config()).email, "diego@example.com");
  assert.equal(accountForUser({ email: "outro@example.com" }, config()), null);
});

test("rejeita ramal duplicado entre SDRs", () => {
  const source = JSON.stringify({
    "ana@example.com": { extension: "201", password: "a" },
    "diego@example.com": { extension: "201", password: "b" },
  });
  assert.throws(() => parseAccounts(source), /mais de um SDR/);
});

test("conta compartilhada só existe quando o modo POC é explícito", () => {
  const base = config({ sipAccountsJson: "", sharedSipExtension: "201", sharedSipPassword: "poc" });
  assert.equal(accountForUser({ email: "ana@example.com" }, base), null);
  assert.equal(accountForUser({ email: "ana@example.com" }, { ...base, allowSharedSipAccount: true }).shared, true);
});
