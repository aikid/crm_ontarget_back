const crypto = require("node:crypto");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { HttpError } = require("../lib/http-error");
const { hashToken, parseCookies } = require("../auth/session");

async function loadAuth(request) {
  const token = parseCookies(request.headers.cookie)[env.session.cookieName];
  if (!token) return null;
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { client: true } } },
  });
  if (
    !session
    || session.expiresAt <= new Date()
    || !session.user.active
    || (session.user.role === "CLIENT" && !session.user.client?.active)
  ) return null;
  return { session, user: session.user };
}

async function requireAuth(request, _response, next) {
  const auth = await loadAuth(request);
  if (!auth) throw new HttpError(401, "Sessão ausente, expirada ou inválida.");
  request.auth = auth;
  next();
}

function requireRole(...roles) {
  return (request, _response, next) => {
    if (!request.auth || !roles.includes(request.auth.user.role)) {
      throw new HttpError(403, "Você não tem permissão para realizar esta ação.");
    }
    next();
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCsrf(request, _response, next) {
  if (!request.auth || !safeEqual(request.header("x-csrf-token"), request.auth.session.csrfToken)) {
    throw new HttpError(403, "Token de segurança inválido. Atualize a página e tente novamente.");
  }
  next();
}

module.exports = { loadAuth, requireAuth, requireCsrf, requireRole };
