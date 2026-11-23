const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { requireCsrf, requireRole } = require("../middleware/auth");
const { leadInclude } = require("../services/lead-query");
const { serializeLead } = require("../services/serializers");

const router = express.Router();
router.use(requireRole("GESTOR"));

const statuses = new Set(["PENDING", "CALLBACK", "CONTACTED", "QUALIFIED", "DIRECTED", "SCHEDULED", "NOT_QUALIFIED", "REFUSED", "ALREADY_BOUGHT", "LIMBO", "FUTURE_INTEREST", "EXHAUSTED", "INVALID_NUMBER"]);
const nullableText = (max) => z.preprocess(
  (value) => value === "" ? null : value,
  z.string().trim().max(max).nullable().optional(),
);
const auditFieldsSchema = z.object({
  auditNotes: nullableText(10_000),
  sellerOption: z.preprocess(
    (value) => value === "" ? null : value,
    z.enum(["Venda direta", "0km", "Usado", "Consórcio"]).nullable().optional(),
  ),
}).refine((data) => data.auditNotes !== undefined || data.sellerOption !== undefined);
const nonContacts = new Set(["NO_ANSWER", "VOICEMAIL", "INVALID_NUMBER"]);
const positiveOutcomes = new Set(["QUALIFIED", "DIRECTED", "SCHEDULED"]);
const outcomeMeta = {
  NO_ANSWER: { label: "Não atendeu", color: "#a9afbb" },
  VOICEMAIL: { label: "Caixa Postal", color: "#a9afbb" },
  INVALID_NUMBER: { label: "Número não existe", color: "#d96060" },
  REFUSED: { label: "Recusou", color: "#6f7786" },
  CONTACTED: { label: "Contato realizado", color: "#257e5f" },
  QUALIFIED: { label: "Qualificado", color: "#4158d5" },
  DIRECTED: { label: "Direcionado", color: "#4158d5" },
  SCHEDULED: { label: "Agendado", color: "#2e9dcc" },
  NOT_QUALIFIED: { label: "Sem interesse", color: "#8a70c9" },
  ALREADY_BOUGHT: { label: "Já comprou", color: "#6f7786" },
  LIMBO: { label: "Limbo", color: "#6f7786" },
  FUTURE_INTEREST: { label: "Interesse futuro", color: "#6f7786" },
  CALLBACK: { label: "Retornar", color: "#dd8b31" },
};

function saoPauloDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parsePeriod(query) {
  const fromKey = query.dateFrom || query.date || saoPauloDateKey();
  const toKey = query.dateTo || fromKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) {
    throw new HttpError(400, "As datas devem usar o formato AAAA-MM-DD.");
  }
  const start = new Date(`${fromKey}T00:00:00-03:00`);
  const lastDay = new Date(`${toKey}T00:00:00-03:00`);
  const end = new Date(lastDay.getTime() + 86_400_000);
  if ([start, lastDay].some((date) => Number.isNaN(date.getTime())) || end <= start) throw new HttpError(400, "Período inválido.");
  if (end.getTime() - start.getTime() > 92 * 86_400_000) throw new HttpError(400, "O período máximo do dashboard é de 92 dias.");
  return { start, end, fromKey, toKey, singleDay: fromKey === toKey };
}

function relationFilter(query) {
  return {
    ...(query.clientId && query.clientId !== "all" ? { clientId: query.clientId } : {}),
    ...(query.storeId && query.storeId !== "all" ? { storeId: query.storeId } : {}),
    ...(query.campaignId && query.campaignId !== "all" ? { campaignId: query.campaignId } : {}),
  };
}

function leadFilter(query) {
  const where = relationFilter(query);
  if (query.status && query.status !== "all") {
    const status = String(query.status).toUpperCase();
    if (!statuses.has(status)) throw new HttpError(400, "Status de lead inválido.");
    where.status = status;
  }
  if (query.sdrId && query.sdrId !== "all") where.attemptRecords = { some: { sdrId: query.sdrId } };
  if (query.search) {
    const search = String(query.search).trim().slice(0, 120);
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { action: { contains: search, mode: "insensitive" } },
      { vehicle: { contains: search, mode: "insensitive" } },
      { origin: { contains: search, mode: "insensitive" } },
    ];
  }
  return where;
}

function percent(value) {
  return Math.round(value * 10) / 10;
}

function timeKey(date, singleDay) {
  if (singleDay) {
    return `${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(date)}h`;
  }
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
}

function dateKeyInSaoPaulo(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function hourInSaoPaulo(date) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23",
  }).format(date));
}

function uniqueLeadCount(attempts) {
  return new Set(attempts.map((attempt) => attempt.leadId)).size;
}

