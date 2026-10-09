const { PrismaClient } = require("@prisma/client");
const { hashPassword } = require("../src/auth/password");

const prisma = new PrismaClient();
const at = (iso) => new Date(iso);
const leadStatus = {
  pending: "PENDING",
  scheduled: "CONTACTED",
  qualified: "QUALIFIED",
  callback: "CALLBACK",
  no_answer: "EXHAUSTED",
  no_interest: "REFUSED",
  invalid: "INVALID_NUMBER",
};
const attemptOutcome = {
  scheduled: "CONTACTED",
  qualified: "QUALIFIED",
  callback: "CALLBACK",
  no_answer: "NO_ANSWER",
  no_interest: "REFUSED",
  invalid: "INVALID_NUMBER",
};

const clients = [
  { id: "BRASAL", name: "Grupo Brasal" },
  { id: "SAGA", name: "Grupo Saga" },
  { id: "REVEMAR", name: "Revemar" },
];

const stores = [
  { id: "BRASAL-SIA", clientId: "BRASAL", name: "Brasal Volkswagen SIA", shortName: "Brasal SIA" },
  { id: "BRASAL-ASA-NORTE", clientId: "BRASAL", name: "Brasal Asa Norte", shortName: "Brasal Asa Norte" },
  { id: "BRASAL-TAGUATINGA", clientId: "BRASAL", name: "Brasal Taguatinga", shortName: "Brasal Taguatinga" },
  { id: "SAGA-VW", clientId: "SAGA", name: "Saga Volkswagen", shortName: "Saga Volkswagen" },
];

const campaigns = [
  { id: "FEIRAO-VW-AGO", clientId: "BRASAL", storeId: "BRASAL-SIA", name: "Feirão Volkswagen Agosto", status: "ACTIVE", startDate: at("2026-08-01T03:00:00Z"), endDate: at("2026-08-15T03:00:00Z"), receivedLeads: 1500, workedLeads: 1214 },
  { id: "TCROSS-2026", clientId: "BRASAL", storeId: "BRASAL-SIA", name: "Campanha T-Cross 2026", status: "COMPLETED", startDate: at("2026-07-01T03:00:00Z"), endDate: at("2026-07-20T03:00:00Z"), receivedLeads: 980, workedLeads: 980 },
  { id: "SAGA-SEMINOVOS", clientId: "SAGA", storeId: "SAGA-VW", name: "Semana do Seminovo", status: "ACTIVE", startDate: at("2026-08-03T03:00:00Z"), endDate: at("2026-08-17T03:00:00Z"), receivedLeads: 840, workedLeads: 622 },
];

const metrics = [
  { campaignId: "FEIRAO-VW-AGO", storeId: null, received: 1500, worked: 1214, calls: 1842, contacts: 531, appointments: 142, qualified: 83, opportunities: 225, contactRate: 43.7, conversion: 27.8, audited: 137, confirmed: 132, divergences: 5 },
  { campaignId: "FEIRAO-VW-AGO", storeId: "BRASAL-SIA", received: 510, worked: 420, calls: 638, contacts: 181, appointments: 51, qualified: 31, opportunities: 82, contactRate: 43.1, conversion: 28.2, audited: 49, confirmed: 47, divergences: 2 },
  { campaignId: "FEIRAO-VW-AGO", storeId: "BRASAL-ASA-NORTE", received: 470, worked: 380, calls: 582, contacts: 169, appointments: 47, qualified: 27, opportunities: 74, contactRate: 44.5, conversion: 27.8, audited: 46, confirmed: 45, divergences: 1 },
  { campaignId: "FEIRAO-VW-AGO", storeId: "BRASAL-TAGUATINGA", received: 520, worked: 414, calls: 622, contacts: 181, appointments: 44, qualified: 25, opportunities: 69, contactRate: 43.7, conversion: 24.3, audited: 42, confirmed: 40, divergences: 2 },
  { campaignId: "TCROSS-2026", storeId: null, received: 980, worked: 980, calls: 1368, contacts: 424, appointments: 119, qualified: 68, opportunities: 187, contactRate: 43.3, conversion: 28.1, audited: 116, confirmed: 112, divergences: 4 },
];

const outcomes = [
  ["scheduled", 142], ["qualified", 83], ["no_answer", 502],
  ["callback", 126], ["no_interest", 313], ["invalid", 48],
];

