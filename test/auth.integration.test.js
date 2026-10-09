const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await prisma.authSession.deleteMany();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
}

const loginCache = new Map();

async function login(email, fresh = false) {
  if (!fresh && loginCache.has(email)) return loginCache.get(email);
  const response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "OnTarget@123" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const session = { body, cookie: response.headers.get("set-cookie").split(";")[0] };
  loginCache.set(email, session);
  return session;
}

test("rejeita credenciais inválidas e não expõe o hash da senha", async () => {
  const invalid = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "ana@ontarget.com.br", password: "senha-incorreta" }),
  });
  assert.equal(invalid.status, 401);

  const { body, cookie } = await login("ana@ontarget.com.br");
  assert.equal(body.user.role, "SDR");
  assert.equal("passwordHash" in body.user, false);
  assert.match(cookie, /^ontarget\.sid=/);
  assert.ok(body.csrfToken);
});

test("exige sessão para acessar a API protegida", async () => {
  const response = await request("/api/session");
  assert.equal(response.status, 401);
});

test("isola o usuário do portal no cliente vinculado", async () => {
  const { body, cookie } = await login("ricardo@brasaldemo.com.br");

  const ownCampaigns = await request("/api/clients/BRASAL/campaigns", {
    headers: { Cookie: cookie },
  });
  assert.equal(ownCampaigns.status, 200);

  const otherClient = await request("/api/clients/SAGA/campaigns", {
    headers: { Cookie: cookie },
  });
  assert.equal(otherClient.status, 403);

  const writeAttempt = await request("/api/leads/lead-001/outcomes", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": body.csrfToken },
    body: JSON.stringify({ result: "no_answer" }),
  });
  assert.equal(writeAttempt.status, 403);

  const adminAttempt = await request("/api/admin/clients", {
    headers: { Cookie: cookie },
  });
  assert.equal(adminAttempt.status, 403);
});

test("aplica papel e identidade do SDR no servidor", async () => {
  const { cookie } = await login("ana@ontarget.com.br");

  const managerDashboard = await request("/api/operations/dashboard", {
    headers: { Cookie: cookie },
  });
  assert.equal(managerDashboard.status, 403);

  const anotherSdr = await request("/api/sdr/user-sdr-lucas/summary", {
    headers: { Cookie: cookie },
  });
  assert.equal(anotherSdr.status, 403);

  const ownSummary = await request("/api/sdr/user-sdr-ana/summary", {
    headers: { Cookie: cookie },
  });
  assert.equal(ownSummary.status, 200);
});

test("protege mutações com CSRF e invalida a sessão no logout", async () => {
  const { body, cookie } = await login("carlos@ontarget.com.br", true);

  const withoutCsrf = await request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(withoutCsrf.status, 403);

  const logout = await request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": body.csrfToken },
  });
  assert.equal(logout.status, 204);

  const afterLogout = await request("/api/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(afterLogout.status, 401);
  loginCache.delete("carlos@ontarget.com.br");
});

test("gestor mantém a hierarquia cliente, loja, campanha e usuário", async () => {
  const { body, cookie } = await login("carlos@ontarget.com.br");
  const suffix = Date.now().toString(36);
  let clientId;
  let storeId;
  let campaignId;
  let userId;
  const mutationHeaders = { Cookie: cookie, "X-CSRF-Token": body.csrfToken };

  try {
    const clientResponse = await request("/api/admin/clients", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ name: `Cliente teste ${suffix}` }),
    });
    assert.equal(clientResponse.status, 201);
    clientId = (await clientResponse.json()).id;

    const storeResponse = await request("/api/admin/stores", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ clientId, name: `Loja teste ${suffix}`, shortName: "Loja teste" }),
    });
    assert.equal(storeResponse.status, 201);
    storeId = (await storeResponse.json()).id;

    const invalidCampaign = await request("/api/admin/campaigns", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        clientId,
        storeId: "BRASAL-SIA",
        name: "Campanha inválida",
        startDate: "2026-10-01",
        endDate: "2026-10-10",
      }),
    });
    assert.equal(invalidCampaign.status, 400);

    const campaignResponse = await request("/api/admin/campaigns", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        clientId,
        storeId,
        name: `Campanha teste ${suffix}`,
        startDate: "2026-10-01",
        endDate: "2026-10-10",
      }),
    });
    assert.equal(campaignResponse.status, 201);
    campaignId = (await campaignResponse.json()).id;

    const userResponse = await request("/api/admin/users", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        clientId,
        name: "Usuário Portal Teste",
        email: `portal-${suffix}@example.com`,
        role: "CLIENT",
        password: "SenhaTeste@123",
      }),
    });
    assert.equal(userResponse.status, 201);
    const createdUser = await userResponse.json();
    userId = createdUser.id;
    assert.equal(createdUser.clientId, clientId);
    assert.equal("passwordHash" in createdUser, false);

    const selfLockout = await request(`/api/admin/users/${body.user.id}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ active: false }),
    });
    assert.equal(selfLockout.status, 409);

    const deactivate = await request(`/api/admin/clients/${clientId}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ active: false }),
    });
    assert.equal(deactivate.status, 200);

    const blockedChild = await request("/api/admin/stores", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ clientId, name: "Loja bloqueada", shortName: "Bloqueada" }),
    });
    assert.equal(blockedChild.status, 400);
  } finally {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (campaignId) await prisma.campaign.delete({ where: { id: campaignId } });
    if (storeId) await prisma.store.delete({ where: { id: storeId } });
    if (clientId) await prisma.client.delete({ where: { id: clientId } });
  }
});

