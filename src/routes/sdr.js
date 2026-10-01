const express = require("express");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { leadInclude } = require("../services/lead-query");
const { serializeLead } = require("../services/serializers");
const { campaignForAuth } = require("../auth/access");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireRole("GESTOR", "SDR"));

router.get("/queue/next", async (request, response) => {
  const campaignId = required(request.query.campaignId, "campaignId");
  await campaignForAuth(request.auth, campaignId);
  const now = new Date();
  const lead = await prisma.lead.findFirst({
    where: {
      campaignId,
      invalidPhone: false,
      attempts: { lt: 3 },
      OR: [
        { status: "pending" },
        { status: "no_answer" },
        { status: "callback", callback: { scheduledAt: { lte: now }, completedAt: null } },
      ],
    },
    include: leadInclude,
    orderBy: [{ callback: { scheduledAt: "asc" } }, { createdAt: "asc" }],
  });
  if (!lead) throw new HttpError(404, "Não há leads disponíveis na fila.");
  response.json(serializeLead(lead));
});

router.get("/:sdrId/summary", async (request, response) => {
  if (request.auth.user.role === "SDR" && request.auth.user.id !== request.params.sdrId) {
    throw new HttpError(403, "O SDR só pode consultar o próprio resumo.");
  }
  const start = request.query.date ? new Date(`${request.query.date}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
  const calls = await prisma.call.findMany({ where: { sdrId: request.params.sdrId, startedAt: { gte: start } } });
  response.json({
    worked: calls.length,
    contacts: calls.filter((call) => !["no_answer", "invalid", null].includes(call.result)).length,
    scheduled: calls.filter((call) => call.result === "scheduled").length,
    callbacks: calls.filter((call) => call.result === "callback").length,
  });
});

module.exports = router;
