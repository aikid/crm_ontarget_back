const express = require("express");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { requireRole } = require("../middleware/auth");
const { leadInclude } = require("../services/lead-query");
const { serializeLead } = require("../services/serializers");

const router = express.Router();
router.use(requireRole("GESTOR"));

const statuses = new Set(["PENDING", "CALLBACK", "CONTACTED", "QUALIFIED", "NOT_QUALIFIED", "REFUSED", "EXHAUSTED", "INVALID_NUMBER"]);
const nonContacts = new Set(["NO_ANSWER", "INVALID_NUMBER"]);
const outcomeMeta = {
  NO_ANSWER: { label: "Não atendeu", color: "#a9afbb" },
  INVALID_NUMBER: { label: "Número inválido", color: "#d96060" },
  REFUSED: { label: "Recusou", color: "#6f7786" },
  CONTACTED: { label: "Contato realizado", color: "#257e5f" },
  QUALIFIED: { label: "Qualificado", color: "#4158d5" },
  NOT_QUALIFIED: { label: "Não qualificado", color: "#8a70c9" },
  CALLBACK: { label: "Retorno solicitado", color: "#dd8b31" },
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
    completedAt: null,
    scheduledAt: { gte: period.start, lt: period.end },
    ...(Object.keys(leadRelation).length ? { lead: leadRelation } : {}),
  };

  const [attempts, pending, callbacks, agents, activeSessions, reserved] = await Promise.all([
    prisma.attempt.findMany({
      where: attemptWhere,
      include: { sdr: { select: { id: true, name: true, initials: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.lead.count({ where: pendingWhere }),
    prisma.callback.count({ where: callbackWhere }),
    prisma.user.findMany({ where: { role: "SDR", active: true }, select: { id: true, name: true, initials: true }, orderBy: { name: "asc" } }),
    prisma.authSession.findMany({
      where: { expiresAt: { gt: new Date() }, user: { role: "SDR", active: true } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.lead.count({ where: { ...leadRelation, reservedUntil: { gt: new Date() } } }),
  ]);

  const contacts = attempts.filter((attempt) => !nonContacts.has(attempt.outcome));
  const qualified = attempts.filter((attempt) => attempt.outcome === "QUALIFIED");
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
    const ownQualified = own.filter((attempt) => attempt.outcome === "QUALIFIED");
    return {
      ...agent,
      attempts: own.length,
      contacts: ownContacts.length,
      qualified: ownQualified.length,
      conversion: ownContacts.length ? percent((ownQualified.length / ownContacts.length) * 100) : 0,
    };
  }).sort((a, b) => b.qualified - a.qualified || b.contacts - a.contacts || b.attempts - a.attempts);

  response.json({
    period: { from: period.fromKey, to: period.toKey },
    kpis: {
      worked: new Set(attempts.map((attempt) => attempt.leadId)).size,
      attempts: attempts.length,
      contacts: contacts.length,
      qualified: qualified.length,
      callbacks,
      contactRate: attempts.length ? percent((contacts.length / attempts.length) * 100) : 0,
      conversion: contacts.length ? percent((qualified.length / contacts.length) * 100) : 0,
    },
    live: { pending, activeSdrs: activeSessions.length, reserved, callbacks },
    activity,
    outcomes: Object.entries(outcomeMeta).map(([code, meta]) => ({ code, ...meta, value: grouped.get(code) || 0 })),
    ranking,
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
    data: leads.map(serializeLead),
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
  });
});

module.exports = router;