router.get("/dashboard", async (request, response) => {
  const period = parsePeriod(request.query);
  const leadRelation = relationFilter(request.query);
  const attemptWhere = {
    createdAt: { gte: period.start, lt: period.end },
    ...(request.query.sdrId && request.query.sdrId !== "all" ? { sdrId: request.query.sdrId } : {}),
    ...(Object.keys(leadRelation).length ? { lead: leadRelation } : {}),
  };
  const pendingWhere = { ...leadRelation, status: "PENDING", invalidPhone: false };
  const callbackWhere = {
    scheduledAt: { gte: period.start, lt: period.end },
    ...(Object.keys(leadRelation).length ? { lead: leadRelation } : {}),
  };
  const baseWhere = {
    ...leadRelation,
    ...(request.query.sdrId && request.query.sdrId !== "all"
      ? { attemptRecords: { some: { sdrId: request.query.sdrId } } }
      : {}),
  };

  const [attempts, pending, callbackRecords, agents, activeSessions, reserved, baseTotal] = await Promise.all([
    prisma.attempt.findMany({
      where: attemptWhere,
      include: {
        sdr: { select: { id: true, name: true, initials: true } },
        lead: { select: { campaignId: true, campaign: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.lead.count({ where: pendingWhere }),
    prisma.callback.findMany({ where: callbackWhere, select: { scheduledAt: true, completedAt: true } }),
    prisma.user.findMany({ where: { role: "SDR", active: true }, select: { id: true, name: true, initials: true }, orderBy: { name: "asc" } }),
    prisma.authSession.findMany({
      where: { expiresAt: { gt: new Date() }, user: { role: "SDR", active: true } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.lead.count({ where: { ...leadRelation, reservedUntil: { gt: new Date() } } }),
    prisma.lead.count({ where: baseWhere }),
  ]);

  const contacts = attempts.filter((attempt) => !nonContacts.has(attempt.outcome));
  const qualified = attempts.filter((attempt) => positiveOutcomes.has(attempt.outcome));
  const workedCount = uniqueLeadCount(attempts);
  const contactCount = uniqueLeadCount(contacts);
  const qualifiedCount = uniqueLeadCount(qualified);
  const scheduledCount = uniqueLeadCount(attempts.filter((attempt) => attempt.outcome === "SCHEDULED"));
  const directedCount = uniqueLeadCount(attempts.filter((attempt) => attempt.outcome === "DIRECTED"));
  const overdueCallbacks = callbackRecords.filter((callback) => !callback.completedAt && callback.scheduledAt < new Date()).length;
  const grouped = new Map();
  attempts.forEach((attempt) => grouped.set(attempt.outcome, (grouped.get(attempt.outcome) || 0) + 1));

  const timeline = new Map();
  attempts.forEach((attempt) => {
    const key = timeKey(attempt.createdAt, period.singleDay);
    timeline.set(key, (timeline.get(key) || 0) + 1);
  });
  let activity;
  if (period.singleDay) {
    activity = Array.from({ length: 13 }, (_, index) => {
      const label = `${String(index + 8).padStart(2, "0")}h`;
      return { label, value: timeline.get(label) || 0 };
    });
  } else {
    activity = [];
    for (let cursor = period.start.getTime(); cursor < period.end.getTime(); cursor += 86_400_000) {
      const label = timeKey(new Date(cursor + 12 * 60 * 60_000), false);
      activity.push({ label, value: timeline.get(label) || 0 });
    }
  }

  const ranking = agents.map((agent) => {
    const own = attempts.filter((attempt) => attempt.sdrId === agent.id);
    const ownContacts = own.filter((attempt) => !nonContacts.has(attempt.outcome));
    const ownQualified = own.filter((attempt) => positiveOutcomes.has(attempt.outcome));
    const ownWorkedCount = uniqueLeadCount(own);
    const ownContactCount = uniqueLeadCount(ownContacts);
    const ownQualifiedCount = uniqueLeadCount(ownQualified);
    return {
      ...agent,
      attempts: own.length,
      worked: ownWorkedCount,
      contacts: ownContactCount,
      qualified: ownQualifiedCount,
      conversion: ownContactCount ? percent((ownQualifiedCount / ownContactCount) * 100) : 0,
    };
  }).sort((a, b) => b.qualified - a.qualified || b.contacts - a.contacts || b.attempts - a.attempts);

  const dailyMap = new Map();
  for (let cursor = period.start.getTime(); cursor < period.end.getTime(); cursor += 86_400_000) {
    const date = new Date(cursor + 12 * 60 * 60_000);
    const key = dateKeyInSaoPaulo(date);
    dailyMap.set(key, { key, label: timeKey(date, false), attempts: 0, worked: new Set(), contacts: new Set(), positives: new Set() });
  }
  attempts.forEach((attempt) => {
    const day = dailyMap.get(dateKeyInSaoPaulo(attempt.createdAt));
    if (!day) return;
    day.attempts += 1;
    day.worked.add(attempt.leadId);
    if (!nonContacts.has(attempt.outcome)) day.contacts.add(attempt.leadId);
    if (positiveOutcomes.has(attempt.outcome)) day.positives.add(attempt.leadId);
  });
  const cumulativeWorked = new Set();
  const daily = Array.from(dailyMap.values()).map((day) => {
    day.worked.forEach((leadId) => cumulativeWorked.add(leadId));
    const worked = day.worked.size;
    const contactsToday = day.contacts.size;
    const positivesToday = day.positives.size;
    return {
      key: day.key,
      label: day.label,
      attempts: day.attempts,
      worked,
      contacts: contactsToday,
      positives: positivesToday,
      contactRate: worked ? percent((contactsToday / worked) * 100) : 0,
      conversion: contactsToday ? percent((positivesToday / contactsToday) * 100) : 0,
      coverage: baseTotal ? percent((cumulativeWorked.size / baseTotal) * 100) : 0,
    };
  });

  const hourly = Array.from({ length: 12 }, (_, index) => {
    const hour = index + 8;
    const hourAttempts = attempts.filter((attempt) => hourInSaoPaulo(attempt.createdAt) === hour);
    const hourContacts = hourAttempts.filter((attempt) => !nonContacts.has(attempt.outcome));
    return {
      label: `${String(hour).padStart(2, "0")}h`,
      attempts: hourAttempts.length,
      contactRate: hourAttempts.length ? percent((hourContacts.length / hourAttempts.length) * 100) : 0,
    };
  });

  const attemptSequence = [1, 2, 3, 4].map((sequence) => {
    const sequenceAttempts = attempts.filter((attempt) => sequence === 4 ? attempt.sequence >= 4 : attempt.sequence === sequence);
    const sequenceContacts = sequenceAttempts.filter((attempt) => !nonContacts.has(attempt.outcome));
    return {
      sequence,
      label: sequence === 4 ? "4ª ou mais" : `${sequence}ª tentativa`,
      attempts: sequenceAttempts.length,
      contactRate: sequenceAttempts.length ? percent((sequenceContacts.length / sequenceAttempts.length) * 100) : 0,
    };
  });

  const campaignMap = new Map();
  attempts.forEach((attempt) => {
    const id = attempt.lead.campaignId;
    if (!campaignMap.has(id)) campaignMap.set(id, { id, name: attempt.lead.campaign.name, attempts: [] });
    campaignMap.get(id).attempts.push(attempt);
  });
  const campaignPerformance = Array.from(campaignMap.values()).map((campaign) => {
    const campaignContacts = campaign.attempts.filter((attempt) => !nonContacts.has(attempt.outcome));
    const campaignPositives = campaign.attempts.filter((attempt) => positiveOutcomes.has(attempt.outcome));
    const campaignWorked = uniqueLeadCount(campaign.attempts);
    const campaignContactCount = uniqueLeadCount(campaignContacts);
    const campaignPositiveCount = uniqueLeadCount(campaignPositives);
    return {
      id: campaign.id,
      name: campaign.name,
      attempts: campaign.attempts.length,
      worked: campaignWorked,
      contacts: campaignContactCount,
      positive: campaignPositiveCount,
      conversion: campaignContactCount ? percent((campaignPositiveCount / campaignContactCount) * 100) : 0,
    };
  }).sort((a, b) => b.positive - a.positive || b.contacts - a.contacts);

  response.json({
    period: { from: period.fromKey, to: period.toKey },
    kpis: {
      worked: workedCount,
      attempts: attempts.length,
      contacts: contactCount,
      qualified: qualifiedCount,
      callbacks: callbackRecords.length,
      contactRate: workedCount ? percent((contactCount / workedCount) * 100) : 0,
      conversion: contactCount ? percent((qualifiedCount / contactCount) * 100) : 0,
    },
    live: { pending, activeSdrs: activeSessions.length, reserved, callbacks: callbackRecords.filter((callback) => !callback.completedAt).length },
    activity,
    outcomes: Object.entries(outcomeMeta).map(([code, meta]) => ({ code, ...meta, value: grouped.get(code) || 0 })),
    ranking,
    analytics: {
      baseTotal,
      noAttempt: Math.max(0, baseTotal - workedCount),
      scheduled: scheduledCount,
      directed: directedCount,
      callbacks: {
        expected: callbackRecords.length,
        completed: callbackRecords.filter((callback) => callback.completedAt).length,
        overdue: overdueCallbacks,
      },
      daily,
      hourly,
      attemptSequence,
      campaigns: campaignPerformance,
    },
  });
});

router.get("/leads", async (request, response) => {
  const page = Math.max(1, Number(request.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(request.query.pageSize) || 20));
  const where = leadFilter(request.query);
  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      include: leadInclude,
      orderBy: [{ lastContact: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  response.json({
    data: leads.map((lead) => serializeLead(lead, { includeRecordings: true })),
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
  });
});

router.patch("/leads/:id/audit-fields", requireCsrf, async (request, response) => {
  const data = auditFieldsSchema.parse(request.body);
  const current = await prisma.lead.findUnique({ where: { id: request.params.id }, select: { id: true } });
  if (!current) throw new HttpError(404, "Lead não encontrado.");
  const lead = await prisma.lead.update({
    where: { id: current.id },
    data: {
      ...(data.auditNotes !== undefined ? { auditNotes: data.auditNotes } : {}),
      ...(data.sellerOption !== undefined ? { sellerOption: data.sellerOption } : {}),
    },
    include: leadInclude,
  });
  response.json(serializeLead(lead, { includeRecordings: true }));
});

module.exports = router;
