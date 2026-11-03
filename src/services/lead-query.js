const prisma = require("../lib/prisma");

const leadInclude = {
  store: { select: { id: true, name: true, shortName: true } },
  campaign: { select: { id: true, name: true } },
  calls: { orderBy: { startedAt: "asc" }, include: { recording: true } },
  attemptRecords: {
    orderBy: { sequence: "asc" },
    include: { sdr: { select: { id: true, name: true, initials: true } } },
  },
  reservedBy: { select: { id: true, name: true, initials: true } },
  callback: true,
  appointment: true,
  qualification: true,
  audits: { orderBy: [{ auditedAt: "desc" }, { createdAt: "desc" }], take: 1 },
};

async function findLead(id) {
  return prisma.lead.findUnique({ where: { id }, include: leadInclude });
}

module.exports = { leadInclude, findLead };
