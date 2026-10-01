const express = require("express");
const twilio = require("twilio");
const env = require("../config/env");
const prisma = require("../lib/prisma");
const { HttpError, required } = require("../lib/http-error");
const { leadForAuth } = require("../auth/access");
const { requireAuth, requireCsrf, requireRole } = require("../middleware/auth");

const router = express.Router();

function assertConfigured(requiredKeys) {
  const missing = requiredKeys.filter((key) => !env.twilio[key]);
  if (missing.length) throw new HttpError(503, "Telefonia não configurada.", { missing });
}

function normalizePhone(value) {
  const phone = String(value || "").replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new HttpError(400, "Telefone deve estar no formato E.164, por exemplo +5561999998877.");
  }
  return phone;
}

router.post("/token", requireAuth, requireRole("SDR"), requireCsrf, (request, response) => {
  assertConfigured(["accountSid", "apiKey", "apiSecret", "appSid"]);
  const identity = request.auth.user.id.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 64);
  if (!identity) throw new HttpError(400, "Identidade do SDR inválida.");
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(env.twilio.accountSid, env.twilio.apiKey, env.twilio.apiSecret, { identity });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env.twilio.appSid, incomingAllow: false }));
  response.json({ token: token.toJwt(), identity, expiresIn: 3600 });
});

router.post("/calls", requireAuth, requireRole("SDR"), requireCsrf, async (request, response) => {
  const leadId = required(request.body.leadId, "leadId");
  const lead = await leadForAuth(request.auth, leadId);
  if (!lead) throw new HttpError(404, "Lead não encontrado.");
  const call = await prisma.call.create({ data: { leadId, sdrId: request.auth.user.id } });
  response.status(201).json({ id: call.id, to: normalizePhone(lead.phone) });
});

router.post("/voice", async (request, response) => {
  assertConfigured(["accountSid", "apiKey", "apiSecret", "appSid", "phoneNumber"]);
  const callId = required(request.body.CallId, "CallId");
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { lead: true } });
  if (!call) throw new HttpError(404, "Registro de chamada não encontrado.");

  // Parâmetros enviados pelo navegador não são confiáveis. O destino sempre
  // vem do lead persistido, impedindo que o webhook seja usado como discador aberto.
  const to = normalizePhone(call.lead.phone);
  if (request.body.CallSid) {
    await prisma.call.update({ where: { id: callId }, data: { providerSid: request.body.CallSid } });
  }

  const voice = new twilio.twiml.VoiceResponse();
  const callbackBase = env.publicBaseUrl ? env.publicBaseUrl.replace(/\/$/, "") : null;
  const dial = voice.dial({
    callerId: env.twilio.phoneNumber,
    answerOnBridge: true,
    record: "record-from-answer-dual",
    ...(callbackBase && callId ? { recordingStatusCallback: `${callbackBase}/api/telephony/recordings/${callId}` } : {}),
  });
  dial.number({
    ...(callbackBase && callId ? {
      statusCallback: `${callbackBase}/api/telephony/status/${callId}`,
      statusCallbackEvent: "initiated ringing answered completed",
    } : {}),
  }, to);
  response.type("text/xml").send(voice.toString());
});

router.post("/status/:callId", async (request, response) => {
  const completed = request.body.CallStatus === "completed";
  await prisma.call.updateMany({
    where: { id: request.params.callId },
    data: {
      providerSid: request.body.ParentCallSid || request.body.CallSid,
      durationSec: request.body.CallDuration ? Number(request.body.CallDuration) : undefined,
      endedAt: completed ? new Date() : undefined,
    },
  });
  response.sendStatus(204);
});

router.post("/recordings/:callId", async (request, response) => {
  await prisma.call.updateMany({
    where: { id: request.params.callId },
    data: {
      recordingUrl: request.body.RecordingUrl,
      durationSec: request.body.RecordingDuration ? Number(request.body.RecordingDuration) : undefined,
    },
  });
  response.sendStatus(204);
});

module.exports = router;
