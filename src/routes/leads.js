const express = require("express");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { findLead, leadInclude } = require("../services/lead-query");
const { serializeLead } = require("../services/serializers");
const { leadForAuth } = require("../auth/access");
const { requireCsrf, requireRole } = require("../middleware/auth");

const router = express.Router();
const outcomes = new Set(["scheduled", "qualified", "callback", "no_answer", "no_interest", "invalid"]);

router.get("/:leadId", async (request, response) => {
  const lead = await leadForAuth(request.auth, request.params.leadId, leadInclude);
  if (!lead) throw new HttpError(404, "Lead não encontrado.");
  response.json(serializeLead(lead));
});

router.post("/:leadId/outcomes", requireRole("GESTOR", "SDR"), requireCsrf, async (request, response) => {
  const result = required(request.body.result, "result");
  if (!outcomes.has(result)) throw new HttpError(400, "Resultado de contato inválido.");

  const lead = await leadForAuth(request.auth, request.params.leadId);
  if (!lead) throw new HttpError(404, "Lead não encontrado.");

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const call = request.body.callId
      ? await tx.call.update({
          where: { id: request.body.callId },
          data: { result, detail: request.body.notes, durationSec: request.body.durationSec, endedAt: now },
        })
      : await tx.call.create({
          data: { leadId: lead.id, sdrId: request.auth.user.id, result, detail: request.body.notes, durationSec: request.body.durationSec, endedAt: now },
        });

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        status: result,
        attempts: Math.min(3, lead.attempts + 1),
        lastContact: now,
        invalidPhone: result === "invalid",
      },
    });

    if (result === "scheduled") {
      const appointment = required(request.body.appointment, "appointment");
      await tx.appointment.upsert({
        where: { leadId: lead.id },
        create: {
          leadId: lead.id,
          date: new Date(required(appointment.date, "appointment.date")),
          period: required(appointment.period, "appointment.period"),
          seller: appointment.seller,
          notes: appointment.notes,
        },
        update: { date: new Date(appointment.date), period: appointment.period, seller: appointment.seller, notes: appointment.notes },
      });
    }
    if (result === "qualified") {
      const qualification = required(request.body.qualification, "qualification");
      await tx.qualification.upsert({
        where: { leadId: lead.id },
        create: { leadId: lead.id, type: required(qualification.type, "qualification.type"), notes: qualification.notes },
        update: { type: qualification.type, notes: qualification.notes },
      });
    }
    if (result === "callback") {
      const callback = required(request.body.callback, "callback");
      await tx.callback.upsert({
        where: { leadId: lead.id },
        create: { leadId: lead.id, assignedToId: request.auth.user.id, scheduledAt: new Date(required(callback.scheduledAt, "callback.scheduledAt")), notes: callback.notes },
        update: { assignedToId: request.auth.user.id, scheduledAt: new Date(callback.scheduledAt), notes: callback.notes, completedAt: null },
      });
    }
  });

  response.status(201).json(serializeLead(await findLead(lead.id)));
});

module.exports = router;
