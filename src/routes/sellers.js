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
const email = z.string().trim().email().transform((value) => value.toLowerCase());
const createSchema = z.object({
  clientId: z.string().min(1).optional(),
  sellerOption: z.enum(sellerOptions),
  name: z.string().trim().min(2).max(120),
  email,
});
const updateSchema = createSchema.omit({ clientId: true }).partial().extend({ active: z.boolean().optional() })
  .refine((data) => Object.keys(data).length > 0);

function requestedClientId(request, requested) {
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

const sellerInclude = {
  client: { select: { id: true, name: true, active: true } },
  users: {
    where: { role: "SELLER" },
    select: { id: true, email: true, active: true, lastLoginAt: true, mustChangePassword: true },
    take: 1,
  },
  _count: { select: { campaigns: true, leads: true } },
};

function publicSeller(store) {
  const access = store.users?.[0] || null;
  const { users, ...seller } = store;
  return {
    ...seller,
    sellerOption: store.shortName,
    email: store.email || access?.email || "",
    access,
  };
}

async function findSeller(id) {
  return prisma.store.findUnique({ where: { id }, include: sellerInclude });
}

router.get("/", async (request, response) => {
  const selectedClientId = request.query.clientId ? String(request.query.clientId) : undefined;
  const clientId = request.auth.user.role === "CLIENT" ? request.auth.user.clientId : selectedClientId;
  const stores = await prisma.store.findMany({
    where: clientId ? { clientId } : {},
    include: sellerInclude,
    orderBy: [{ client: { name: "asc" } }, { name: "asc" }],
  });
  response.json({ data: stores.map(publicSeller) });
});

router.post("/", async (request, response, next) => {
  requireEmailConfiguration();
  const data = createSchema.parse(request.body);
  const clientId = requestedClientId(request, data.clientId);
  const client = await prisma.client.findFirst({ where: { id: clientId, active: true } });
  if (!client) throw new HttpError(400, "Cliente inexistente ou inativo.");

  const password = temporaryPassword();
  const created = await prisma.$transaction(async (transaction) => {
    const store = await transaction.store.create({
      data: { clientId, name: data.name, email: data.email, shortName: data.sellerOption },
    });
    const user = await transaction.user.create({
      data: {
        clientId,
        storeId: store.id,
        sellerOption: data.sellerOption,
        name: data.name,
        email: data.email,
        initials: initials(data.name),
        role: "SELLER",
        active: false,
        mustChangePassword: true,
        passwordHash: await hashPassword(password),
      },
    });
    return { store, user };
  });

  try {
    await sendTemporaryPasswordEmail({ user: created.user, temporaryPassword: password });
    await prisma.user.update({ where: { id: created.user.id }, data: { active: true } });
    return response.status(201).json(publicSeller(await findSeller(created.store.id)));
  } catch (error) {
    await prisma.$transaction([
      prisma.user.deleteMany({ where: { id: created.user.id } }),
      prisma.store.deleteMany({ where: { id: created.store.id } }),
    ]).catch(() => undefined);
    return next(error);
  }
});

router.patch("/:id", async (request, response, next) => {
  const data = updateSchema.parse(request.body);
  const current = await findSeller(request.params.id);
  if (!current) throw new HttpError(404, "Vendedor não encontrado.");
  const clientId = requestedClientId(request, current.clientId);
  if (current.clientId !== clientId) throw new HttpError(403, "Acesso negado ao vendedor de outro cliente.");

  const access = current.users[0] || null;
  const nextName = data.name || current.name;
  const nextEmail = data.email || current.email || access?.email;
  const nextOption = data.sellerOption || current.shortName;

  if (!access && nextEmail) {
    requireEmailConfiguration();
    const password = temporaryPassword();
    const user = await prisma.$transaction(async (transaction) => {
      await transaction.store.update({
        where: { id: current.id },
        data: { name: nextName, email: nextEmail, shortName: nextOption, ...(data.active !== undefined ? { active: data.active } : {}) },
      });
      return transaction.user.create({
        data: {
          clientId,
          storeId: current.id,
          sellerOption: nextOption,
          name: nextName,
          email: nextEmail,
          initials: initials(nextName),
          role: "SELLER",
          active: false,
          mustChangePassword: true,
          passwordHash: await hashPassword(password),
        },
      });
    });
    try {
      await sendTemporaryPasswordEmail({ user, temporaryPassword: password });
      await prisma.user.update({ where: { id: user.id }, data: { active: data.active ?? true } });
      return response.json(publicSeller(await findSeller(current.id)));
    } catch (error) {
      await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => undefined);
      return next(error);
    }
  }

  await prisma.$transaction(async (transaction) => {
    if (data.name && data.name !== current.name) {
      await transaction.appointment.updateMany({
        where: { lead: { clientId }, seller: { equals: current.name, mode: "insensitive" } },
        data: { seller: data.name },
      });
    }
    await transaction.store.update({
      where: { id: current.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.sellerOption !== undefined ? { shortName: data.sellerOption } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    if (access) {
      await transaction.user.update({
        where: { id: access.id },
        data: {
          ...(data.name !== undefined ? { name: data.name, initials: initials(data.name) } : {}),
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.sellerOption !== undefined ? { sellerOption: data.sellerOption } : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
        },
      });
      if (data.active === false) await transaction.authSession.deleteMany({ where: { userId: access.id } });
    }
  });
  response.json(publicSeller(await findSeller(current.id)));
});

module.exports = router;
