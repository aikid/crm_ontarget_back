const crypto = require("node:crypto");
const prisma = require("../src/lib/prisma");
const { hashPassword } = require("../src/auth/password");
const { createPasswordResetToken, discardPasswordResetToken } = require("../src/auth/password-reset");
const { isEmailConfigured, sendPasswordEmail } = require("../src/services/email");

const email = String(process.env.SYSTEM_ADMIN_EMAIL || "sysonsuporte@gmail.com").trim().toLowerCase();
const name = String(process.env.SYSTEM_ADMIN_NAME || "Administra\u00e7\u00e3o SysOn").trim();

function initials(value) {
  return value.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

async function main() {
  const current = await prisma.user.findUnique({ where: { email } });
  if (current && current.role !== "ADMIN") {
    throw new Error(`O e-mail ${email} j\u00e1 pertence a um perfil ${current.role}; use outro e-mail administrativo.`);
  }

  const temporaryPassword = `${crypto.randomBytes(18).toString("base64url")}!Aa7`;
  const user = current
    ? await prisma.user.update({
      where: { id: current.id },
      data: { name, initials: initials(name), active: true, clientId: null, passwordHash: await hashPassword(temporaryPassword) },
    })
    : await prisma.user.create({
      data: { name, email, initials: initials(name), role: "ADMIN", active: true, passwordHash: await hashPassword(temporaryPassword) },
    });

  await prisma.authSession.deleteMany({ where: { userId: user.id } });

  if (isEmailConfigured()) {
    const { token } = await createPasswordResetToken(user.id);
    try {
      await sendPasswordEmail({ user, token, access: true });
      console.log(JSON.stringify({ created: !current, email, accessEmailSent: true }));
      return;
    } catch (error) {
      await discardPasswordResetToken(token);
      throw error;
    }
  }

  console.log(JSON.stringify({ created: !current, email, accessEmailSent: false, temporaryPassword }));
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
