const crypto = require("node:crypto");
const env = require("../config/env");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createOpaqueToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function cookieOptions(maxAgeSeconds) {
  const sameSite = ["lax", "strict", "none"].includes(env.session.sameSite)
    ? env.session.sameSite
    : "lax";
  return [
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`,
    ...(env.session.secure ? ["Secure"] : []),
    `Max-Age=${maxAgeSeconds}`,
  ];
}

function sessionCookie(token) {
  return `${env.session.cookieName}=${encodeURIComponent(token)}; ${cookieOptions(env.session.ttlHours * 3600).join("; ")}`;
}

function expiredSessionCookie() {
  return `${env.session.cookieName}=; ${cookieOptions(0).join("; ")}`;
}

async function createSession(prisma, userId) {
  const token = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + env.session.ttlHours * 60 * 60 * 1000);
  const session = await prisma.authSession.create({
    data: { userId, tokenHash: hashToken(token), csrfToken, expiresAt },
  });
  return { session, token, csrfToken };
}

module.exports = {
  createSession,
  expiredSessionCookie,
  hashToken,
  parseCookies,
  sessionCookie,
};
