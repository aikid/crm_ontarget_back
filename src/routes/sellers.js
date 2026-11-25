const crypto = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { hashPassword } = require("../auth/password");
const { HttpError } = require("../lib/http-error");
const { requireCsrf, requireRole } = require("../middleware/auth");
const { requireEmailConfiguration, sendTemporaryPasswordEmail } = require("../services/email");

const router = express.Router();
router.use(requireRole("GESTOR", "CLIENT"));
router.use((request, response, next) => ["GET", "HEAD", "OPTIONS"].includes(request.method) ? next() : requireCsrf(request, response, next));

const sellerOptions = ["Todos", "Venda direta", "0km", "Usado", "Consórcio"];
const schema = z.object({
  clientId: z.string().min(1).optional(),
  sellerOption: z.enum(sellerOptions),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});

function clientIdFor(request, requested) {
  if (request.auth.user.role === "CLIENT") return request.auth.user.clientId;
  if (!requested) throw new HttpError(400, "Selecione o cliente.");
  return requested;
}

function temporaryPassword() {
  return `${crypto.randomBytes(10).toString("base64url")}!A7`;
}

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

function publicSeller(user) {
  const { passwordHash, ...safe } = user;
  return { ...safe, source: "USER" };
}

function publicLegacySeller(store) {
  return {
    id: store.id,
    clientId: store.clientId,
    storeId: store.id,
    name: store.name,
    email: "",
    initials: initials(store.name),
    role: "SELLER",
    sellerOption: store.shortName,
    mustChangePassword: false,
    active: store.active,
    lastLoginAt: null,
    client: store.client,
    store: { id: store.id, name: store.name, shortName: store.shortName, active: store.active },
    source: "STORE",
  };
}

router.get("/", async (request, response) => {
  const requestedClientId = request.query.clientId ? String(request.query.clientId) : undefined;
  const clientId = request.auth.user.role === "CLIENT" ? request.auth.user.clientId : requestedClientId;
  const where = clientId ? { clientId } : {};
  const [users, stores] = await Promise.all([
    prisma.user.findMany({
      where: { role: "SELLER", ...where },
      include: { client: { select: { id: true, name: true, active: true } }, store: { select: { id: true, name: true, shortName: true, active: true } } },
    }),
    prisma.store.findMany({
      where,
      include: { client: { select: { id: true, name: true, active: true } } },
    }),
  ]);
  const linkedStoreIds = new Set(users.map((user) => user.storeId).filter(Boolean));
  const data = [
    ...users.map(publicSeller),
    ...stores.filter((store) => !linkedStoreIds.has(store.id)).map(publicLegacySeller),
  ].sort((left, right) => left.client.name.localeCompare(right.client.name, "pt-BR") || left.name.localeCompare(right.name, "pt-BR"));
  response.json({ data });
});

router.post("/", async (request, response, next) => {
  requireEmailConfiguration();
  const data = schema.parse(request.body);
  const clientId = clientIdFor(request, data.clientId);
  const client = await prisma.client.findFirst({ where: { id: clientId, active: true } });
  if (!client) throw new HttpError(400, "Cliente inexistente ou inativo.");

  const password = temporaryPassword();
  const user = await prisma.user.create({
    data: {
      clientId,
      sellerOption: data.sellerOption,
      name: data.name,
      email: data.email,
      initials: initials(data.name),
      role: "SELLER",
      active: false,
      mustChangePassword: true,
      passwordHash: await hashPassword(password),
    },
    include: { client: true, store: true },
  });
  try {
    await sendTemporaryPasswordEmail({ user, temporaryPassword: password });
    const activated = await prisma.user.update({ where: { id: user.id }, data: { active: true }, include: { client: true, store: true } });
    return response.status(201).json(publicSeller(activated));
  } catch (error) {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    return next(error);
  }
});

router.patch("/:id", async (request, response) => {
  const current = await prisma.user.findFirst({ where: { id: request.params.id, role: "SELLER" } });
  const data = schema.partial().extend({ active: z.boolean().optional() }).parse(request.body);
  if (!current) {
    const store = await prisma.store.findUnique({
      where: { id: request.params.id },
      include: { client: { select: { id: true, name: true, active: true } } },
    });
    if (!store) throw new HttpError(404, "Vendedor não encontrado.");
    const clientId = clientIdFor(request, store.clientId);
    if (store.clientId !== clientId) throw new HttpError(403, "Acesso negado ao vendedor de outro cliente.");

    const nextName = data.name || store.name;
    const nextOption = data.sellerOption || store.shortName;
    if (!data.email) {
      const updatedStore = await prisma.store.update({
        where: { id: store.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.sellerOption !== undefined ? { shortName: data.sellerOption } : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
        },
        include: { client: { select: { id: true, name: true, active: true } } },
      });
      return response.json(publicLegacySeller(updatedStore));
    }

    requireEmailConfiguration();
    const password = temporaryPassword();
    const user = await prisma.$transaction(async (transaction) => {
      await transaction.store.update({
        where: { id: store.id },
        data: { name: nextName, shortName: nextOption, ...(data.active !== undefined ? { active: data.active } : {}) },
      });
      return transaction.user.create({
        data: {
          clientId,
          storeId: store.id,
          sellerOption: nextOption,
          name: nextName,
          email: data.email,
          initials: initials(nextName),
          role: "SELLER",
          active: false,
          mustChangePassword: true,
          passwordHash: await hashPassword(password),
        },
        include: { client: true, store: true },
      });
    });
    try {
      await sendTemporaryPasswordEmail({ user, temporaryPassword: password });
      const activated = await prisma.user.update({ where: { id: user.id }, data: { active: data.active ?? true }, include: { client: true, store: true } });
      return response.json(publicSeller(activated));
    } catch (error) {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw error;
    }
  }

  const clientId = clientIdFor(request, current.clientId);
  if (current.clientId !== clientId) throw new HttpError(403, "Acesso negado ao vendedor de outro cliente.");
  const updated = await prisma.$transaction(async (transaction) => {
    if (data.name && data.name !== current.name) {
      await transaction.appointment.updateMany({
        where: { lead: { clientId }, seller: { equals: current.name, mode: "insensitive" } },
        data: { seller: data.name },
      });
    }
    return transaction.user.update({
      where: { id: current.id },
      data: { ...data, clientId, ...(data.name ? { initials: initials(data.name) } : {}) },
      include: { client: true, store: true },
    });
  });
  if (data.active === false) await prisma.authSession.deleteMany({ where: { userId: current.id } });
  response.json(publicSeller(updated));
});

module.exports = router;
