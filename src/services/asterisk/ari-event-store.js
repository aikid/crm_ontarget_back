const crypto = require("node:crypto");
const prisma = require("../../lib/prisma");
const { appendCallEvent } = require("./call-events");

function eventIdentity(event) {
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function sanitizedPayload(event) {
  const channel = event.channel || {};
  const bridge = event.bridge || {};
  const recording = event.recording || {};
  return {
    timestamp: event.timestamp || null,
    channelId: channel.id || null,
    channelState: channel.state || null,
    bridgeId: bridge.id || null,
    recordingName: recording.name || null,
    recordingState: recording.state || null,
    cause: Number.isInteger(event.cause) ? event.cause : null,
    causeText: typeof event.cause_txt === "string" ? event.cause_txt.slice(0, 160) : null,
  };
}

async function correlatedCall(event, database = prisma) {
  const channelId = event.channel?.id;
  const bridgeId = event.bridge?.id;
  const recordingName = event.recording?.name;
  const filters = [];
  if (channelId) filters.push({ ariWebChannelId: channelId }, { ariRemoteChannelId: channelId });
  if (bridgeId) filters.push({ ariBridgeId: bridgeId });
  if (recordingName) filters.push({ recording: { is: { name: recordingName } } });
  if (!filters.length) return null;
  return database.call.findFirst({
    where: { provider: "asterisk", OR: filters },
    select: { id: true },
  });
}

async function persistCorrelatedAriEvent(event, database = prisma) {
  const call = await correlatedCall(event, database);
  if (!call) return { stored: false, reason: "uncorrelated" };
  const stored = await appendCallEvent(database, {
    callId: call.id,
    dedupeKey: eventIdentity(event),
    type: `ari.${event.type || "unknown"}`,
    source: "ARI",
    rawType: event.type || "unknown",
    payload: sanitizedPayload(event),
    occurredAt: event.timestamp ? new Date(event.timestamp) : new Date(),
  });
  return { stored: true, event: stored };
}

module.exports = {
  correlatedCall,
  eventIdentity,
  persistCorrelatedAriEvent,
  sanitizedPayload,
};