const leadSeeds = [
  { id: "lead-001", name: "João Pereira", phone: "+5561999998877", vehicle: "T-Cross Comfortline", origin: "Meta Ads", storeId: "BRASAL-SIA", status: "scheduled", attempts: 3, lastContact: "2026-08-09T21:04:00Z", appointment: { date: "2026-08-11T15:00:00Z", period: "Tarde", seller: "Carlos Mendes" }, audit: { status: "confirmed", confidence: 96, evidence: "Cliente confirmou interesse no veículo e concordou com visita à Brasal SIA no período da tarde.", auditedAt: "2026-08-09T21:09:00Z" }, calls: [["2026-08-09T13:14:00Z", "no_answer", "Não atendeu"], ["2026-08-09T18:32:00Z", "callback", "Cliente pediu retorno às 18h"], ["2026-08-09T21:04:00Z", "scheduled", "Cliente atendido", "https://api.twilio.com/recordings/demo-001"]] },
  { id: "lead-002", name: "Fernanda Costa", phone: "+5561988885512", vehicle: "Nivus Highline", origin: "Lead Site Volkswagen", storeId: "BRASAL-ASA-NORTE", status: "scheduled", attempts: 2, lastContact: "2026-08-09T19:20:00Z", appointment: { date: "2026-08-11T09:00:00Z", period: "Manhã", seller: "Ricardo Santos" }, audit: { status: "confirmed", confidence: 94, evidence: "Data, loja e período foram confirmados durante a ligação.", auditedAt: "2026-08-09T19:26:00Z" }, calls: [["2026-08-09T14:22:00Z", "callback", "Cliente indisponível"], ["2026-08-09T19:20:00Z", "scheduled", "Visita combinada para o período da manhã", "https://api.twilio.com/recordings/demo-002"]] },
  { id: "lead-003", name: "Marcos Oliveira", phone: "+5561966664821", vehicle: "Polo Highline", origin: "Google Search", storeId: "BRASAL-TAGUATINGA", status: "scheduled", attempts: 1, lastContact: "2026-08-09T18:48:00Z", appointment: { date: "2026-08-12T15:00:00Z", period: "Tarde" }, audit: { status: "review", confidence: 78, evidence: "A loja foi confirmada; o vendedor ainda não foi definido.", auditedAt: "2026-08-09T18:55:00Z" }, calls: [["2026-08-09T18:48:00Z", "scheduled", "Cliente confirmou interesse", "https://api.twilio.com/recordings/demo-003"]] },
  { id: "lead-004", name: "Juliana Alves", phone: "+5561955557744", vehicle: "Taos Comfortline", origin: "Meta Ads", storeId: "BRASAL-SIA", status: "scheduled", attempts: 2, lastContact: "2026-08-09T20:06:00Z", appointment: { date: "2026-08-12T09:00:00Z", period: "Manhã", seller: "Carlos Mendes" }, audit: { status: "confirmed", confidence: 97, evidence: "Cliente concordou com data, período e loja para a visita.", auditedAt: "2026-08-09T20:11:00Z" }, calls: [["2026-08-09T17:18:00Z", "no_answer", "Sem resposta"], ["2026-08-09T20:06:00Z", "scheduled", "Visita confirmada"]] },
  { id: "lead-005", name: "Pedro Martins", phone: "+5561944443322", vehicle: "T-Cross Comfortline", origin: "Meta Ads", storeId: "BRASAL-SIA", status: "qualified", attempts: 1, lastContact: "2026-08-09T17:37:00Z", qualification: { type: "Solicitou proposta", notes: "Cliente pediu condições comerciais." }, audit: { status: "confirmed", confidence: 95, evidence: "Solicitação explícita de proposta registrada na chamada.", auditedAt: "2026-08-09T17:43:00Z" }, calls: [["2026-08-09T17:37:00Z", "qualified", "Cliente pediu condições comerciais", "https://api.twilio.com/recordings/demo-005"]] },
  { id: "lead-006", name: "Amanda Rocha", phone: "+5561933332288", vehicle: "Nivus Highline", origin: "Landing Page", storeId: "BRASAL-ASA-NORTE", status: "qualified", attempts: 2, lastContact: "2026-08-09T18:12:00Z", qualification: { type: "Interesse confirmado" }, audit: { status: "confirmed", confidence: 93, evidence: "Interesse e veículo foram confirmados pelo cliente.", auditedAt: "2026-08-09T18:18:00Z" }, calls: [["2026-08-09T15:03:00Z", "no_answer", "Não atendeu"], ["2026-08-09T18:12:00Z", "qualified", "Interesse no veículo confirmado", "https://api.twilio.com/recordings/demo-006"]] },
  { id: "lead-007", name: "André Souza", phone: "+5561977771212", vehicle: "Taos Comfortline", origin: "Lead Site Volkswagen", storeId: "BRASAL-SIA", status: "no_answer", attempts: 3, lastContact: "2026-08-09T17:31:00Z", audit: { status: "not_audited" }, calls: [["2026-08-08T14:04:00Z", "no_answer", "Sem resposta"], ["2026-08-08T19:44:00Z", "no_answer", "Sem resposta"], ["2026-08-09T17:31:00Z", "no_answer", "Sem resposta"]] },
  { id: "lead-008", name: "Carolina Nunes", phone: "+5561922229090", vehicle: "Virtus Highline", origin: "Meta Ads", storeId: "BRASAL-TAGUATINGA", status: "callback", attempts: 2, lastContact: "2026-08-09T16:54:00Z", callback: { scheduledAt: "2026-08-09T22:00:00Z", notes: "Cliente pediu retorno às 19h." }, audit: { status: "not_audited" }, calls: [["2026-08-09T13:02:00Z", "no_answer", "Não atendeu"], ["2026-08-09T16:54:00Z", "callback", "Cliente pediu retorno às 19h"]] },
  { id: "lead-009", name: "Rafael Martins", phone: "+5561977773049", vehicle: "T-Cross Highline", origin: "Google Search", storeId: "BRASAL-SIA", status: "pending", attempts: 0, lastContact: null, audit: { status: "not_audited" }, calls: [] },
];

