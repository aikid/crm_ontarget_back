const express = require("express");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { findLead, leadInclude } = require("../services/lead-query");
const { serializeLead } = require("../services/serializers");
const { leadForAuth } = require("../auth/access");
const { requireCsrf, requireRole } = require("../middleware/auth");

const router = express.Router();
const outcomes = new Set([
  "NO_ANSWER",
  "INVALID_NUMBER",
  "REFUSED",
  "CONTACTED",
  "QUALIFIED",
  "NOT_QUALIFIED",
  "CALLBACK",
]);

const leadStatusByOutcome = {
  INVALID_NUMBER: "INVALID_NUMBER",
  REFUSED: "REFUSED",
  CONTACTED: "CONTACTED",
  QUALIFIED: "QUALIFIED",
  NOT_QUALIFIED: "NOT_QUALIFIED",
  CALLBACK: "CALLBACK",
};

const legacyCallResult = {
  NO_ANSWER: "no_answer",
  INVALID_NUMBER: "invalid",
  REFUSED: "no_interest",
  CONTACTED: "contacted",
  QUALIFIED: "qualified",
  NOT_QUALIFIED: "not_qualified",
  CALLBACK: "callback",
};

function optionalNotes(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "notes deve ser um texto.");
  const notes = value.trim();
  if (notes.length > 2_000) throw new HttpError(400, "As observações devem ter no máximo 2.000 caracteres.");
  return notes || null;
}

router.get("/:leadId", async (request, response) => {
  const lead = await leadForAuth(request.auth, request.params.leadId, leadInclude);
  response.json(serializeLead(lead));
});

router.post("/:leadId/outcomes", requireRole("SDR"), requireCsrf, async (request, response) => {
  const outcome = required(request.body.outcome || request.body.result, "outcome");
  if (!outcomes.has(outcome)) throw new HttpError(400, "Resultado de contato inválido.");
  const notes = optionalNotes(request.body.notes);
  const leadId = request.params.leadId;
  await leadForAuth(request.auth, leadId);

  let callbackAt = null;
  if (outcome === "CALLBACK") {
    const rawDate = request.body.callback?.scheduledAt || request.body.callbackAt;
    callbackAt = new Date(required(rawDate, "callback.scheduledAt"));
    if (Number.isNaN(callbackAt.getTime())) throw new HttpError(400, "A data do retorno é inválida.");
    if (callbackAt <= new Date()) throw new HttpError(400, "O retorno deve ser agendado para uma data futura.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Lead" WHERE "id" = ${leadId} FOR UPDATE`);
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new HttpError(404, "Lead não encontrado.");

    const now = new Date();
    if (lead.reservedById !== request.auth.user.id || !lead.reservedUntil || lead.reservedUntil <= now) {
      throw new HttpError(409, "A reserva deste lead expirou ou pertence a outro SDR.");
    }
    if (lead.attempts >= 3) throw new HttpError(409, "Este lead já atingiu o limite de três tentativas.");
    if (outcome === "CALLBACK" && lead.attempts >= 2) {
      throw new HttpError(409, "Não é possível agendar retorno após a terceira e última tentativa.");
    }

    const sequence = lead.attempts + 1;
    const status = outcome === "NO_ANSWER"
      ? (sequence >= 3 ? "EXHAUSTED" : "PENDING")
      : leadStatusByOutcome[outcome];

    await tx.attempt.create({
      data: {
        leadId,
        sdrId: request.auth.user.id,
        sequence,
        outcome,
        notes,
        startedAt: lead.reservedAt || now,
        finishedAt: now,
      },
    });

    await tx.lead.update({
      where: { id: leadId },
      data: {
        status,
        attempts: sequence,
        lastContact: now,
        invalidPhone: outcome === "INVALID_NUMBER",
        reservedById: null,
        reservedAt: null,
        reservedUntil: null,
      },
    });

    if (lead.attempts === 0) {
      await tx.campaign.update({ where: { id: lead.campaignId }, data: { workedLeads: { increment: 1 } } });
    }

    if (outcome === "CALLBACK") {
      await tx.callback.upsert({
        where: { leadId },
        create: { leadId, assignedToId: request.auth.user.id, scheduledAt: callbackAt, notes },
        update: { assignedToId: request.auth.user.id, scheduledAt: callbackAt, notes, completedAt: null },
      });
    } else {
      await tx.callback.updateMany({ where: { leadId, completedAt: null }, data: { completedAt: now } });
    }

    if (outcome === "QUALIFIED") {
      await tx.qualification.upsert({
        where: { leadId },
        create: { leadId, type: "Qualificado", notes },
        update: { type: "Qualificado", notes },
      });
    }

    if (request.body.callId) {
      await tx.call.updateMany({
        where: { id: request.body.callId, leadId, sdrId: request.auth.user.id },
        data: {
          result: legacyCallResult[outcome],
          detail: notes,
          durationSec: Number.isInteger(request.body.durationSec) ? request.body.durationSec : undefined,
          endedAt: now,
        },
      });
    }
  });

  response.status(201).json(serializeLead(await findLead(leadId)));
});

module.exports = router;
