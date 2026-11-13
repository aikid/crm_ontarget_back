const env = require("../../config/env");
const prisma = require("../../lib/prisma");
const { decryptSipPassword, encryptSipPassword, encryptionKey } = require("./sip-credential-crypto");

let cachedSource;
let cachedAccounts = new Map();

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseAccounts(source = env.asterisk.sipAccountsJson) {
  if (source === cachedSource) return cachedAccounts;
  cachedSource = source;
  cachedAccounts = new Map();
  if (!source) return cachedAccounts;
  let raw;
  try { raw = JSON.parse(source); }
  catch { throw new Error("ASTERISK_SIP_ACCOUNTS_JSON cont\u00e9m JSON inv\u00e1lido."); }
  for (const [email, account] of Object.entries(raw || {})) {
    const normalizedEmail = normalizeEmail(email);
    const extension = String(account?.extension || "").trim();
    const password = String(account?.password || "");
    if (!normalizedEmail.includes("@") || !/^\d{2,8}$/.test(extension) || !password) {
      throw new Error(`Conta SIP inv\u00e1lida para ${normalizedEmail || "e-mail vazio"}.`);
    }
    if ([...cachedAccounts.values()].some((item) => item.extension === extension)) {
      throw new Error(`O ramal SIP ${extension} foi atribu\u00eddo a mais de um SDR.`);
    }
    cachedAccounts.set(normalizedEmail, {
      userId: null,
      email: normalizedEmail,
      extension,
      password,
      shared: false,
    });
  }
  return cachedAccounts;
}

function databaseAccount(row, config) {
  if (!row) return null;
  return {
    userId: row.userId || null,
    email: normalizeEmail(row.email || row.user?.email),
    extension: row.extension,
    password: decryptSipPassword(row.passwordEncrypted, config.sipDatabaseEncryptionKey),
    shared: false,
  };
}

async function accountForUser(user, config = env.asterisk, database = prisma) {
  if (config.databaseAccountsEnabled) {
    const identities = [];
    if (user?.id) identities.push({ userId: user.id });
    const normalizedEmail = normalizeEmail(user?.email);
    if (normalizedEmail) identities.push({ email: normalizedEmail });
    if (!identities.length) return null;
    const row = await database.sipAccount.findFirst({
      where: { isAssigned: true, OR: identities },
      include: { user: { select: { email: true } } },
    });
    return databaseAccount(row, config);
  }

  const account = parseAccounts(config.sipAccountsJson).get(normalizeEmail(user?.email));
  if (account) return account;
  if (config.allowSharedSipAccount && config.sharedSipExtension && config.sharedSipPassword) {
    return {
      userId: user?.id || null,
      email: normalizeEmail(user?.email),
      extension: String(config.sharedSipExtension),
      password: String(config.sharedSipPassword),
      shared: true,
    };
  }
  return null;
}

async function accountForExtension(extension, config = env.asterisk, database = prisma) {
  const value = String(extension || "").trim();
  if (config.databaseAccountsEnabled) {
    const row = await database.sipAccount.findFirst({
      where: { extension: value, isAssigned: true },
      include: { user: { select: { email: true } } },
    });
    return databaseAccount(row, config);
  }

  const account = [...parseAccounts(config.sipAccountsJson).values()].find((item) => item.extension === value);
  if (account) return account;
  if (config.allowSharedSipAccount && String(config.sharedSipExtension) === value) {
    return { userId: null, email: null, extension: value, password: config.sharedSipPassword, shared: true };
  }
  return null;
}

async function publicSipSession(user, config = env.asterisk, database = prisma) {
  const account = await accountForUser(user, config, database);
  if (!account || !config.sipWebSocketUrl || !config.sipDomain) return null;
  return {
    webSocketUrl: config.sipWebSocketUrl,
    sipDomain: config.sipDomain,
    extension: account.extension,
    password: account.password,
    targetExtension: config.internalExtension,
    shared: account.shared,
  };
}

