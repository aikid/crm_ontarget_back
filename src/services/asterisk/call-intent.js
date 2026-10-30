const { HttpError } = require("../../lib/http-error");
const { maskDestination, normalizeBrazilianDestination } = require("./call-domain");

const ACTIVE_CALL_STATUSES = ["READY", "DIALING", "RINGING", "CONNECTED", "RECONCILING"];

function validateIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (key.length < 8 || key.length > 128) {
    throw new HttpError(400, "Envie Idempotency-Key com 8 a 128 caracteres.");
  }
  return key;
}

function sameIntent(call, leadId, destinationE164) {
  return call.leadId === leadId && call.destinationE164 === destinationE164;
}

async function findByIdempotency(prisma, sdrId, idempotencyKey) {
  return prisma.call.findFirst({ where: { sdrId, idempotencyKey } });
}

async function createCallIntent(prisma, { leadId, sdrId, destination, idempotencyKey, now = new Date() }) {
  const key = validateIdempotencyKey(idempotencyKey);
  const destinationE164 = normalizeBrazilianDestination(destination);
  const destinationMasked = maskDestination(destinationE164);

  const existing = await findByIdempotency(prisma, sdrId, key);
  if (existing) {
    if (!sameIntent(existing, leadId, destinationE164)) {
      throw new HttpError(409, "Idempotency-Key reutilizada para outra chamada.");
    }
    return { call: existing, reused: true };
  }

  try {
    const call = await prisma.$transaction(async (tx) => {
      const active = await tx.call.findFirst({
        where: {
          provider: "asterisk",
          sdrId,
          endedAt: null,
          status: { in: ACTIVE_CALL_STATUSES },
        },
      });
      if (active) throw new HttpError(409, "Já existe uma chamada ativa para este SDR.");

      return tx.call.create({
        data: {
          leadId,
          sdrId,
          provider: "asterisk",
          idempotencyKey: key,
          status: "READY",
          destinationE164,
          destinationMasked,
          requestedAt: now,
          events: {
            create: {
              seq: 1,
              type: "call.status",
              status: "READY",
              source: "CRM",
              occurredAt: now,
              payload: { reason: "call_intent_created" },
            },
          },
        },
      });
    });
    return { call, reused: false };
  } catch (error) {
    // As constraints do banco resolvem a corrida entre requisições concorrentes.
    if (error?.code === "P2002") {
      const concurrent = await findByIdempotency(prisma, sdrId, key);
      if (concurrent && sameIntent(concurrent, leadId, destinationE164)) {
        return { call: concurrent, reused: true };
      }
      throw new HttpError(409, "Já existe uma chamada ativa ou uma chave idempotente conflitante.");
    }
    throw error;
  }
}

module.exports = {
  ACTIVE_CALL_STATUSES,
  createCallIntent,
  validateIdempotencyKey,
};
