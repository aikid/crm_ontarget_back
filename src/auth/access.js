const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");

function isClientUser(auth) {
  return ["CLIENT", "SELLER"].includes(auth.user.role);
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
      ...(auth.user.role === "SELLER" ? {
        leads: { some: { appointment: { is: { seller: { equals: auth.user.name, mode: "insensitive" } } } } },
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
      ...(auth.user.role === "SELLER" ? {
        appointment: { is: { seller: { equals: auth.user.name, mode: "insensitive" } } },
      } : {}),
    },
    ...(include ? { include } : {}),
  });
  if (!lead) throw new HttpError(404, "Lead não encontrado.");
  return lead;
}

module.exports = { assertClientAccess, campaignForAuth, isClientUser, leadForAuth };
