const prisma = require("../lib/prisma");

const leadInclude = {
  store: { select: { id: true, name: true, shortName: true } },
  campaign: { select: { id: true, name: true } },
  calls: { orderBy: { startedAt: "asc" } },
  attemptRecords: { orderBy: { sequence: "asc" } },
  reservedBy: { select: { id: true, name: true, initials: true } },
  callback: true,
  appointment: true,
  qualification: true,
  audit: true,
};

async function findLead(id) {
  return prisma.lead.findUnique({ where: { id }, include: leadInclude });
}

module.exports = { leadInclude, findLead };
