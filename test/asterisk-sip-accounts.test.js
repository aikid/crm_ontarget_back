const assert = require("node:assert/strict");
const test = require("node:test");
const {
  accountForExtension,
  accountForUser,
  assignAvailableSipAccount,
  parseAccounts,
  publicSipSession,
} = require("../src/services/asterisk/sip-accounts");
const { encryptSipPassword } = require("../src/services/asterisk/sip-credential-crypto");

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
    databaseAccountsEnabled: false,
    ...overrides,
  };
}

test("entrega somente o ramal vinculado ao e-mail autenticado", async () => {
  const session = await publicSipSession({ email: "ANA@EXAMPLE.COM" }, config());
  assert.deepEqual(session, {
    webSocketUrl: "wss://voz.example.com/ws",
    sipDomain: "voz.example.com",
    extension: "201",
    password: "secret-ana",
    targetExtension: "902",
    shared: false,
  });
});

test("correlaciona extensao ao proprietario e rejeita SDR sem provisionamento", async () => {
  assert.equal((await accountForExtension("202", config())).email, "diego@example.com");
  assert.equal(await accountForUser({ email: "outro@example.com" }, config()), null);
});

test("rejeita ramal duplicado entre SDRs", () => {
  const source = JSON.stringify({
    "ana@example.com": { extension: "201", password: "a" },
    "diego@example.com": { extension: "201", password: "b" },
  });
  assert.throws(() => parseAccounts(source), /mais de um SDR/);
});

test("conta compartilhada so existe quando o modo POC e explicito", async () => {
  const base = config({ sipAccountsJson: "", sharedSipExtension: "201", sharedSipPassword: "poc" });
  assert.equal(await accountForUser({ email: "ana@example.com" }, base), null);
  const shared = await accountForUser({ email: "ana@example.com" }, { ...base, allowSharedSipAccount: true });
  assert.equal(shared.shared, true);
});

test("consulta e descriptografa a conta SIP do banco somente quando a flag esta ativa", async () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const database = {
    sipAccount: {
      findFirst: async () => ({
        userId: "user-1",
        email: "ana@example.com",
        extension: "203",
        passwordEncrypted: encryptSipPassword("secret-db", key),
        user: { email: "ana@example.com" },
      }),
    },
  };
  const session = await publicSipSession(
    { id: "user-1", email: "ana@example.com" },
    config({ databaseAccountsEnabled: true, sipDatabaseEncryptionKey: key }),
    database,
  );
  assert.equal(session.extension, "203");
  assert.equal(session.password, "secret-db");
});

test("reserva atomicamente o primeiro ramal disponivel para um SDR", async () => {
  const key = Buffer.alloc(32, 9).toString("base64url");
  const account = { id: "sip-1", extension: "204" };
  const transaction = {
    sipAccount: {
      findFirst: async () => null,
      update: async ({ data }) => ({ ...account, ...data }),
    },
    $queryRaw: async () => [{ id: account.id }],
  };
  const database = { $transaction: async (operation) => operation(transaction) };
  const result = await assignAvailableSipAccount(
    { id: "user-2", email: "novo@example.com", role: "SDR" },
    config({ databaseAccountsEnabled: true, sipDatabaseEncryptionKey: key }),
    database,
  );
  assert.deepEqual(result, { enabled: true, status: "ASSIGNED", extension: "204" });
});
