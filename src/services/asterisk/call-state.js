const { Prisma } = require("@prisma/client");
const { assertTransition, isTerminalStatus } = require("./call-domain");

function statusTimestamps(status, now) {
  if (status === "DIALING") return { dialingAt: now };
  if (status === "RINGING") return { ringingAt: now };
  if (status === "CONNECTED") return { answeredAt: now };
  if (isTerminalStatus(status)) return { endedAt: now };
  return {};
}

async function transitionCall(database, callId, status, options = {}) {
  const now = options.occurredAt || new Date();
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw(Prisma.sql`
      SELECT * FROM "Call" WHERE "id" = ${callId} FOR UPDATE
    `);
    const call = rows[0];
    if (!call) return null;
    if (call.status === status) return tx.call.findUnique({ where: { id: callId } });
    if (isTerminalStatus(call.status)) return tx.call.findUnique({ where: { id: callId } });
    assertTransition(call.status, status);

    const last = await tx.callEvent.findFirst({
      where: { callId }, orderBy: { seq: "desc" }, select: { seq: true },
    });
    const data = {
      status,
      ...statusTimestamps(status, now),
      ...(options.data || {}),
    };
    if (status === "DIALING" && call.dialingAt) delete data.dialingAt;
    if (status === "RINGING" && call.ringingAt) delete data.ringingAt;
    if (status === "CONNECTED" && call.answeredAt) delete data.answeredAt;
    if (isTerminalStatus(status) && call.answeredAt) {
      data.durationSec = Math.max(0, Math.round((now.getTime() - new Date(call.answeredAt).getTime()) / 1_000));
    }
    await tx.call.update({ where: { id: callId }, data });
    await tx.callEvent.create({
      data: {
        callId,
        seq: (last?.seq || 0) + 1,
        type: "call.status",
        status,
        source: options.source || "ENGINE",
        rawType: options.rawType || null,
        payload: options.reason ? { reason: options.reason } : null,
        occurredAt: now,
      },
    });
    return tx.call.findUnique({ where: { id: callId } });
  });
}

module.exports = { statusTimestamps, transitionCall };