async function assignAvailableSipAccount(user, config = env.asterisk, database = prisma) {
  if (!config.databaseAccountsEnabled || user?.role !== "SDR") {
    return { enabled: Boolean(config.databaseAccountsEnabled), status: "DISABLED" };
  }
  encryptionKey(config.sipDatabaseEncryptionKey);
  const normalizedEmail = normalizeEmail(user.email);
  return database.$transaction(async (transaction) => {
    const existing = await transaction.sipAccount.findFirst({
      where: { isAssigned: true, OR: [{ userId: user.id }, { email: normalizedEmail }] },
      select: { id: true, extension: true },
    });
    if (existing) {
      const assigned = await transaction.sipAccount.update({
        where: { id: existing.id },
        data: { userId: user.id, email: normalizedEmail, isAssigned: true, assignedAt: new Date() },
        select: { extension: true },
      });
      return { enabled: true, status: "ASSIGNED", extension: assigned.extension };
    }

    const available = await transaction.$queryRaw`
      SELECT "id"
      FROM "SipAccount"
      WHERE "isAssigned" = false AND "userId" IS NULL AND "email" IS NULL
      ORDER BY LENGTH("extension"), "extension"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!available.length) {
      return {
        enabled: true,
        status: "PENDING",
        message: "Usu\u00e1rio criado, mas n\u00e3o h\u00e1 ramal SIP dispon\u00edvel.",
      };
    }
    const assigned = await transaction.sipAccount.update({
      where: { id: available[0].id },
      data: { userId: user.id, email: normalizedEmail, isAssigned: true, assignedAt: new Date() },
      select: { extension: true },
    });
    return { enabled: true, status: "ASSIGNED", extension: assigned.extension };
  });
}

async function syncSipAccountForUser(user, config = env.asterisk, database = prisma) {
  if (!config.databaseAccountsEnabled || user?.role !== "SDR") return null;
  const current = await database.sipAccount.findUnique({ where: { userId: user.id } });
  if (!current) return assignAvailableSipAccount(user, config, database);
  const updated = await database.sipAccount.update({
    where: { id: current.id },
    data: { email: normalizeEmail(user.email), isAssigned: true },
    select: { extension: true },
  });
  return { enabled: true, status: "ASSIGNED", extension: updated.extension };
}

async function createUnassignedSipAccount({ extension, password }, config = env.asterisk, database = prisma) {
  const normalizedExtension = String(extension || "").trim();
  if (!/^\d{2,8}$/.test(normalizedExtension)) throw new Error("O ramal SIP deve conter entre 2 e 8 d\u00edgitos.");
  return database.sipAccount.create({
    data: {
      extension: normalizedExtension,
      passwordEncrypted: encryptSipPassword(password, config.sipDatabaseEncryptionKey),
    },
    select: {
      id: true, userId: true, email: true, extension: true, isAssigned: true,
      assignedAt: true, createdAt: true, updatedAt: true,
    },
  });
}

async function sipConfigurationStatus(config = env.asterisk, database = prisma) {
  try {
    if (config.databaseAccountsEnabled) {
      encryptionKey(config.sipDatabaseEncryptionKey);
      const provisionedAccounts = await database.sipAccount.count({ where: { isAssigned: true } });
      return {
        source: "database",
        configured: Boolean(config.sipWebSocketUrl && config.sipDomain && provisionedAccounts > 0),
        provisionedAccounts,
        sharedPoc: false,
        error: null,
      };
    }
    const accounts = parseAccounts(config.sipAccountsJson);
    const sharedPoc = Boolean(config.allowSharedSipAccount && config.sharedSipExtension && config.sharedSipPassword);
    return {
      source: "environment",
      configured: Boolean(config.sipWebSocketUrl && config.sipDomain && (accounts.size > 0 || sharedPoc)),
      provisionedAccounts: accounts.size,
      sharedPoc,
      error: null,
    };
  } catch (error) {
    return {
      source: config.databaseAccountsEnabled ? "database" : "environment",
      configured: false,
      provisionedAccounts: 0,
      sharedPoc: false,
      error: error.message,
    };
  }
}

module.exports = {
  accountForExtension,
  accountForUser,
  assignAvailableSipAccount,
  createUnassignedSipAccount,
  parseAccounts,
  publicSipSession,
  sipConfigurationStatus,
  syncSipAccountForUser,
};