async function main() {
  const passwordHash = await hashPassword(process.env.SEED_PASSWORD || "OnTarget@123");
  await prisma.$transaction([
    prisma.audit.deleteMany(), prisma.appointment.deleteMany(), prisma.qualification.deleteMany(),
    prisma.callback.deleteMany(), prisma.attempt.deleteMany(), prisma.call.deleteMany(), prisma.importError.deleteMany(), prisma.importBatch.deleteMany(), prisma.lead.deleteMany(),
    prisma.campaignOutcomeMetric.deleteMany(), prisma.dailyMetric.deleteMany(), prisma.campaignMetric.deleteMany(),
    prisma.authSession.deleteMany(), prisma.user.deleteMany(), prisma.campaign.deleteMany(), prisma.store.deleteMany(), prisma.client.deleteMany(),
  ]);

  for (const client of clients) await prisma.client.create({ data: client });
  for (const store of stores) await prisma.store.create({ data: store });
  for (const campaign of campaigns) await prisma.campaign.create({ data: campaign });

  await prisma.user.createMany({ data: [
    { id: "user-gestor-carlos", name: "Carlos Mendes", email: "carlos@ontarget.com.br", initials: "CM", passwordHash, role: "GESTOR" },
    { id: "user-portal-ricardo", clientId: "BRASAL", name: "Ricardo Almeida", email: "ricardo@brasaldemo.com.br", initials: "RA", passwordHash, role: "CLIENT" },
    { id: "user-sdr-ana", name: "Ana Souza", email: "ana@ontarget.com.br", initials: "AS", passwordHash, role: "SDR" },
    { id: "user-sdr-lucas", name: "Lucas Silva", email: "lucas@ontarget.com.br", initials: "LS", passwordHash, role: "SDR" },
    { id: "user-sdr-mariana", name: "Mariana Alves", email: "mariana@ontarget.com.br", initials: "MA", passwordHash, role: "SDR" },
    { id: "user-sdr-pedro", name: "Pedro Lima", email: "pedro@ontarget.com.br", initials: "PL", passwordHash, role: "SDR" },
  ] });
  await prisma.campaignMetric.createMany({ data: metrics });
  await prisma.campaignOutcomeMetric.createMany({ data: outcomes.map(([result, value]) => ({ campaignId: "FEIRAO-VW-AGO", result, value })) });

  const daily = { leads: [96, 112, 127, 139, 145, 151, 162, 170, 112], contacts: [41, 48, 52, 57, 61, 65, 69, 72, 66], appointments: [8, 12, 11, 17, 14, 21, 18, 24, 17] };
  await prisma.dailyMetric.createMany({ data: daily.leads.map((leads, index) => ({ campaignId: "FEIRAO-VW-AGO", date: at(`2026-08-${String(index + 1).padStart(2, "0")}T03:00:00Z`), leads, contacts: daily.contacts[index], appointments: daily.appointments[index] })) });

  for (const seed of leadSeeds) {
    const { calls, appointment, qualification, callback, audit, ...lead } = seed;
    await prisma.lead.create({
      data: {
        ...lead,
        status: leadStatus[lead.status],
        clientId: "BRASAL",
        campaignId: "FEIRAO-VW-AGO",
        storeId: "BRASAL-SIA",
        reason: "Campanha Feirão Agosto",
        lastContact: lead.lastContact ? at(lead.lastContact) : null,
        createdAt: at("2026-08-09T12:00:00Z"),
        calls: { create: calls.map(([startedAt, result, detail, recordingUrl]) => ({ sdrId: "user-sdr-ana", startedAt: at(startedAt), endedAt: at(startedAt), result, detail, recordingUrl, durationSec: recordingUrl ? 98 : 0 })) },
        attemptRecords: { create: calls.map(([startedAt, result, detail], index) => ({ sdrId: "user-sdr-ana", sequence: index + 1, outcome: attemptOutcome[result], notes: detail, startedAt: at(startedAt), finishedAt: at(startedAt), createdAt: at(startedAt) })) },
        ...(appointment ? { appointment: { create: { ...appointment, date: at(appointment.date) } } } : {}),
        ...(qualification ? { qualification: { create: qualification } } : {}),
        ...(callback ? { callback: { create: { ...callback, scheduledAt: at(callback.scheduledAt), assignedToId: "user-sdr-ana" } } } : {}),
        audit: { create: { ...audit, ...(audit.auditedAt ? { auditedAt: at(audit.auditedAt) } : {}) } },
      },
    });
  }
  console.log("Banco de desenvolvimento populado com sucesso.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
