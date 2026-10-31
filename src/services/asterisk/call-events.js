const { Prisma } = require("@prisma/client");

async function appendCallEvent(prisma, event) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "Call"
      WHERE "id" = ${event.callId}
      FOR UPDATE
    `);
    if (!locked.length) return null;

    if (event.dedupeKey) {
      const duplicate = await tx.callEvent.findFirst({
        where: { callId: event.callId, dedupeKey: event.dedupeKey },
      });
      if (duplicate) return duplicate;
    }

    const last = await tx.callEvent.findFirst({
      where: { callId: event.callId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    return tx.callEvent.create({
      data: {
        callId: event.callId,
        seq: (last?.seq || 0) + 1,
        dedupeKey: event.dedupeKey || null,
        type: event.type,
        status: event.status || null,
        source: event.source,
        rawType: event.rawType || null,
        payload: event.payload || null,
        occurredAt: event.occurredAt || new Date(),
      },
    });
  });
}

module.exports = { appendCallEvent };
