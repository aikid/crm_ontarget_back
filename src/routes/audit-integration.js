const express = require("express");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { requireAuditIntegration } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuditIntegration);

function boundedText(value, field, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  required(value, field);
  if (typeof value !== "string") throw new HttpError(400, `${field} deve ser um texto.`);
  const text = value.trim();
  if (!text) throw new HttpError(400, `O campo '${field}' é obrigatório.`);
  if (text.length > max) throw new HttpError(400, `${field} deve ter no máximo ${max} caracteres.`);
  return text;
}

function confidence(value) {
  const normalized = boundedText(value, "confidence", 10).toLocaleUpperCase("pt-BR");
  const aliases = { ALTA: "ALTA", MÉDIA: "MÉDIA", MEDIA: "MÉDIA", BAIXA: "BAIXA" };
  if (!aliases[normalized]) throw new HttpError(400, "confidence deve ser ALTA, MÉDIA ou BAIXA.");
  return aliases[normalized];
}

function sellerOption(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = boundedText(value, "sellerOption", 40);
  if (!["Venda direta", "0km", "Usado", "Consórcio"].includes(parsed)) {
    throw new HttpError(400, "sellerOption deve ser Venda direta, 0km, Usado ou Consórcio.");
  }
  return parsed;
}

function serializeAudit(audit, lead) {
  return {
    id: audit.id,
    recordingId: audit.recordingId,
    leadId: audit.leadId,
    callId: audit.callId,
    attemptId: audit.attemptId,
    classification: audit.classification,
    summary: audit.summary,
    sellerOption: lead.sellerOption,
    confidence: audit.confidence,
    evidence: audit.evidence,
    modelVersion: audit.modelVersion,
    auditedAt: audit.auditedAt,
  };
}

function serializeRecording(recording) {
  const { call } = recording;
  return {
    recordingId: recording.id,
    callId: call.id,
    attemptId: call.attemptId,
    format: recording.format,
    availableAt: recording.verifiedAt || recording.createdAt,
    expiresAt: recording.retentionDeleteAfter,
    durationSec: call.durationSec,
    downloadPath: `/api/telephony/asterisk/calls/${call.id}/recording`,
    lead: call.lead,
    attempt: call.attempt ? {
      id: call.attempt.id,
      sequence: call.attempt.sequence,
      outcome: call.attempt.outcome,
      notes: call.attempt.notes,
      startedAt: call.attempt.startedAt,
      finishedAt: call.attempt.finishedAt,
    } : null,
  };
}

router.get("/recordings", async (request, response) => {
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
  const cursor = request.query.cursor ? String(request.query.cursor) : null;
  const now = new Date();
  const recordings = await prisma.callRecording.findMany({
    where: {
      status: "STORED_LOCAL",
      deletedAt: null,
      audit: { is: null },
      OR: [{ retentionDeleteAfter: null }, { retentionDeleteAfter: { gt: now } }],
    },
    include: {
      call: {
        include: {
          lead: { select: { id: true, clientId: true, campaignId: true, storeId: true, name: true } },
          attempt: true,
        },
      },
    },
    orderBy: [{ verifiedAt: "asc" }, { id: "asc" }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  const hasMore = recordings.length > limit;
  const page = recordings.slice(0, limit);
  response.json({
    data: page.map(serializeRecording),
    pagination: { limit, nextCursor: hasMore ? page.at(-1).id : null },
  });
});

router.get("/recordings/:recordingId/audit", async (request, response) => {
  const recording = await prisma.callRecording.findUnique({
    where: { id: request.params.recordingId },
    include: {
      audit: true,
      call: { include: { lead: { select: { sellerOption: true } } } },
    },
  });
  if (!recording) throw new HttpError(404, "Gravação não encontrada.");
  if (!recording.audit) throw new HttpError(404, "Auditoria ainda não registrada para esta gravação.");
  response.json(serializeAudit(recording.audit, recording.call.lead));
});

router.put("/recordings/:recordingId/audit", async (request, response) => {
  const classification = boundedText(request.body.classification, "classification", 80);
  const auditConfidence = confidence(request.body.confidence);
  const evidence = boundedText(request.body.evidence, "evidence", 10_000, { optional: true });
  const summary = boundedText(request.body.summary ?? request.body.observations, "summary", 10_000);
  const requestedSellerOption = sellerOption(request.body.sellerOption);
  const modelVersion = boundedText(request.body.modelVersion, "modelVersion", 120);
  const recording = await prisma.callRecording.findUnique({
    where: { id: request.params.recordingId },
    include: { call: true, audit: true },
  });
  if (!recording) throw new HttpError(404, "Gravação não encontrada.");
  if (recording.status === "DELETED" || recording.deletedAt || (recording.retentionDeleteAfter && recording.retentionDeleteAfter <= new Date())) {
    throw new HttpError(410, "A gravação expirou e não pode mais ser auditada.");
  }
  if (recording.status !== "STORED_LOCAL") throw new HttpError(409, "A gravação ainda não está disponível para auditoria.");

  const auditedAt = new Date();
  const values = {
    leadId: recording.call.leadId,
    callId: recording.call.id,
    attemptId: recording.call.attemptId,
    status: classification,
    classification,
    confidence: auditConfidence,
    summary,
    evidence,
    modelVersion,
    auditedAt,
  };
  const audit = await prisma.$transaction(async (transaction) => {
    const saved = await transaction.audit.upsert({
      where: { recordingId: recording.id },
      create: { recordingId: recording.id, ...values },
      update: values,
    });
    await transaction.lead.update({
      where: { id: recording.call.leadId },
      data: {
        audit: classification,
        auditSummary: summary,
        ...(requestedSellerOption !== undefined ? { sellerOption: requestedSellerOption } : {}),
      },
    });
    return saved;
  });
  const lead = await prisma.lead.findUnique({ where: { id: recording.call.leadId }, select: { sellerOption: true } });
  response.status(recording.audit ? 200 : 201).json(serializeAudit(audit, lead));
});

module.exports = router;
