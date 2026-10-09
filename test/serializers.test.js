const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeCampaign, serializeLead } = require("../src/services/serializers");

test("serializeCampaign entrega o formato consumido pelo portal", () => {
  const result = serializeCampaign({
    id: "campaign", clientId: "client", storeId: "store", name: "Campanha", status: "ACTIVE",
    startDate: new Date("2026-08-01T12:00:00Z"), endDate: new Date("2026-08-15T12:00:00Z"),
    receivedLeads: 100, workedLeads: 80,
  });
  assert.deepEqual(result, {
    id: "campaign", clientId: "client", storeId: "store", name: "Campanha", status: "active",
    startDate: "01/08/2026", endDate: "15/08/2026", receivedLeads: 100, workedLeads: 80,
  });
});

test("serializeLead mantém labels e campos esperados pelo frontend", () => {
  const result = serializeLead({
    id: "lead", clientId: "client", campaignId: "campaign", storeId: "store",
    name: "João Pereira", phone: "+5561999998877", vehicle: "T-Cross", origin: "Meta Ads",
    reason: null, status: "CONTACTED", attempts: 1, lastContact: new Date("2026-08-09T21:04:00Z"),
    createdAt: new Date("2026-08-09T12:00:00Z"), store: { id: "store", shortName: "SIA" },
    campaign: { id: "campaign", name: "Campanha" }, calls: [], attemptRecords: [], callback: null,
    reservedById: null, reservedBy: null,
    appointment: { date: new Date("2026-08-11T15:00:00Z"), period: "Tarde", seller: null, notes: null },
    qualification: null, audit: { status: "confirmed", confidence: 96, evidence: "Confirmado", auditedAt: new Date("2026-08-09T21:09:00Z") },
  });
  assert.equal(result.phone, "(61) 99999-8877");
  assert.equal(result.phoneE164, "+5561999998877");
  assert.equal(result.status, "Contato realizado");
  assert.equal(result.audit.status, "Confirmado");
  assert.equal(result.appointment.period, "Tarde");
});
