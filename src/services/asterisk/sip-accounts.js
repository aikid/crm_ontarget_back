const env = require("../../config/env");

let cachedSource;
let cachedAccounts = new Map();

function parseAccounts(source = env.asterisk.sipAccountsJson) {
  if (source === cachedSource) return cachedAccounts;
  cachedSource = source;
  cachedAccounts = new Map();
  if (!source) return cachedAccounts;
  let raw;
  try { raw = JSON.parse(source); }
  catch { throw new Error("ASTERISK_SIP_ACCOUNTS_JSON contém JSON inválido."); }
  for (const [email, account] of Object.entries(raw || {})) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const extension = String(account?.extension || "").trim();
    const password = String(account?.password || "");
    if (!normalizedEmail.includes("@") || !/^\d{2,8}$/.test(extension) || !password) {
      throw new Error(`Conta SIP inválida para ${normalizedEmail || "e-mail vazio"}.`);
    }
    if ([...cachedAccounts.values()].some((item) => item.extension === extension)) {
      throw new Error(`O ramal SIP ${extension} foi atribuído a mais de um SDR.`);
    }
    cachedAccounts.set(normalizedEmail, { email: normalizedEmail, extension, password, shared: false });
  }
  return cachedAccounts;
}

function accountForUser(user, config = env.asterisk) {
  const account = parseAccounts(config.sipAccountsJson).get(String(user.email || "").trim().toLowerCase());
  if (account) return account;
  if (config.allowSharedSipAccount && config.sharedSipExtension && config.sharedSipPassword) {
    return {
      email: String(user.email || "").trim().toLowerCase(),
      extension: String(config.sharedSipExtension),
      password: String(config.sharedSipPassword),
      shared: true,
    };
  }
  return null;
}

function accountForExtension(extension, config = env.asterisk) {
  const value = String(extension || "");
  const account = [...parseAccounts(config.sipAccountsJson).values()].find((item) => item.extension === value);
  if (account) return account;
  if (config.allowSharedSipAccount && String(config.sharedSipExtension) === value) {
    return { email: null, extension: value, password: config.sharedSipPassword, shared: true };
  }
  return null;
}

function publicSipSession(user, config = env.asterisk) {
  const account = accountForUser(user, config);
  if (!account) return null;
  if (!config.sipWebSocketUrl || !config.sipDomain) return null;
  return {
    webSocketUrl: config.sipWebSocketUrl,
    sipDomain: config.sipDomain,
    extension: account.extension,
    password: account.password,
    targetExtension: config.internalExtension,
    shared: account.shared,
  };
}

function sipConfigurationStatus(config = env.asterisk) {
  try {
    const accounts = parseAccounts(config.sipAccountsJson);
    const sharedPoc = Boolean(config.allowSharedSipAccount && config.sharedSipExtension && config.sharedSipPassword);
    return {
      configured: Boolean(config.sipWebSocketUrl && config.sipDomain && (accounts.size > 0 || sharedPoc)),
      provisionedAccounts: accounts.size,
      sharedPoc,
      error: null,
    };
  } catch (error) {
    return { configured: false, provisionedAccounts: 0, sharedPoc: false, error: error.message };
  }
}

module.exports = { accountForExtension, accountForUser, parseAccounts, publicSipSession, sipConfigurationStatus };
