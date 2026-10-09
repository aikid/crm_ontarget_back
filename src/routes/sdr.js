const express = require("express");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { findLead, leadInclude } = require("../services/lead-query");
const { serializeCampaign, serializeLead } = require("../services/serializers");
const { campaignForAuth } = require("../auth/access");
const { requireCsrf, requireRole } = require("../middleware/auth");
const {
  claimCallback,
  claimNextLead,
  releaseReservation,
  renewReservation,
} = require("../services/sdr-queue");

const router = express.Router();
router.use(requireRole("SDR"));

router.get("/campaigns", async (_request, response) => {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "ACTIVE", client: { active: true }, store: { active: true } },
    include: {
      client: { select: { id: true, name: true } },
      store: { select: { id: true, name: true, shortName: true } },
    },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
  });
  response.json({
    data: campaigns.map((campaign) => ({
      ...serializeCampaign(campaign),
      client: campaign.client,
      store: campaign.store,
    })),
  });
});

async function assertActiveCampaign(auth, campaignId) {
  await campaignForAuth(auth, campaignId);
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, status: "ACTIVE", store: { active: true }, client: { active: true } },
  });
  if (!campaign) throw new HttpError(409, "A campanha, a loja ou o cliente não está ativo para operação.");
}

function saoPauloDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayBounds(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new HttpError(400, "A data deve usar o formato AAAA-MM-DD.");
  const start = new Date(`${dateKey}T00:00:00-03:00`);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, "Data inválida.");
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

router.post("/queue/claim", requireCsrf, async (request, response) => {
  const campaignId = required(request.body.campaignId, "campaignId");
  await assertActiveCampaign(request.auth, campaignId);
  const reserved = await claimNextLead(prisma, request.auth.user.id, campaignId);
  response.json(serializeLead(await findLead(reserved.id)));
});

router.post("/queue/renew", requireCsrf, async (request, response) => {
  const leadId = required(request.body.leadId, "leadId");
  await renewReservation(prisma, request.auth.user.id, leadId);
  response.json(serializeLead(await findLead(leadId)));
});

router.post("/queue/release", requireCsrf, async (request, response) => {
  const leadId = required(request.body.leadId, "leadId");
  await releaseReservation(prisma, request.auth.user.id, leadId);
  response.status(204).end();
});

router.get("/callbacks/today", async (request, response) => {
  const campaignId = request.query.campaignId || undefined;
  if (campaignId) await campaignForAuth(request.auth, campaignId);
  const { start, end } = dayBounds(request.query.date || saoPauloDateKey());
  const callbacks = await prisma.callback.findMany({
    where: {
      assignedToId: request.auth.user.id,
      completedAt: null,
      scheduledAt: { gte: start, lt: end },
      ...(campaignId ? { lead: { campaignId } } : {}),
    },
    include: { lead: { include: leadInclude } },
    orderBy: { scheduledAt: "asc" },
  });
  response.json({
    data: callbacks.map((callback) => ({
      id: callback.id,
      scheduledAt: callback.scheduledAt,
      notes: callback.notes,
      due: callback.scheduledAt <= new Date(),
      lead: serializeLead(callback.lead),
    })),
  });
});

router.post("/callbacks/:leadId/claim", requireCsrf, async (request, response) => {
  const reserved = await claimCallback(prisma, request.auth.user.id, request.params.leadId);
  response.json(serializeLead(await findLead(reserved.id)));
});

router.get("/:sdrId/summary", async (request, response) => {
  if (request.auth.user.id !== request.params.sdrId) {
    throw new HttpError(403, "O SDR só pode consultar o próprio resumo.");
  }
  const { start } = dayBounds(request.query.date || saoPauloDateKey());
  const attempts = await prisma.attempt.findMany({
    where: { sdrId: request.params.sdrId, createdAt: { gte: start } },
    select: { outcome: true },
  });
  response.json({
    worked: attempts.length,
    contacts: attempts.filter((attempt) => !["NO_ANSWER", "INVALID_NUMBER"].includes(attempt.outcome)).length,
    qualified: attempts.filter((attempt) => attempt.outcome === "QUALIFIED").length,
    callbacks: attempts.filter((attempt) => attempt.outcome === "CALLBACK").length,
  });
});

module.exports = router;
