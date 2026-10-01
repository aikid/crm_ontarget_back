const express = require("express");
const prisma = require("../lib/prisma");
const { assertClientAccess } = require("../auth/access");
const { publicUser } = require("../auth/user");
const { serializeCampaign } = require("../services/serializers");

const router = express.Router();

// Alias mantido para não quebrar o cliente existente durante a migração.
router.get("/session", (request, response) => {
  response.json({
    user: publicUser(request.auth.user),
    csrfToken: request.auth.session.csrfToken,
  });
});

router.get("/clients/:clientId/campaigns", async (request, response) => {
  assertClientAccess(request.auth, request.params.clientId);
  const campaigns = await prisma.campaign.findMany({
    where: {
      clientId: request.params.clientId,
      ...(request.auth.user.role === "CLIENT" ? { status: { not: "INACTIVE" }, store: { active: true } } : {}),
    },
    orderBy: { startDate: "desc" },
  });
  response.json({ data: campaigns.map(serializeCampaign) });
});

router.get("/clients/:clientId/stores", async (request, response) => {
  assertClientAccess(request.auth, request.params.clientId);
  const stores = await prisma.store.findMany({
    where: {
      clientId: request.params.clientId,
      ...(request.auth.user.role === "CLIENT" ? { active: true } : {}),
    },
    orderBy: { name: "asc" },
  });
  response.json({ data: stores });
});

module.exports = router;
