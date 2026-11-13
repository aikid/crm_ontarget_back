const env = require("../src/config/env");
const prisma = require("../src/lib/prisma");
const { parseAccounts } = require("../src/services/asterisk/sip-accounts");
const { encryptSipPassword, encryptionKey } = require("../src/services/asterisk/sip-credential-crypto");

async function run() {
  encryptionKey(env.asterisk.sipDatabaseEncryptionKey);
  const accounts = parseAccounts(env.asterisk.sipAccountsJson);
  if (!accounts.size) throw new Error("ASTERISK_SIP_ACCOUNTS_JSON n\u00e3o possui contas para importar.");

  let imported = 0;
  for (const account of accounts.values()) {
    const user = await prisma.user.findUnique({ where: { email: account.email }, select: { id: true } });
    await prisma.sipAccount.upsert({
      where: { extension: account.extension },
      create: {
        userId: user?.id || null,
        email: account.email,
        extension: account.extension,
        passwordEncrypted: encryptSipPassword(account.password, env.asterisk.sipDatabaseEncryptionKey),
        isAssigned: true,
        assignedAt: new Date(),
      },
      update: {
        userId: user?.id || null,
        email: account.email,
        passwordEncrypted: encryptSipPassword(account.password, env.asterisk.sipDatabaseEncryptionKey),
        isAssigned: true,
        assignedAt: new Date(),
      },
    });
    imported += 1;
  }
  console.log(`${imported} conta(s) SIP importada(s) sem exibir credenciais.`);
}

run()
  .catch((error) => {
    console.error(`Falha ao importar contas SIP: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
