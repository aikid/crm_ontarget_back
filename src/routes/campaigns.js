const express = require("express");
const prisma = require("../lib/prisma");
const { campaignDashboard } = require("../services/dashboard");
const { leadInclude } = require("../services/lead-query");
const { serializeLead } = require("../services/serializers");
const { campaignForAuth } = require("../auth/access");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireRole("GESTOR", "CLIENT", "SELLER"));

router.get("/:campaignId/dashboard", async (request, response) => {
  await campaignForAuth(request.auth, request.params.campaignId);
  response.json(await campaignDashboard(request.params.campaignId, request.query.storeId, request.auth.user.role === "SELLER" ? request.auth.user.name : null));
});

function leadWhere(campaignId, query, auditedOnly = false) {
  const where = { campaignId, AND: [] };
  if (auditedOnly) where.AND.push({ audits: { some: { auditedAt: { not: null } } } });
  if (query.storeId && query.storeId !== "all") where.storeId = query.storeId;
  if (query.status && query.status !== "all") where.status = String(query.status).toUpperCase();
  if (query.category === "appointments") where.AND.push({ appointment: { isNot: null } });
  if (query.category === "qualified") {
    where.AND.push({ OR: [
      { qualification: { isNot: null } },
      { status: { in: ["QUALIFIED", "DIRECTED", "SCHEDULED"] } },
    ] });
  }
  if (query.vehicle && query.vehicle !== "all") where.vehicle = query.vehicle;
  if (query.audit && query.audit !== "all") {
    if (query.audit === "not_audited") {
      where.AND.push({ OR: [
        { audit: "not_audited" },
        { audit: null, audits: { none: {} } },
        { audits: { some: { status: "not_audited" } } },
      ] });
    } else where.AND.push({ audits: { some: { status: query.audit } } });
  }
  if (query.seller && query.seller !== "all") where.AND.push({ appointment: { is: { seller: query.seller } } });
  if (query.search) {
    where.AND.push({ OR: [
      { name: { contains: query.search } },
      { phone: { contains: query.search } },
    ] });
  }
  if (!where.AND.length) delete where.AND;
  return where;
}

router.get("/:campaignId/leads", async (request, response) => {
  await campaignForAuth(request.auth, request.params.campaignId);
  const page = Math.max(1, Number(request.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));
  const where = leadWhere(request.params.campaignId, request.query, ["CLIENT", "SELLER"].includes(request.auth.user.role));
  if (request.auth.user.role === "SELLER") {
    where.AND = [...(where.AND || []), { appointment: { is: { seller: { equals: request.auth.user.name, mode: "insensitive" } } } }];
  }
  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      include: leadInclude,
      orderBy: [{ lastContact: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  response.json({ data: leads.map(serializeLead), pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } });
});

router.get("/:campaignId/leads.csv", requireRole("GESTOR"), async (request, response) => {
  await campaignForAuth(request.auth, request.params.campaignId);
  const leads = await prisma.lead.findMany({
    where: leadWhere(request.params.campaignId, request.query),
    include: leadInclude,
    orderBy: { createdAt: "desc" },
  });
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    ["Lead", "Telefone", "Ação", "Dia da ação", "Origem", "Veículo", "Loja", "Status", "Tentativas", "Último contato"],
    ...leads.map((lead) => [lead.name, lead.phone, lead.action, lead.actionDate?.toISOString(), lead.origin, lead.vehicle, lead.store.shortName, lead.status, lead.attempts, lead.lastContact?.toISOString()]),
  ];
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${request.params.campaignId}-resultados.csv"`);
  response.send(`\uFEFF${rows.map((row) => row.map(escape).join(";")).join("\n")}`);
});

module.exports = router;
