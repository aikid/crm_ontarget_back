const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");

function isClientUser(auth) {
  return auth.user.role === "CLIENT";
}

function assertClientAccess(auth, clientId) {
  if (isClientUser(auth) && auth.user.clientId !== clientId) {
    throw new HttpError(403, "Acesso negado aos dados de outro cliente.");
  }
}

async function campaignForAuth(auth, campaignId) {
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(isClientUser(auth) ? {
        clientId: auth.user.clientId,
        status: { not: "INACTIVE" },
        store: { active: true },
      } : {}),
    },
  });
  if (!campaign) throw new HttpError(404, "Campanha não encontrada.");
  return campaign;
}

async function leadForAuth(auth, leadId, include) {
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      ...(isClientUser(auth) ? { clientId: auth.user.clientId } : {}),
    },
    ...(include ? { include } : {}),
  });
  if (!lead) throw new HttpError(404, "Lead não encontrado.");
  return lead;
}

module.exports = { assertClientAccess, campaignForAuth, isClientUser, leadForAuth };
