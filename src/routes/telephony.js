const express = require("express");
const env = require("../config/env");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { leadForAuth } = require("../auth/access");
const { requireAuth, requireCsrf, requireRole } = require("../middleware/auth");
const threeCx = require("../services/three-cx");
const callState = require("../services/telephony-state");
const asteriskRuntime = require("../services/asterisk/runtime-state");
const asteriskCallEngine = require("../services/asterisk/call-engine-instance");
const { createCallIntent } = require("../services/asterisk/call-intent");
const { publicSipSession } = require("../services/asterisk/sip-accounts");

const router = express.Router();

async function ownedCall(request, callId) {
  const call = await prisma.call.findFirst({
    where: { id: callId, sdrId: request.auth.user.id, provider: "3cx" },
  });
  if (!call) throw new HttpError(404, "Chamada não encontrada.");
  return call;
}

function publicStatus(status) {
  if (["Connected", "Hold", "Held"].includes(status)) return "connected";
  if (["Dialing", "Ringing", "Undefined"].includes(status)) return "dialing";
  return "ended";
}

async function ownedAsteriskCall(request, callId, include) {
  const call = await prisma.call.findFirst({
    where: { id: callId, sdrId: request.auth.user.id, provider: "asterisk" },
    ...(include ? { include } : {}),
  });
  if (!call) throw new HttpError(404, "Chamada não encontrada.");
  return call;
}

function publicAsteriskCall(call) {
  return {
    id: call.id,
    leadId: call.leadId,
    status: call.status.toLowerCase(),
    technicalStatus: call.status,
    destinationMasked: call.destinationMasked,
    sipExtension: env.asterisk.internalExtension,
    requestedAt: call.requestedAt,
    dialingAt: call.dialingAt,
    ringingAt: call.ringingAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSec: call.durationSec,
    disconnectReason: call.disconnectReason,
    q850Cause: call.q850Cause,
    recording: call.recording ? { status: call.recording.status, name: call.recording.name } : null,
  };
}

router.get("/asterisk/session", requireAuth, requireRole("SDR"), async (request, response) => {
  const session = publicSipSession(request.auth.user);
  if (!session) {
    throw new HttpError(503, "Ramal SIP não provisionado para este SDR ou telefonia WebRTC incompleta.");
  }
  response.setHeader("Cache-Control", "no-store, private");
  response.json(session);
});

router.post("/asterisk/calls", requireAuth, requireRole("SDR"), requireCsrf, async (request, response) => {
  const health = asteriskRuntime.snapshot();
  if (!health.enabled || !health.configured || !health.connected) {
    throw new HttpError(503, "A telefonia Asterisk está indisponível no momento.");
  }
  const leadId = required(request.body.leadId, "leadId");
  const lead = await leadForAuth(request.auth, leadId);
  if (lead.reservedById !== request.auth.user.id || !lead.reservedUntil || lead.reservedUntil <= new Date()) {
    throw new HttpError(409, "Reserve este lead na fila antes de iniciar a ligação.");
  }

  const { call, reused } = await createCallIntent(prisma, {
    leadId,
    sdrId: request.auth.user.id,
    destination: lead.phone,
    idempotencyKey: request.get("Idempotency-Key"),
  });
  const fullCall = await prisma.call.findUnique({ where: { id: call.id }, include: { recording: true } });
  response.status(reused ? 200 : 202).json({
    ...publicAsteriskCall(fullCall),
    reused,
    nextStep: `O navegador deve chamar a extensão SIP ${env.asterisk.internalExtension}.`,
  });
});

router.get("/asterisk/calls/:callId", requireAuth, requireRole("SDR"), async (request, response) => {
  const call = await ownedAsteriskCall(request, request.params.callId, { recording: true });
  response.json(publicAsteriskCall(call));
});

router.get("/asterisk/calls/:callId/events", requireAuth, requireRole("SDR"), async (request, response) => {
  await ownedAsteriskCall(request, request.params.callId);
  const events = await prisma.callEvent.findMany({
    where: { callId: request.params.callId },
    orderBy: { seq: "asc" },
    select: { seq: true, type: true, status: true, source: true, rawType: true, payload: true, occurredAt: true },
  });
  response.json({ callId: request.params.callId, events });
});

