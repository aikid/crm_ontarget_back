const express = require("express");
const prisma = require("../lib/prisma");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireRole("GESTOR"));

router.get("/dashboard", async (request, response) => {
  const start = request.query.date ? new Date(`${request.query.date}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
  const where = { startedAt: { gte: start } };
  if (request.query.campaignId) where.lead = { campaignId: request.query.campaignId };

  const [calls, pending, agents] = await Promise.all([
    prisma.call.findMany({ where, include: { sdr: true } }),
    prisma.lead.count({ where: { status: { in: ["pending", "no_answer", "callback"] }, invalidPhone: false } }),
    prisma.user.findMany({ where: { role: "sdr", active: true }, select: { id: true, name: true, initials: true } }),
  ]);

  const completed = calls.filter((call) => call.result);
  const contacts = completed.filter((call) => !["no_answer", "invalid"].includes(call.result));
  const grouped = Object.groupBy ? Object.groupBy(completed, (call) => call.result) : completed.reduce((acc, call) => {
    (acc[call.result] ||= []).push(call); return acc;
  }, {});
  const byHour = Array.from({ length: 11 }, (_, index) => {
    const hour = index + 8;
    return { hour: `${String(hour).padStart(2, "0")}h`, value: calls.filter((call) => call.startedAt.getHours() === hour).length };
  });
  const ranking = agents.map((agent) => {
    const own = completed.filter((call) => call.sdrId === agent.id);
    const ownContacts = own.filter((call) => !["no_answer", "invalid"].includes(call.result));
    const appointments = own.filter((call) => call.result === "scheduled").length;
    return { ...agent, calls: own.length, contacts: ownContacts.length, appointments, conversion: ownContacts.length ? (appointments / ownContacts.length) * 100 : 0 };
  }).sort((a, b) => b.appointments - a.appointments);

  response.json({
    kpis: {
      worked: new Set(calls.map((call) => call.leadId)).size,
      calls: calls.length,
      contacts: contacts.length,
      scheduled: grouped.scheduled?.length || 0,
      qualified: grouped.qualified?.length || 0,
      conversion: contacts.length ? ((grouped.scheduled?.length || 0) / contacts.length) * 100 : 0,
    },
    pending,
    hourlyCalls: byHour,
    callResults: Object.entries(grouped).map(([result, rows]) => ({ result, value: rows.length })),
    ranking,
  });
});

module.exports = router;
