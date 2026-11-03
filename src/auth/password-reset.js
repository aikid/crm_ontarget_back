const crypto = require("node:crypto");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { hashPassword } = require("./password");
const { HttpError } = require("../lib/http-error");

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.email.resetTtlMinutes * 60_000);
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.create({
      data: { userId, tokenHash: tokenHash(token), expiresAt },
    }),
  ]);
  return { token, expiresAt };
}

async function discardPasswordResetToken(token) {
  await prisma.passwordResetToken.deleteMany({ where: { tokenHash: tokenHash(token) } });
}

async function resetPassword(token, password) {
  const hash = tokenHash(token);
  const now = new Date();
  const passwordHash = await hashPassword(password);

  return prisma.$transaction(async (transaction) => {
    const reset = await transaction.passwordResetToken.findUnique({ where: { tokenHash: hash } });
    if (!reset || reset.usedAt || reset.expiresAt <= now) {
      throw new HttpError(400, "Este link de recuperação é inválido ou expirou.");
    }

    const claimed = await transaction.passwordResetToken.updateMany({
      where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new HttpError(400, "Este link de recuperação já foi utilizado.");

    await transaction.user.update({ where: { id: reset.userId }, data: { passwordHash } });
    await transaction.authSession.deleteMany({ where: { userId: reset.userId } });
    return reset.userId;
  });
}

module.exports = {
  createPasswordResetToken,
  discardPasswordResetToken,
  resetPassword,
  tokenHash,
};