router.post("/asterisk/calls/:callId/hangup", requireAuth, requireRole("SDR"), requireCsrf, async (request, response) => {
  await ownedAsteriskCall(request, request.params.callId);
  const call = await asteriskCallEngine.hangup(request.params.callId);
  response.json(publicAsteriskCall(await prisma.call.findUnique({ where: { id: call.id }, include: { recording: true } })));
});

router.post("/calls", requireAuth, requireRole("SDR"), requireCsrf, async (request, response) => {
  threeCx.assertConfigured();
  const leadId = required(request.body.leadId, "leadId");
  const lead = await leadForAuth(request.auth, leadId);
  if (lead.reservedById !== request.auth.user.id || !lead.reservedUntil || lead.reservedUntil <= new Date()) {
    throw new HttpError(409, "Reserve este lead na fila antes de iniciar a ligação.");
  }

  const destination = threeCx.normalizePhone(lead.phone);
  const call = await prisma.call.create({ data: { leadId, sdrId: request.auth.user.id, provider: "3cx" } });
  try {
    const participant = await threeCx.makeCall(destination);
    const pbxCallId = String(participant.callid);
    await prisma.call.update({ where: { id: call.id }, data: { providerSid: pbxCallId } });
    callState.remember(call.id, {
      pbxCallId,
      participantId: participant.id,
      status: participant.status || "Dialing",
      seenParticipant: false,
      startedAt: Date.now(),
    });
    response.status(201).json({ id: call.id, to: destination, status: publicStatus(participant.status), pbxCallId });
  } catch (error) {
    await prisma.call.update({ where: { id: call.id }, data: { result: "failed", detail: error.message, endedAt: new Date() } });
    throw new HttpError(502, `Não foi possível iniciar a ligação pela 3CX: ${error.message}`);
  }
});

router.get("/calls/:callId/status", requireAuth, requireRole("SDR"), async (request, response) => {
  const call = await ownedCall(request, request.params.callId);
  if (call.endedAt) return response.json({ status: "ended", participantId: null });

  try {
    const participants = await threeCx.getParticipants();
    const participant = threeCx.participantForCall(participants, call.providerSid);
    const remembered = callState.get(call.id);
    if (participant) {
      const status = publicStatus(participant.status);
      callState.remember(call.id, {
        pbxCallId: call.providerSid,
        participantId: participant.id,
        status: participant.status,
        seenParticipant: true,
        missingSince: null,
        ...(status === "connected" && !remembered?.connectedAt ? { connectedAt: Date.now() } : {}),
      });
      return response.json({ status, participantId: participant.id });
    }

    if (callState.shouldWaitForParticipant(call.id, call.startedAt)) {
      return response.json({ status: publicStatus(remembered?.status || "Dialing"), participantId: null });
    }
    const durationSec = remembered?.connectedAt ? Math.max(0, Math.round((Date.now() - remembered.connectedAt) / 1_000)) : 0;
    await prisma.call.update({ where: { id: call.id }, data: { endedAt: new Date(), durationSec } });
    callState.forget(call.id);
    return response.json({ status: "ended", participantId: null, durationSec });
  } catch (error) {
    throw new HttpError(502, `Não foi possível consultar o estado da ligação: ${error.message}`);
  }
});

router.post("/calls/:callId/hangup", requireAuth, requireRole("SDR"), requireCsrf, async (request, response) => {
  const call = await ownedCall(request, request.params.callId);
  const remembered = callState.get(call.id);
  try {
    let participantId = remembered?.participantId;
    if (!participantId && call.providerSid) participantId = threeCx.participantForCall(await threeCx.getParticipants(), call.providerSid)?.id;
    if (participantId) await threeCx.dropParticipant(participantId);
  } catch (error) {
    if (![404, 422, 424].includes(error.status)) throw new HttpError(502, `Não foi possível encerrar a ligação: ${error.message}`);
  }
  const durationSec = remembered?.connectedAt ? Math.max(0, Math.round((Date.now() - remembered.connectedAt) / 1_000)) : (call.durationSec || 0);
  await prisma.call.updateMany({ where: { id: call.id, endedAt: null }, data: { endedAt: new Date(), durationSec } });
  callState.forget(call.id);
  response.sendStatus(204);
});

module.exports = router;