test("banco rejeita lead fora da hierarquia da campanha", async () => {
  await assert.rejects(
    prisma.lead.create({
      data: {
        clientId: "BRASAL",
        campaignId: "FEIRAO-VW-AGO",
        storeId: "BRASAL-TAGUATINGA",
        name: "Lead inconsistente",
        phone: "+5561999990000",
        vehicle: "Teste",
        origin: "Teste",
      },
    }),
    (error) => error.code === "P2003",
  );
});

test("importa linhas válidas e relata inválidas ou duplicadas", async () => {
  const { body, cookie } = await login("carlos@ontarget.com.br");
  const form = new FormData();
  form.set("clientId", "BRASAL");
  form.set("storeId", "BRASAL-SIA");
  form.set("campaignId", "FEIRAO-VW-AGO");
  form.set("file", new Blob([[
    "nome;telefone;veículo;origem;motivo",
    "Lead Importado;(61) 99999-7770;Nivus;Site;Teste",
    "Telefone Ruim;123;Polo;Meta;Teste",
    "Lead Existente;+5561999998877;T-Cross;Site;Duplicado no banco",
    "Lead Duplicado;+5561999997770;Nivus;Site;Duplicado no arquivo",
  ].join("\n")], { type: "text/csv" }), "leads.csv");

  let batchId;
  try {
    const response = await request("/api/admin/imports", {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": body.csrfToken },
      body: form,
    });
    assert.equal(response.status, 201);
    const batch = await response.json();
    batchId = batch.id;
    assert.equal(batch.totalRows, 4);
    assert.equal(batch.importedRows, 1);
    assert.equal(batch.rejectedRows, 3);
    assert.equal(batch.status, "COMPLETED_WITH_ERRORS");
    assert.equal(batch.campaign.name, "Feirão Volkswagen Agosto");
    assert.deepEqual(new Set(batch.errors.map((error) => error.code)), new Set(["INVALID_ROW", "DUPLICATE_IN_FILE", "DUPLICATE_IN_CAMPAIGN"]));

    const lead = await prisma.lead.findUnique({ where: { campaignId_phone: { campaignId: "FEIRAO-VW-AGO", phone: "+5561999997770" } } });
    assert.equal(lead.importBatchId, batch.id);
    assert.equal(lead.importRow, 2);
  } finally {
    if (batchId) {
      const imported = await prisma.lead.count({ where: { importBatchId: batchId } });
      await prisma.lead.deleteMany({ where: { importBatchId: batchId } });
      await prisma.importBatch.delete({ where: { id: batchId } });
      if (imported) await prisma.campaign.update({ where: { id: "FEIRAO-VW-AGO" }, data: { receivedLeads: { decrement: imported } } });
    }
  }
});

async function createQueueFixture(leadCount = 1) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const client = await prisma.client.create({ data: { name: `Cliente fila ${suffix}` } });
  const store = await prisma.store.create({ data: { clientId: client.id, name: `Loja fila ${suffix}`, shortName: "Fila" } });
  const campaign = await prisma.campaign.create({
    data: {
      clientId: client.id,
      storeId: store.id,
      name: `Campanha fila ${suffix}`,
      status: "ACTIVE",
      startDate: new Date("2026-10-01T03:00:00Z"),
      endDate: new Date("2026-12-31T03:00:00Z"),
      receivedLeads: leadCount,
    },
  });
  const leads = [];
  for (let index = 0; index < leadCount; index += 1) {
    leads.push(await prisma.lead.create({
      data: {
        clientId: client.id,
        storeId: store.id,
        campaignId: campaign.id,
        name: `Lead fila ${index + 1}`,
        phone: `+55619990${String(Date.now() % 1000000).padStart(6, "0")}${index}`,
        vehicle: "Veículo teste",
        origin: "Teste de integração",
      },
    }));
  }
  return { client, store, campaign, leads };
}

