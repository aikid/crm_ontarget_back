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

async function login(email) {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "OnTarget@123" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { body, cookie: response.headers.get("set-cookie").split(";")[0] };
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
  const { body, cookie } = await login("carlos@ontarget.com.br");

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
