const express = require("express");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { leadForAuth } = require("../auth/access");
const { requireAuth, requireCsrf, requireRole } = require("../middleware/auth");
const threeCx = require("../services/three-cx");
const callState = require("../services/telephony-state");

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
      seenParticipant: true,
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
        ...(status === "connected" && !remembered?.connectedAt ? { connectedAt: Date.now() } : {}),
      });
      return response.json({ status, participantId: participant.id });
    }

    const gracePeriod = Date.now() - call.startedAt.getTime() < 5_000;
    if (!remembered?.seenParticipant && gracePeriod) return response.json({ status: "dialing", participantId: null });
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