async function cleanupQueueFixture(fixture) {
  await prisma.attempt.deleteMany({ where: { lead: { campaignId: fixture.campaign.id } } });
  await prisma.callback.deleteMany({ where: { lead: { campaignId: fixture.campaign.id } } });
  await prisma.call.deleteMany({ where: { lead: { campaignId: fixture.campaign.id } } });
  await prisma.lead.deleteMany({ where: { campaignId: fixture.campaign.id } });
  await prisma.campaign.delete({ where: { id: fixture.campaign.id } });
  await prisma.store.delete({ where: { id: fixture.store.id } });
  await prisma.client.delete({ where: { id: fixture.client.id } });
}

test("reserva um único lead sob concorrência e exige o SDR proprietário", async () => {
  const fixture = await createQueueFixture(1);
  const ana = await login("ana@ontarget.com.br");
  const lucas = await login("lucas@ontarget.com.br");
  const payload = JSON.stringify({ campaignId: fixture.campaign.id });

  try {
    const responses = await Promise.all([
      request("/api/sdr/queue/claim", { method: "POST", headers: { Cookie: ana.cookie, "X-CSRF-Token": ana.body.csrfToken }, body: payload }),
      request("/api/sdr/queue/claim", { method: "POST", headers: { Cookie: lucas.cookie, "X-CSRF-Token": lucas.body.csrfToken }, body: payload }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 404]);

    const winnerIndex = responses.findIndex((response) => response.status === 200);
    const winner = winnerIndex === 0 ? ana : lucas;
    const loser = winnerIndex === 0 ? lucas : ana;
    const claimed = await responses[winnerIndex].json();
    assert.equal(claimed.id, fixture.leads[0].id);
    assert.equal(claimed.reservation.sdr.id, winner.body.user.id);

    const idempotent = await request("/api/sdr/queue/claim", {
      method: "POST",
      headers: { Cookie: winner.cookie, "X-CSRF-Token": winner.body.csrfToken },
      body: payload,
    });
    assert.equal(idempotent.status, 200);
    assert.equal((await idempotent.json()).id, claimed.id);

    const foreignOutcome = await request(`/api/leads/${claimed.id}/outcomes`, {
      method: "POST",
      headers: { Cookie: loser.cookie, "X-CSRF-Token": loser.body.csrfToken },
      body: JSON.stringify({ outcome: "QUALIFIED" }),
    });
    assert.equal(foreignOutcome.status, 409);

    const ownOutcome = await request(`/api/leads/${claimed.id}/outcomes`, {
      method: "POST",
      headers: { Cookie: winner.cookie, "X-CSRF-Token": winner.body.csrfToken },
      body: JSON.stringify({ outcome: "NO_ANSWER", notes: "Sem resposta" }),
    });
    assert.equal(ownOutcome.status, 201);
    const updated = await ownOutcome.json();
    assert.equal(updated.attempts, 1);
    assert.equal(updated.statusCode, "PENDING");
    assert.equal(updated.reservation, null);
  } finally {
    await cleanupQueueFixture(fixture);
  }
});

test("limita três tentativas e mantém retornos fora da fila automática", async () => {
  const fixture = await createQueueFixture(2);
  const ana = await login("ana@ontarget.com.br");
  const headers = { Cookie: ana.cookie, "X-CSRF-Token": ana.body.csrfToken };
  const claimBody = JSON.stringify({ campaignId: fixture.campaign.id });

  try {
    const exhaustedLead = fixture.leads[0];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const claim = await request("/api/sdr/queue/claim", { method: "POST", headers, body: claimBody });
      assert.equal(claim.status, 200);
      const current = await claim.json();
      assert.equal(current.id, exhaustedLead.id);
      const outcome = await request(`/api/leads/${current.id}/outcomes`, {
        method: "POST", headers, body: JSON.stringify({ outcome: "NO_ANSWER" }),
      });
      assert.equal(outcome.status, 201);
      const saved = await outcome.json();
      assert.equal(saved.attempts, sequence);
      assert.equal(saved.statusCode, sequence === 3 ? "EXHAUSTED" : "PENDING");
    }

    const callbackClaim = await request("/api/sdr/queue/claim", { method: "POST", headers, body: claimBody });
    assert.equal(callbackClaim.status, 200);
    const callbackLead = await callbackClaim.json();
    assert.equal(callbackLead.id, fixture.leads[1].id);
    const callbackAt = new Date(Date.now() + 10 * 60_000);
    const callbackOutcome = await request(`/api/leads/${callbackLead.id}/outcomes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "CALLBACK", callback: { scheduledAt: callbackAt.toISOString() }, notes: "Retornar em dez minutos" }),
    });
    assert.equal(callbackOutcome.status, 201);

    const emptyAutomaticQueue = await request("/api/sdr/queue/claim", { method: "POST", headers, body: claimBody });
    assert.equal(emptyAutomaticQueue.status, 404);

    await prisma.callback.update({ where: { leadId: callbackLead.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    const callbacks = await request(`/api/sdr/callbacks/today?campaignId=${fixture.campaign.id}`, { headers: { Cookie: ana.cookie } });
    assert.equal(callbacks.status, 200);
    const callbackList = await callbacks.json();
    assert.equal(callbackList.data.length, 1);
    assert.equal(callbackList.data[0].lead.id, callbackLead.id);
    assert.equal(callbackList.data[0].due, true);

    const explicitClaim = await request(`/api/sdr/callbacks/${callbackLead.id}/claim`, { method: "POST", headers });
    assert.equal(explicitClaim.status, 200);
    const qualified = await request(`/api/leads/${callbackLead.id}/outcomes`, {
      method: "POST", headers, body: JSON.stringify({ outcome: "QUALIFIED" }),
    });
    assert.equal(qualified.status, 201);
    assert.equal((await qualified.json()).attempts, 2);
  } finally {
    await cleanupQueueFixture(fixture);
  }
});

test("dashboard e consulta de leads usam tentativas reais e respeitam filtros", async () => {
  const fixture = await createQueueFixture(2);
  const manager = await login("carlos@ontarget.com.br");
  const portal = await login("ricardo@brasaldemo.com.br");
  const registeredAt = new Date("2026-10-04T15:00:00Z");

  try {
    await prisma.attempt.createMany({ data: [
      { leadId: fixture.leads[0].id, sdrId: "user-sdr-ana", sequence: 1, outcome: "QUALIFIED", notes: "Perfil confirmado", startedAt: registeredAt, finishedAt: registeredAt, createdAt: registeredAt },
      { leadId: fixture.leads[1].id, sdrId: "user-sdr-lucas", sequence: 1, outcome: "NO_ANSWER", notes: "Sem resposta", startedAt: registeredAt, finishedAt: registeredAt, createdAt: registeredAt },
    ] });
    await prisma.lead.update({ where: { id: fixture.leads[0].id }, data: { status: "QUALIFIED", attempts: 1, lastContact: registeredAt } });
    await prisma.lead.update({ where: { id: fixture.leads[1].id }, data: { status: "PENDING", attempts: 1, lastContact: registeredAt } });

    const dashboard = await request(`/api/operations/dashboard?dateFrom=2026-10-04&dateTo=2026-10-04&campaignId=${fixture.campaign.id}`, {
      headers: { Cookie: manager.cookie },
    });
    assert.equal(dashboard.status, 200);
    const indicators = await dashboard.json();
    assert.equal(indicators.kpis.worked, 2);
    assert.equal(indicators.kpis.attempts, 2);
    assert.equal(indicators.kpis.contacts, 1);
    assert.equal(indicators.kpis.qualified, 1);
    assert.equal(indicators.kpis.conversion, 100);
    assert.equal(indicators.outcomes.find((item) => item.code === "QUALIFIED").value, 1);

    const leadSearch = await request(`/api/operations/leads?campaignId=${fixture.campaign.id}&search=Lead%20fila%201`, {
      headers: { Cookie: manager.cookie },
    });
    assert.equal(leadSearch.status, 200);
    const result = await leadSearch.json();
    assert.equal(result.pagination.total, 1);
    assert.equal(result.data[0].id, fixture.leads[0].id);
    assert.equal(result.data[0].history.length, 1);
    assert.equal(result.data[0].history[0].result, "Qualificado");

    const invalidStatus = await request(`/api/operations/leads?campaignId=${fixture.campaign.id}&status=UNKNOWN`, {
      headers: { Cookie: manager.cookie },
    });
    assert.equal(invalidStatus.status, 400);

    const portalAccess = await request("/api/operations/leads", { headers: { Cookie: portal.cookie } });
    assert.equal(portalAccess.status, 403);
  } finally {
    await cleanupQueueFixture(fixture);
  }
});
