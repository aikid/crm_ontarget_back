const crypto = require("node:crypto");

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function encryptionKey(source) {
  const value = String(source || "").trim();
  if (!value) throw new Error("ASTERISK_SIP_DATABASE_ENCRYPTION_KEY n\u00e3o configurada.");
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64url");
  if (key.length !== 32) {
    throw new Error("ASTERISK_SIP_DATABASE_ENCRYPTION_KEY deve conter exatamente 32 bytes.");
  }
  return key;
}

function encryptSipPassword(password, keySource) {
  const plainText = String(password || "");
  if (!plainText) throw new Error("A senha SIP \u00e9 obrigat\u00f3ria.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(keySource), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptSipPassword(payload, keySource) {
  const [version, ivValue, tagValue, encryptedValue, extra] = String(payload || "").split(".");
  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue || extra) {
    throw new Error("Credencial SIP criptografada em formato inv\u00e1lido.");
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(keySource), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (/ASTERISK_SIP_DATABASE_ENCRYPTION_KEY/.test(error.message)) throw error;
    throw new Error("N\u00e3o foi poss\u00edvel descriptografar a credencial SIP com a chave configurada.");
  }
}

module.exports = { decryptSipPassword, encryptSipPassword, encryptionKey };
