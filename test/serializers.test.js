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
    campaign: { id: "campaign", name: "Campanha" }, calls: [], attemptRecords: [{
      id: "attempt", sequence: 1, outcome: "CONTACTED", notes: "Cliente atendido",
      finishedAt: new Date("2026-08-09T21:04:00Z"),
      sdr: { id: "sdr", name: "Ana Souza", initials: "AS" },
    }], callback: null,
    reservedById: null, reservedBy: null,
    appointment: { date: new Date("2026-08-11T15:00:00Z"), period: "Tarde", seller: null, notes: null },
    qualification: null, audit: "confirmed", auditSummary: "Resumo produzido pela IA", auditNotes: "Nota manual", sellerOption: "0km",
    audits: [{ status: "confirmed", confidence: "ALTA", summary: "Resumo produzido pela IA", evidence: "Confirmado", observations: null, auditedAt: new Date("2026-08-09T21:09:00Z") }],
  });
  assert.equal(result.phone, "(61) 99999-8877");
  assert.equal(result.phoneE164, "+5561999998877");
  assert.equal(result.status, "Contato realizado");
  assert.equal(result.audit.status, "Confirmado");
  assert.equal(result.auditSummary, "Resumo produzido pela IA");
  assert.equal(result.auditNotes, "Nota manual");
  assert.equal(result.audit.confidence, "ALTA");
  assert.equal(result.sellerOption, "0km");
  assert.equal(result.appointment.period, "Tarde");
  assert.deepEqual(result.history[0].sdr, { id: "sdr", name: "Ana Souza", initials: "AS" });
  assert.deepEqual(result.recordings, []);
});

test("serializeLead só expõe gravações locais válidas quando solicitado pelo gestor", () => {
  const base = {
    id: "lead", clientId: "client", campaignId: "campaign", storeId: "store", name: "João Pereira",
    phone: "+5561999998877", vehicle: null, origin: "Site", reason: null, status: "PENDING", attempts: 0,
    lastContact: null, createdAt: new Date("2026-11-01T12:00:00Z"), store: { id: "store", shortName: "SIA" },
    campaign: { id: "campaign", name: "Campanha" }, attemptRecords: [], callback: null, appointment: null,
    qualification: null, audit: null, auditSummary: null, auditNotes: null, sellerOption: null, audits: [], reservedById: null, reservedBy: null,
    calls: [{
      id: "call-1", durationSec: 42,
      recording: {
        status: "STORED_LOCAL", createdAt: new Date("2026-11-01T12:02:00Z"),
        verifiedAt: new Date("2026-11-01T12:03:00Z"), retentionDeleteAfter: new Date(Date.now() + 86_400_000),
      },
    }],
  };
  assert.equal(serializeLead(base).recordingAvailable, false);
  assert.deepEqual(serializeLead(base).recordings, []);
  const managerView = serializeLead(base, { includeRecordings: true });
  assert.equal(managerView.recordingAvailable, true);
  assert.equal(managerView.recordings[0].callId, "call-1");
  assert.equal("localPath" in managerView.recordings[0], false);
});
