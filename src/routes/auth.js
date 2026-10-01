const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { verifyPassword } = require("../auth/password");
const { createSession, expiredSessionCookie, sessionCookie } = require("../auth/session");
const { publicUser } = require("../auth/user");
const { requireAuth, requireCsrf } = require("../middleware/auth");

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

router.get("/session", requireAuth, (request, response) => {
  response.json({ user: publicUser(request.auth.user), csrfToken: request.auth.session.csrfToken });
});

router.post("/logout", requireAuth, requireCsrf, async (request, response) => {
  await prisma.authSession.delete({ where: { id: request.auth.session.id } });
  response.setHeader("Set-Cookie", expiredSessionCookie());
  response.sendStatus(204);
});

module.exports = router;
