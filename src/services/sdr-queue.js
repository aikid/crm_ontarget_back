const { Prisma } = require("@prisma/client");
const { HttpError } = require("../lib/http-error");

const RESERVATION_MINUTES = 15;

function reservationWindow(now = new Date()) {
  return new Date(now.getTime() + RESERVATION_MINUTES * 60_000);
}

async function lockUser(tx, userId) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
}

async function claimNextLead(prisma, userId, campaignId) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const now = new Date();

    const current = await tx.lead.findFirst({
      where: { reservedById: userId, reservedUntil: { gt: now } },
      orderBy: { reservedAt: "asc" },
    });
    if (current) {
      if (current.campaignId !== campaignId) {
        throw new HttpError(409, "Finalize ou libere o lead atual antes de acessar outra campanha.");
      }
      return current;
    }

    const candidates = await tx.$queryRaw(Prisma.sql`
      SELECT lead."id"
      FROM "Lead" lead
      WHERE lead."campaignId" = ${campaignId}
        AND lead."status" = 'PENDING'
        AND lead."invalidPhone" = false
        AND lead."attempts" < 3
        AND (lead."reservedUntil" IS NULL OR lead."reservedUntil" <= ${now})
      ORDER BY lead."createdAt" ASC, lead."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);

    if (!candidates.length) throw new HttpError(404, "Não há leads disponíveis na fila.");
    return tx.lead.update({
      where: { id: candidates[0].id },
      data: { reservedById: userId, reservedAt: now, reservedUntil: reservationWindow(now) },
    });
  });
}

async function renewReservation(prisma, userId, leadId) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const now = new Date();
    const rows = await tx.$queryRaw(Prisma.sql`
      SELECT "id", "reservedById", "reservedUntil"
      FROM "Lead"
      WHERE "id" = ${leadId}
      FOR UPDATE
    `);
    const lead = rows[0];
    if (!lead) throw new HttpError(404, "Lead não encontrado.");
    if (lead.reservedById !== userId || !lead.reservedUntil || lead.reservedUntil <= now) {
      throw new HttpError(409, "A reserva deste lead expirou ou pertence a outro SDR.");
    }
    return tx.lead.update({
      where: { id: leadId },
      data: { reservedUntil: reservationWindow(now) },
    });
  });
}

async function releaseReservation(prisma, userId, leadId) {
  const released = await prisma.lead.updateMany({
    where: { id: leadId, reservedById: userId },
    data: { reservedById: null, reservedAt: null, reservedUntil: null },
  });
  if (!released.count) throw new HttpError(409, "Este lead não está reservado para o SDR autenticado.");
}

async function claimCallback(prisma, userId, leadId) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const now = new Date();
    const active = await tx.lead.findFirst({ where: { reservedById: userId, reservedUntil: { gt: now } } });
    if (active && active.id !== leadId) {
      throw new HttpError(409, "Finalize ou libere o lead atual antes de iniciar o retorno.");
    }

    const rows = await tx.$queryRaw(Prisma.sql`
      SELECT lead."id", lead."reservedById", lead."reservedUntil", lead."attempts",
             callback."assignedToId", callback."scheduledAt", callback."completedAt"
      FROM "Lead" lead
      INNER JOIN "Callback" callback ON callback."leadId" = lead."id"
      WHERE lead."id" = ${leadId}
      FOR UPDATE OF lead
    `);
    const lead = rows[0];
    if (!lead) throw new HttpError(404, "Retorno não encontrado.");
    if (lead.assignedToId !== userId || lead.completedAt) throw new HttpError(403, "Este retorno pertence a outro SDR.");
    if (lead.scheduledAt > now) throw new HttpError(409, "O horário deste retorno ainda não chegou.");
    if (lead.attempts >= 3) throw new HttpError(409, "Este lead já atingiu o limite de três tentativas.");
    if (lead.reservedUntil && lead.reservedUntil > now && lead.reservedById !== userId) {
      throw new HttpError(409, "Este lead já está em atendimento por outro SDR.");
    }

    return tx.lead.update({
      where: { id: leadId },
      data: { reservedById: userId, reservedAt: now, reservedUntil: reservationWindow(now) },
    });
  });
}

module.exports = {
  RESERVATION_MINUTES,
  claimCallback,
  claimNextLead,
  releaseReservation,
  renewReservation,
};
