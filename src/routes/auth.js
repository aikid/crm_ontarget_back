const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { verifyPassword } = require("../auth/password");
const {
  createPasswordResetToken,
  discardPasswordResetToken,
  resetPassword,
} = require("../auth/password-reset");
const { createSession, expiredSessionCookie, sessionCookie } = require("../auth/session");
const { publicUser } = require("../auth/user");
const { requireAuth, requireCsrf } = require("../middleware/auth");
const { requireEmailConfiguration, sendPasswordEmail } = require("../services/email");

const router = express.Router();
const credentialsSchema = z.object({
  email: z.string().trim().email("Informe um e-mail válido.").transform((value) => value.toLowerCase()),
  password: z.string().min(8, "A senha deve ter pelo menos 8 caracteres.").max(128),
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { message: "Muitas tentativas de login. Aguarde alguns minutos." } },
});
const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { message: "Muitas solicitações de recuperação. Aguarde alguns minutos." } },
});
const forgotPasswordSchema = z.object({
  email: z.string().trim().email("Informe um e-mail válido.").transform((value) => value.toLowerCase()),
});
const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(8, "A senha deve ter pelo menos 8 caracteres.").max(128),
});

router.post("/login", loginLimiter, async (request, response) => {
  const credentials = credentialsSchema.parse(request.body);
  const user = await prisma.user.findUnique({
    where: { email: credentials.email },
    include: { client: true },
  });
  const valid = user && user.active && await verifyPassword(credentials.password, user.passwordHash);
  if (!valid) throw new HttpError(401, "E-mail ou senha inválidos.");

  const { token, csrfToken } = await prisma.$transaction(async (tx) => {
    await tx.authSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    const created = await createSession(tx, user.id);
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return created;
  });

  response.setHeader("Set-Cookie", sessionCookie(token));
  response.json({ user: publicUser(user), csrfToken });
});

router.post("/forgot-password", recoveryLimiter, async (request, response, next) => {
  const data = forgotPasswordSchema.parse(request.body);
  requireEmailConfiguration();
  await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const user = await prisma.user.findUnique({ where: { email: data.email } });

  if (user?.active) {
    const { token } = await createPasswordResetToken(user.id);
    try {
      await sendPasswordEmail({ user, token });
    } catch (error) {
      await discardPasswordResetToken(token);
      return next(error);
    }
  }

  return response.status(202).json({
    message: "Se existir uma conta ativa para este e-mail, enviaremos as instruções de recuperação.",
  });
});

router.post("/reset-password", recoveryLimiter, async (request, response) => {
  const data = resetPasswordSchema.parse(request.body);
  await resetPassword(data.token, data.password);
  response.json({ message: "Senha alterada com sucesso. Entre novamente com a nova senha." });
});

router.get("/session", requireAuth, (request, response) => {
  response.json({ user: publicUser(request.auth.user), csrfToken: request.auth.session.csrfToken });
});

router.post("/logout", requireAuth, requireCsrf, async (request, response) => {
  await prisma.$transaction(async (tx) => {
    await tx.lead.updateMany({
      where: { reservedById: request.auth.user.id },
      data: { reservedById: null, reservedAt: null, reservedUntil: null },
    });
    await tx.authSession.delete({ where: { id: request.auth.session.id } });
  });
  response.setHeader("Set-Cookie", expiredSessionCookie());
  response.sendStatus(204);
});

module.exports = router;
