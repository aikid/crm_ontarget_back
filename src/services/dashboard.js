const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { serializeCampaign } = require("./serializers");

const resultColors = { scheduled: "#257e5f", qualified: "#4158d5", contacted: "#3988a8", no_answer: "#a9afbb", callback: "#dd8b31", no_interest: "#6f7786", invalid: "#d96060" };
const resultLabels = { scheduled: "Agendado", qualified: "Qualificado", contacted: "Contato realizado", no_answer: "N\u00e3o atendeu", callback: "Retorno", no_interest: "Sem interesse", invalid: "N\u00famero inv\u00e1lido" };
const contactOutcomes = new Set(["CONTACTED", "QUALIFIED", "DIRECTED", "SCHEDULED", "NOT_QUALIFIED", "REFUSED", "ALREADY_BOUGHT", "LIMBO", "FUTURE_INTEREST", "CALLBACK"]);
const qualifiedStatuses = new Set(["QUALIFIED", "DIRECTED", "SCHEDULED"]);

function resultCode(outcome) {
  if (outcome === "SCHEDULED") return "scheduled";
  if (["QUALIFIED", "DIRECTED"].includes(outcome)) return "qualified";
  if (outcome === "CONTACTED") return "contacted";
  if (["NO_ANSWER", "VOICEMAIL"].includes(outcome)) return "no_answer";
  if (outcome === "CALLBACK") return "callback";
  if (outcome === "INVALID_NUMBER") return "invalid";
  return "no_interest";
}

function percent(part, total) { return total ? (part / total) * 100 : 0; }
function dayKey(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(value); }
function auditStatus(audit) { return String(audit?.status || audit?.classification || "not_audited").trim().toLowerCase(); }

function calculateMetrics(leads, attempts) {
  const leadIds = new Set(leads.map((lead) => lead.id));
  const scopedAttempts = attempts.filter((attempt) => leadIds.has(attempt.leadId));
  const contacts = new Set(scopedAttempts.filter((attempt) => contactOutcomes.has(attempt.outcome)).map((attempt) => attempt.leadId)).size;
  const appointments = leads.filter((lead) => lead.appointment).length;
  const qualified = leads.filter((lead) => qualifiedStatuses.has(lead.status) || lead.qualification).length;
  const opportunities = leads.filter((lead) => qualifiedStatuses.has(lead.status) || lead.qualification || lead.appointment).length;
  const audits = leads.map((lead) => lead.audits[0]).filter((audit) => audit && auditStatus(audit) !== "not_audited");
  const confirmed = audits.filter((audit) => auditStatus(audit) === "confirmed").length;
  const worked = leads.filter((lead) => lead.attempts > 0).length;
  return { received: leads.length, worked, calls: scopedAttempts.length, contacts, appointments, qualified, opportunities, contactRate: percent(contacts, worked), conversion: percent(appointments, contacts), audited: audits.length, confirmed, divergences: audits.length - confirmed };
}

async function campaignDashboard(campaignId, storeId) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { store: { select: { id: true, name: true, shortName: true } } } });
  if (!campaign) throw new HttpError(404, "Campanha n\u00e3o encontrada.");

  const where = { campaignId, ...(storeId && storeId !== "all" ? { storeId } : {}) };
  const [leads, attempts] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: {
        id: true, storeId: true, status: true, attempts: true, createdAt: true,
        store: { select: { id: true, name: true, shortName: true } },
        appointment: { select: { createdAt: true } },
        qualification: { select: { id: true } },
        audits: { orderBy: [{ auditedAt: "desc" }, { createdAt: "desc" }], take: 1, select: { status: true, classification: true } },
      },
    }),
    prisma.attempt.findMany({ where: { lead: where }, select: { leadId: true, outcome: true, finishedAt: true }, orderBy: [{ leadId: "asc" }, { sequence: "asc" }] }),
  ]);

  const metrics = calculateMetrics(leads, attempts);
  const lastOutcome = new Map();
  attempts.forEach((attempt) => lastOutcome.set(attempt.leadId, attempt.outcome));
  const outcomeCounts = new Map();
  lastOutcome.forEach((outcome) => { const code = resultCode(outcome); outcomeCounts.set(code, (outcomeCounts.get(code) || 0) + 1); });

  const daily = new Map();
  const ensureDay = (date) => {
    const key = dayKey(date);
    if (!daily.has(key)) daily.set(key, { date: key, leadIds: new Set(), contactIds: new Set(), appointmentIds: new Set() });
    return daily.get(key);
  };
  attempts.forEach((attempt) => {
    const row = ensureDay(attempt.finishedAt);
    row.leadIds.add(attempt.leadId);
    if (contactOutcomes.has(attempt.outcome)) row.contactIds.add(attempt.leadId);
  });
  leads.forEach((lead) => { if (lead.appointment) ensureDay(lead.appointment.createdAt).appointmentIds.add(lead.id); });
  const evolutionRows = [...daily.values()].sort((left, right) => left.date.localeCompare(right.date));

  const stores = new Map();
  leads.forEach((lead) => stores.set(lead.storeId, lead.store));
  if (!stores.size && (!storeId || storeId === "all")) stores.set(campaign.store.id, campaign.store);

  return {
    campaign: serializeCampaign(campaign),
    metrics: { ...metrics, contactRate: `${metrics.contactRate.toFixed(1)}%`, conversion: `${metrics.conversion.toFixed(1)}%` },
    evolution: { dates: evolutionRows.map((row) => row.date), leads: evolutionRows.map((row) => row.leadIds.size), contacts: evolutionRows.map((row) => row.contactIds.size), appointments: evolutionRows.map((row) => row.appointmentIds.size) },
    storePerformance: [...stores.values()].map((store) => {
      const storeMetrics = calculateMetrics(leads.filter((lead) => lead.storeId === store.id), attempts);
      return { store, leads: storeMetrics.worked, contacts: storeMetrics.contacts, appointments: storeMetrics.appointments, conversion: `${storeMetrics.conversion.toFixed(1)}%` };
    }),
    callResults: [...outcomeCounts.entries()].map(([code, value]) => ({ code, label: resultLabels[code] || code, value, color: resultColors[code] || "#6f7786" })),
    audit: { registered: metrics.appointments, audited: metrics.audited, confirmed: metrics.confirmed, divergences: metrics.divergences, validationRate: percent(metrics.confirmed, metrics.audited) },
  };
}

module.exports = { campaignDashboard };
