const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { HttpError } = require("../lib/http-error");
const { hashPassword, verifyPassword } = require("../auth/password");
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
  limit: env.nodeEnv === "test" ? 100 : 10,
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
const profileSchema = z.object({
  name: z.string().trim().min(2, "Informe ao menos 2 caracteres.").max(120).optional(),
  newPassword: z.string().min(8, "A nova senha deve ter pelo menos 8 caracteres.").max(128).optional(),
}).superRefine((data, context) => {
  if (!data.name && !data.newPassword) {
    context.addIssue({ code: "custom", message: "Informe um dado para atualizar." });
  }
});

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

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

router.patch("/profile", requireAuth, requireCsrf, async (request, response) => {
  const data = profileSchema.parse(request.body);

  const user = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.user.update({
      where: { id: request.auth.user.id },
      data: {
        ...(data.name ? { name: data.name, initials: initials(data.name) } : {}),
        ...(data.newPassword ? { passwordHash: await hashPassword(data.newPassword) } : {}),
      },
      include: { client: true },
    });
    if (data.newPassword) {
      await transaction.authSession.deleteMany({
        where: { userId: updated.id, id: { not: request.auth.session.id } },
      });
      await transaction.passwordResetToken.deleteMany({ where: { userId: updated.id } });
    }
    return updated;
  });

  response.json({ user: publicUser(user) });
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
