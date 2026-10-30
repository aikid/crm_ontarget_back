const test = require("node:test");
const assert = require("node:assert/strict");
const { createCallIntent, validateIdempotencyKey } = require("../src/services/asterisk/call-intent");

function fakePrisma() {
  const calls = [];
  const call = {
    async findFirst({ where }) {
      return calls.find((item) => {
        if (where.sdrId !== undefined && item.sdrId !== where.sdrId) return false;
        if (where.idempotencyKey !== undefined && item.idempotencyKey !== where.idempotencyKey) return false;
        if (where.provider !== undefined && item.provider !== where.provider) return false;
        if (where.endedAt === null && item.endedAt !== null) return false;
        if (where.status?.in && !where.status.in.includes(item.status)) return false;
        return true;
      }) || null;
    },
    async create({ data }) {
      const item = {
        id: `call-${calls.length + 1}`,
        endedAt: null,
        ...data,
        events: data.events?.create ? [{ ...data.events.create }] : [],
      };
      calls.push(item);
      return item;
    },
  };
  return { calls, call, async $transaction(callback) { return callback({ call }); } };
}

test("exige chave idempotente válida", () => {
  assert.equal(validateIdempotencyKey("req-12345678"), "req-12345678");
  assert.throws(() => validateIdempotencyKey("curta"), /8 a 128/);
});

test("cria intenção READY sem aceitar destino arbitrário no contrato público", async () => {
  const prisma = fakePrisma();
  const result = await createCallIntent(prisma, {
    leadId: "lead-1",
    sdrId: "sdr-1",
    destination: "(11) 94734-1276",
    idempotencyKey: "req-12345678",
  });

  assert.equal(result.reused, false);
  assert.equal(result.call.provider, "asterisk");
  assert.equal(result.call.status, "READY");
  assert.equal(result.call.destinationE164, "5511947341276");
  assert.equal(result.call.destinationMasked, "55*******1276");
  assert.equal(result.call.events[0].seq, 1);
  assert.equal(result.call.events[0].status, "READY");
});

test("reutiliza a mesma intenção e rejeita outra chamada ativa", async () => {
  const prisma = fakePrisma();
  const input = {
    leadId: "lead-1",
    sdrId: "sdr-1",
    destination: "11947341276",
    idempotencyKey: "req-12345678",
  };
  const first = await createCallIntent(prisma, input);
  const repeated = await createCallIntent(prisma, input);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.call.id, first.call.id);

  await assert.rejects(
    createCallIntent(prisma, { ...input, leadId: "lead-2", idempotencyKey: "req-87654321" }),
    /Já existe uma chamada ativa/,
  );
});

test("rejeita reaproveitamento da chave com outro lead", async () => {
  const prisma = fakePrisma();
  await createCallIntent(prisma, {
    leadId: "lead-1",
    sdrId: "sdr-1",
    destination: "11947341276",
    idempotencyKey: "req-12345678",
  });
  await assert.rejects(
    createCallIntent(prisma, {
      leadId: "lead-2",
      sdrId: "sdr-1",
      destination: "11947341276",
      idempotencyKey: "req-12345678",
    }),
    /reutilizada para outra chamada/,
  );
});
