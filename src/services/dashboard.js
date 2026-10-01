const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { serializeCampaign } = require("./serializers");

const resultColors = {
  scheduled: "#257e5f", qualified: "#4158d5", no_answer: "#a9afbb",
  callback: "#dd8b31", no_interest: "#6f7786", invalid: "#d96060",
};
const resultLabels = {
  scheduled: "Agendado", qualified: "Qualificado", no_answer: "Não atendeu",
  callback: "Retorno", no_interest: "Sem interesse", invalid: "Número inválido",
};

async function campaignDashboard(campaignId, storeId) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new HttpError(404, "Campanha não encontrada.");

  const metric = await prisma.campaignMetric.findFirst({
    where: { campaignId, storeId: storeId && storeId !== "all" ? storeId : null },
  });
  if (!metric) throw new HttpError(404, "Métricas não encontradas para esse filtro.");

  const [daily, stores, outcomes] = await Promise.all([
    prisma.dailyMetric.findMany({ where: { campaignId }, orderBy: { date: "asc" } }),
    prisma.campaignMetric.findMany({
      where: { campaignId, storeId: { not: null } },
      include: { store: { select: { id: true, name: true, shortName: true } } },
    }),
    prisma.campaignOutcomeMetric.findMany({ where: { campaignId } }),
  ]);

  const contacts = metric.contacts;
  const opportunities = metric.opportunities;
  return {
    campaign: serializeCampaign(campaign),
    metrics: {
      received: metric.received,
      worked: metric.worked,
      calls: metric.calls,
      contacts,
      appointments: metric.appointments,
      qualified: metric.qualified,
      opportunities,
      contactRate: `${metric.contactRate.toFixed(1)}%`,
      conversion: `${metric.conversion.toFixed(1)}%`,
    },
    evolution: {
      dates: daily.map((row) => row.date),
      leads: daily.map((row) => row.leads),
      contacts: daily.map((row) => row.contacts),
      appointments: daily.map((row) => row.appointments),
    },
    storePerformance: stores.map((row) => ({
      store: row.store,
      leads: row.worked,
      contacts: row.contacts,
      appointments: row.appointments,
      conversion: `${row.conversion.toFixed(1)}%`,
    })),
    callResults: outcomes.map((row) => ({
      code: row.result,
      label: resultLabels[row.result] || row.result,
      value: row.value,
      color: resultColors[row.result] || "#6f7786",
    })),
    audit: {
      registered: metric.appointments,
      audited: metric.audited,
      confirmed: metric.confirmed,
      divergences: metric.divergences,
      validationRate: metric.audited ? (metric.confirmed / metric.audited) * 100 : 0,
    },
  };
}

module.exports = { campaignDashboard };
