const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { HttpError } = require("../lib/http-error");
const { requireCsrf, requireRole } = require("../middleware/auth");
const { encryptSipPassword, encryptionKey } = require("../services/asterisk/sip-credential-crypto");

const router = express.Router();
router.use(requireRole("ADMIN"));
router.use((request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  return requireCsrf(request, response, next);
});

const idParams = z.object({ id: z.string().min(1) });
const extension = z.string().trim().regex(/^\d{2,8}$/, "O ramal deve conter entre 2 e 8 d\u00edgitos.");
const password = z.string().min(1, "Informe a senha SIP.").max(256);
const optionalEmail = z.union([
  z.string().trim().email("Informe um e-mail v\u00e1lido."),
  z.literal(""),
  z.null(),
]).optional().transform((value) => value === "" || value === null ? null : value?.toLowerCase());
const createSchema = z.object({ extension, password, email: optionalEmail });
const updateSchema = z.object({
  extension: extension.optional(),
  password: password.optional(),
  email: optionalEmail,
}).refine((data) => Object.values(data).some((value) => value !== undefined), "Informe ao menos uma altera\u00e7\u00e3o.");

const accountSelect = {
  id: true,
  userId: true,
  email: true,
  extension: true,
  isAssigned: true,
  assignedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true, email: true, active: true } },
};

function encryptedPassword(value) {
  try {
    return encryptSipPassword(value, env.asterisk.sipDatabaseEncryptionKey);
  } catch (error) {
    throw new HttpError(503, error.message);
  }
}

function encryptionConfigured() {
  try {
    encryptionKey(env.asterisk.sipDatabaseEncryptionKey);
    return true;
  } catch {
    return false;
  }
}

async function targetSdr(email) {
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.role !== "SDR" || !user.active) {
    throw new HttpError(400, "Selecione um SDR ativo para vincular o ramal.");
  }
  return user;
}

async function ensureSdrAvailable(userId, ignoredAccountId) {
  if (!userId) return;
  const existing = await prisma.sipAccount.findFirst({
    where: { userId, ...(ignoredAccountId ? { id: { not: ignoredAccountId } } : {}) },
    select: { extension: true },
  });
  if (existing) throw new HttpError(409, `Este SDR j\u00e1 est\u00e1 vinculado ao ramal ${existing.extension}.`);
}

function handleUniqueError(error) {
  if (error.code === "P2002") throw new HttpError(409, "O ramal ou e-mail informado j\u00e1 est\u00e1 vinculado a outra conta SIP.");
  throw error;
}

router.get("/sip-accounts", async (_request, response) => {
  const [rows, sdrs, total, assigned] = await Promise.all([
    prisma.sipAccount.findMany({ select: accountSelect, orderBy: [{ isAssigned: "desc" }, { extension: "asc" }] }),
    prisma.user.findMany({
      where: { role: "SDR", active: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
    prisma.sipAccount.count(),
    prisma.sipAccount.count({ where: { isAssigned: true } }),
  ]);
  response.json({
    data: rows,
    sdrs,
    configuration: {
      databaseAccountsEnabled: env.asterisk.databaseAccountsEnabled,
      encryptionConfigured: encryptionConfigured(),
      total,
      assigned,
      available: total - assigned,
    },
  });
});

router.post("/sip-accounts", async (request, response) => {
  const data = createSchema.parse(request.body);
  const user = await targetSdr(data.email);
  await ensureSdrAvailable(user?.id);
  try {
    const created = await prisma.sipAccount.create({
      data: {
        extension: data.extension,
        passwordEncrypted: encryptedPassword(data.password),
        userId: user?.id || null,
        email: user?.email || null,
        isAssigned: Boolean(user),
        assignedAt: user ? new Date() : null,
      },
      select: accountSelect,
    });
    response.status(201).json(created);
  } catch (error) {
    handleUniqueError(error);
  }
});

router.patch("/sip-accounts/:id", async (request, response) => {
  const { id } = idParams.parse(request.params);
  const data = updateSchema.parse(request.body);
  const current = await prisma.sipAccount.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Conta SIP n\u00e3o encontrada.");

  let assignment = {};
  if (data.email !== undefined) {
    const user = await targetSdr(data.email);
    await ensureSdrAvailable(user?.id, id);
    assignment = user
      ? { userId: user.id, email: user.email, isAssigned: true, assignedAt: new Date() }
      : { userId: null, email: null, isAssigned: false, assignedAt: null };
  }

  try {
    const updated = await prisma.sipAccount.update({
      where: { id },
      data: {
        ...(data.extension ? { extension: data.extension } : {}),
        ...(data.password ? { passwordEncrypted: encryptedPassword(data.password) } : {}),
        ...assignment,
      },
      select: accountSelect,
    });
    response.json(updated);
  } catch (error) {
    handleUniqueError(error);
  }
});

router.delete("/sip-accounts/:id", async (request, response) => {
  const { id } = idParams.parse(request.params);
  const current = await prisma.sipAccount.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Conta SIP n\u00e3o encontrada.");
  if (current.isAssigned) {
    throw new HttpError(409, "Desvincule o SDR antes de excluir este ramal.");
  }
  await prisma.sipAccount.delete({ where: { id } });
  response.status(204).end();
});

module.exports = router;
