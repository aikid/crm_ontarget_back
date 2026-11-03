const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { hashPassword } = require("../auth/password");
const { createPasswordResetToken, discardPasswordResetToken } = require("../auth/password-reset");
const { HttpError } = require("../lib/http-error");
const { requireCsrf, requireRole } = require("../middleware/auth");
const { requireEmailConfiguration, sendPasswordEmail } = require("../services/email");

const router = express.Router();
router.use(requireRole("GESTOR"));
router.use((request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  return requireCsrf(request, response, next);
});

const name = z.string().trim().min(2, "Informe ao menos 2 caracteres.").max(120);
const email = z.string().trim().email("Informe um e-mail válido.").transform((value) => value.toLowerCase());
const idParams = z.object({ id: z.string().min(1) });
const activeSchema = z.object({ active: z.boolean() });
const clientCreate = z.object({ name, email });
const clientUpdate = z.object({ name: name.optional(), email: email.optional(), active: z.boolean().optional() }).refine((data) => Object.keys(data).length > 0);
const storeCreate = z.object({ clientId: z.string().min(1), name, shortName: z.string().trim().min(2).max(60) });
const storeUpdate = z.object({ name: name.optional(), shortName: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional() }).refine((data) => Object.keys(data).length > 0);
const campaignStatus = z.enum(["ACTIVE", "INACTIVE", "COMPLETED"]);
const campaignCreate = z.object({
  clientId: z.string().min(1),
  storeId: z.string().min(1),
  name,
  status: campaignStatus.default("ACTIVE"),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
}).refine((data) => data.endDate >= data.startDate, { path: ["endDate"], message: "A data final deve ser igual ou posterior à inicial." });
const campaignUpdate = z.object({
  name: name.optional(),
  status: campaignStatus.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).refine((data) => Object.keys(data).length > 0);
const userRole = z.enum(["GESTOR", "SDR", "CLIENT"]);
const password = z.string().min(8, "A senha deve ter ao menos 8 caracteres.").max(128);
const userCreate = z.object({
  clientId: z.string().min(1).nullable().optional(),
  name,
  email,
  initials: z.string().trim().min(1).max(4).optional(),
  role: userRole,
  password,
});
const userUpdate = z.object({
  clientId: z.string().min(1).nullable().optional(),
  name: name.optional(),
  email: email.optional(),
  initials: z.string().trim().min(1).max(4).optional(),
  role: userRole.optional(),
  active: z.boolean().optional(),
  password: password.optional(),
}).refine((data) => Object.keys(data).length > 0);

function initials(value) {
  return value.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

function unavailableInitialPassword() {
  return `${crypto.randomBytes(12).toString("base64url")}A1!`;
}

function publicAdminUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

async function activeClient(clientId) {
  const client = await prisma.client.findFirst({ where: { id: clientId, active: true } });
  if (!client) throw new HttpError(400, "Cliente inexistente ou inativo.");
  return client;
}

async function activeStore(clientId, storeId) {
  const store = await prisma.store.findFirst({ where: { id: storeId, clientId, active: true } });
  if (!store) throw new HttpError(400, "Loja inexistente, inativa ou pertencente a outro cliente.");
  return store;
}

function normalizeUserClient(role, clientId) {
  if (role === "CLIENT" && !clientId) throw new HttpError(400, "Usuários do Portal precisam estar vinculados a um cliente.");
  return role === "CLIENT" ? clientId : null;
}

router.get("/clients", async (_request, response) => {
  const rows = await prisma.client.findMany({
    include: { _count: { select: { stores: true, campaigns: true, users: true, leads: true } } },
    orderBy: { name: "asc" },
  });
  response.json({ data: rows });
});

router.post("/clients", async (request, response) => {
  const data = clientCreate.parse(request.body);
  response.status(201).json(await prisma.client.create({ data }));
});

router.patch("/clients/:id", async (request, response) => {
  const { id } = idParams.parse(request.params);
  const data = clientUpdate.parse(request.body);
  response.json(await prisma.client.update({ where: { id }, data }));
});

router.post("/clients/:id/access", async (request, response, next) => {
  const { id } = idParams.parse(request.params);
  requireEmailConfiguration();
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) throw new HttpError(404, "Cliente não encontrado.");
  if (!client.active) throw new HttpError(409, "Ative o cliente antes de gerar o acesso ao Portal.");
  if (!client.email) throw new HttpError(409, "Cadastre o e-mail do cliente antes de enviar o acesso.");

  const [linkedPortalUser, emailOwner] = await Promise.all([
    prisma.user.findFirst({ where: { clientId: id, role: "CLIENT" } }),
    prisma.user.findUnique({ where: { email: client.email } }),
  ]);
  if (emailOwner && emailOwner.id !== linkedPortalUser?.id && (emailOwner.role !== "CLIENT" || emailOwner.clientId !== id)) {
    throw new HttpError(409, "Este e-mail já pertence a outro usuário da plataforma.");
  }

  const portalUser = emailOwner?.role === "CLIENT" && emailOwner.clientId === id ? emailOwner : linkedPortalUser;
  const user = await prisma.$transaction(async (transaction) => {
    if (portalUser) {
      return transaction.user.update({
        where: { id: portalUser.id },
        data: {
          clientId: id,
          name: client.name,
          email: client.email,
          initials: initials(client.name),
          role: "CLIENT",
          active: true,
        },
      });
    }
    return transaction.user.create({
      data: {
        clientId: id,
        name: client.name,
        email: client.email,
        initials: initials(client.name),
        role: "CLIENT",
        active: true,
        passwordHash: await hashPassword(unavailableInitialPassword()),
      },
    });
  });

  const { token } = await createPasswordResetToken(user.id);
  try {
    await sendPasswordEmail({ user, token, access: true });
  } catch (error) {
    await discardPasswordResetToken(token);
    return next(error);
  }

  return response.json({
    email: user.email,
    emailSent: true,
    expiresInMinutes: env.email.resetTtlMinutes,
    userId: user.id,
  });
});

router.get("/stores", async (request, response) => {
  const rows = await prisma.store.findMany({
    where: request.query.clientId ? { clientId: String(request.query.clientId) } : {},
    include: { client: { select: { id: true, name: true, active: true } }, _count: { select: { campaigns: true, leads: true } } },
    orderBy: [{ client: { name: "asc" } }, { name: "asc" }],
  });
  response.json({ data: rows });
});

router.post("/stores", async (request, response) => {
  const data = storeCreate.parse(request.body);
  await activeClient(data.clientId);
  response.status(201).json(await prisma.store.create({ data }));
});

router.patch("/stores/:id", async (request, response) => {
  const { id } = idParams.parse(request.params);
  const data = storeUpdate.parse(request.body);
  const current = await prisma.store.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Loja não encontrada.");
  if (data.active === true) await activeClient(current.clientId);
  response.json(await prisma.store.update({ where: { id }, data }));
});

router.get("/campaigns", async (request, response) => {
  const rows = await prisma.campaign.findMany({
    where: request.query.clientId ? { clientId: String(request.query.clientId) } : {},
    include: {
      client: { select: { id: true, name: true, active: true } },
      store: { select: { id: true, name: true, shortName: true, active: true } },
      _count: { select: { leads: true } },
    },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
  });
  response.json({ data: rows });
});

router.post("/campaigns", async (request, response) => {
  const data = campaignCreate.parse(request.body);
  await activeClient(data.clientId);
  await activeStore(data.clientId, data.storeId);
  response.status(201).json(await prisma.campaign.create({ data }));
});

router.patch("/campaigns/:id", async (request, response) => {
  const { id } = idParams.parse(request.params);
  const data = campaignUpdate.parse(request.body);
  const current = await prisma.campaign.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Campanha não encontrada.");
  const startDate = data.startDate || current.startDate;
  const endDate = data.endDate || current.endDate;
  if (endDate < startDate) throw new HttpError(400, "A data final deve ser igual ou posterior à inicial.");
  if (data.status === "ACTIVE") {
    await activeClient(current.clientId);
    await activeStore(current.clientId, current.storeId);
  }
  response.json(await prisma.campaign.update({ where: { id }, data }));
});

router.get("/users", async (_request, response) => {
  const rows = await prisma.user.findMany({
    include: { client: { select: { id: true, name: true, active: true } } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  response.json({ data: rows.map(publicAdminUser) });
});

router.post("/users", async (request, response) => {
  const data = userCreate.parse(request.body);
  const clientId = normalizeUserClient(data.role, data.clientId);
  if (clientId) await activeClient(clientId);
  const created = await prisma.user.create({
    data: {
      clientId,
      name: data.name,
      email: data.email,
      initials: data.initials || initials(data.name),
      role: data.role,
      passwordHash: await hashPassword(data.password),
    },
    include: { client: { select: { id: true, name: true, active: true } } },
  });
  response.status(201).json(publicAdminUser(created));
});

router.patch("/users/:id", async (request, response) => {
  const { id } = idParams.parse(request.params);
  const data = userUpdate.parse(request.body);
  const { password: newPassword, ...userData } = data;
  const current = await prisma.user.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Usuário não encontrado.");
  const role = data.role || current.role;
  const requestedClient = data.clientId === undefined ? current.clientId : data.clientId;
  const clientId = normalizeUserClient(role, requestedClient);
  if (clientId && (data.active === true || data.clientId !== undefined || data.role !== undefined)) {
    await activeClient(clientId);
  }
  if (id === request.auth.user.id && (data.active === false || role !== "GESTOR")) {
    throw new HttpError(409, "O gestor não pode remover o próprio acesso administrativo.");
  }
  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...userData,
      clientId,
      ...(data.name && !data.initials ? { initials: initials(data.name) } : {}),
      ...(newPassword ? { passwordHash: await hashPassword(newPassword) } : {}),
    },
    include: { client: { select: { id: true, name: true, active: true } } },
  });
  if (data.active === false) await prisma.authSession.deleteMany({ where: { userId: id } });
  response.json(publicAdminUser(updated));
});

module.exports = router;
